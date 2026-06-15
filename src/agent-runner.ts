import type { AgentEvent, AgentRunResult, AgentRunner, Issue, ServiceConfig, TrackerClient } from "./types.ts";
import type { Logger } from "./logger.ts";
import { CodexAppServerClient } from "./codex-app-server.ts";
import { continuationPrompt, renderPrompt } from "./prompt.ts";
import { assertInsideRoot, createWorkspace, runHook } from "./workspace.ts";
import { normalizeState } from "./config.ts";
import { createLinearIssueTools, type LinearGraphqlExecutor } from "./linear-tool.ts";

export class LocalAgentRunner implements AgentRunner {
  private config: ServiceConfig;
  private tracker: TrackerClient;
  private workflowPrompt: () => string;
  private logger: Logger;

  constructor(input: { config: ServiceConfig; tracker: TrackerClient; workflowPrompt: () => string; logger: Logger }) {
    this.config = input.config;
    this.tracker = input.tracker;
    this.workflowPrompt = input.workflowPrompt;
    this.logger = input.logger;
  }

  async run(issue: Issue, attempt: number | null, onEvent: (event: AgentEvent) => void, signal: AbortSignal): Promise<AgentRunResult> {
    let client: CodexAppServerClient | null = null;
    let workspacePath: string | null = null;
    try {
      const workspace = await createWorkspace(this.config.workspace.root, issue.identifier, this.config.hooks, this.logger);
      workspacePath = workspace.path;
      assertInsideRoot(this.config.workspace.root, workspace.path);

      if (this.config.hooks.beforeRun) {
        await runHook("before_run", this.config.hooks.beforeRun, workspace.path, this.config.hooks.timeoutMs, this.logger);
      }

      client = new CodexAppServerClient(
        this.config.codex,
        workspace.path,
        onEvent,
        hasRawGraphql(this.tracker) ? createLinearIssueTools(this.tracker, { issue, projectSlug: this.config.tracker.projectSlug }) : null
      );
      signal.addEventListener("abort", () => client?.stop(), { once: true });
      await client.start();
      const threadId = await client.startThread(issue);
      let currentIssue = issue;

      for (let turn = 1; turn <= this.config.agent.maxTurns; turn += 1) {
        onEvent(withOptionalPid({
          event: "turn_started",
          timestamp: new Date().toISOString(),
          sessionId: `${threadId}-turn-${turn}`,
          message: `turn=${turn}`
        }, client.pid));
        const prompt = turn === 1
          ? await renderPrompt(this.workflowPrompt(), currentIssue, attempt)
          : continuationPrompt(currentIssue, turn, this.config.agent.maxTurns);
        const turnId = await client.runTurn(threadId, prompt, currentIssue);
        onEvent(withOptionalPid({
          event: "turn_completed",
          timestamp: new Date().toISOString(),
          sessionId: `${threadId}-${turnId}`,
          message: `turn=${turn}`
        }, client.pid));

        const [refreshed] = await this.tracker.fetchIssueStatesByIds([currentIssue.id]);
        if (refreshed) currentIssue = refreshed;
        const state = normalizeState(currentIssue.state);
        if (!this.config.tracker.activeStates.map(normalizeState).includes(state)) break;
      }

      return { status: "succeeded" };
    } catch (error) {
      if (signal.aborted) return { status: "cancelled", error: "cancelled" };
      const message = error instanceof Error ? error.message : String(error);
      return { status: message.includes("timeout") ? "timed_out" : "failed", error: message };
    } finally {
      try {
        if (client) client.stop();
        if (workspacePath && this.config.hooks.afterRun) {
          await runHook("after_run", this.config.hooks.afterRun, workspacePath, this.config.hooks.timeoutMs, this.logger);
        }
      } catch (error) {
        this.logger.warn("after_run hook failed", { error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
}

function withOptionalPid<T extends AgentEvent>(event: Omit<T, "codexAppServerPid">, pid: number | undefined): T {
  if (pid === undefined) return event as T;
  return { ...event, codexAppServerPid: pid } as T;
}

function hasRawGraphql(tracker: TrackerClient): tracker is TrackerClient & LinearGraphqlExecutor {
  return typeof (tracker as { rawGraphql?: unknown }).rawGraphql === "function";
}
