import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/logger.ts";
import { Orchestrator, sortForDispatch } from "../src/orchestrator.ts";
import type { AgentRunner, Issue, ServiceConfig, TrackerClient } from "../src/types.ts";

describe("orchestrator", () => {
  it("sorts by priority, created_at, identifier", () => {
    expect(sortForDispatch([
      issue("B", { priority: null, createdAt: "2026-01-01T00:00:00Z" }),
      issue("C", { priority: 2, createdAt: "2026-01-02T00:00:00Z" }),
      issue("A", { priority: 2, createdAt: "2026-01-01T00:00:00Z" })
    ]).map((item) => item.identifier)).toEqual(["A", "C", "B"]);
  });

  it("dispatches eligible issues and schedules continuation retry on normal exit", async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(path.join(os.tmpdir(), "sf-orchestrator-"));
    try {
      const candidate = issue("ABC-1", { state: "In Progress" });
      const tracker: TrackerClient = {
        fetchCandidateIssues: vi.fn(async () => [candidate]),
        fetchIssuesByStates: vi.fn(async () => []),
        fetchIssueStatesByIds: vi.fn(async () => [candidate])
      };
      const runner: AgentRunner = {
        run: vi.fn(async (_issue, _attempt, onEvent) => {
          onEvent({ event: "turn_started", timestamp: new Date().toISOString(), sessionId: "t-1" });
          return { status: "succeeded" as const };
        })
      };
      const orchestrator = new Orchestrator({ config: config(root), tracker, runner, logger: createLogger("error") });
      await orchestrator.start();
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();
      expect(runner.run).toHaveBeenCalledTimes(1);
      await Promise.resolve();
      expect(orchestrator.snapshot().counts.retrying).toBe(1);
      const detail = orchestrator.issueSnapshot("ABC-1");
      expect(detail).toMatchObject({
        status: "retrying",
        retry: {
          issue_id: "ABC-1",
          issue_identifier: "ABC-1",
          attempt: 1,
          error: "continuation"
        }
      });
      expect(JSON.stringify(detail)).not.toContain("apiKey");
      expect(JSON.stringify(detail)).not.toContain("runner");
      expect(JSON.stringify(detail)).not.toContain("timer");
      orchestrator.stop();
    } finally {
      vi.useRealTimers();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function config(root: string): ServiceConfig {
  return {
    workflowPath: "/tmp/WORKFLOW.md",
    workflowDir: "/tmp",
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      apiKey: "key",
      projectSlug: "proj",
      requiredLabels: [],
      activeStates: ["Todo", "In Progress"],
      terminalStates: ["Done", "Closed", "Canceled", "Cancelled", "Duplicate"]
    },
    polling: { intervalMs: 60_000 },
    workspace: { root },
    hooks: { afterCreate: null, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 1000 },
    agent: { maxConcurrentAgents: 1, maxTurns: 1, maxRetryBackoffMs: 60_000, maxConcurrentAgentsByState: new Map() },
    codex: { command: "codex app-server", approvalPolicy: null, threadSandbox: null, turnSandboxPolicy: null, turnTimeoutMs: 1000, readTimeoutMs: 1000, stallTimeoutMs: 60_000 },
    server: { port: null },
    persistence: { path: path.join(root, "state.sqlite") }
  };
}

function issue(identifier: string, overrides: Partial<Issue> = {}): Issue {
  return {
    id: identifier,
    identifier,
    title: identifier,
    description: null,
    priority: 3,
    state: "Todo",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: null,
    ...overrides
  };
}
