import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SQLiteRuntimeStore } from "../src/persistence.ts";
import { createLogger } from "../src/logger.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import type { AgentRunner, Issue, ServiceConfig, TrackerClient } from "../src/types.ts";

describe("SQLiteRuntimeStore", () => {
  it("round-trips retry entries and totals", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sf-store-"));
    const dbPath = path.join(root, "state.sqlite");
    try {
      const store = new SQLiteRuntimeStore(dbPath);
      const cfg = config(root);
      const tracker: TrackerClient = {
        fetchCandidateIssues: vi.fn(async () => []),
        fetchIssuesByStates: vi.fn(async () => []),
        fetchIssueStatesByIds: vi.fn(async () => [])
      };
      const runner: AgentRunner = { run: vi.fn(async () => ({ status: "succeeded" as const })) };
      store.upsertRetry({
        issueId: "ABC-1",
        identifier: "ABC-1",
        issueUrl: "https://linear.app/acme/issue/ABC-1",
        config: cfg,
        tracker,
        runner,
        attempt: 2,
        dueAtMs: 123,
        timer: null,
        error: "failed"
      }, issue("ABC-1"));
      store.saveTotals({ inputTokens: 1, outputTokens: 2, totalTokens: 3, secondsRunning: 4 });
      store.close();

      const restored = new SQLiteRuntimeStore(dbPath);
      expect(restored.load().retries).toMatchObject([{ issueId: "ABC-1", attempt: 2, dueAtMs: 123, error: "failed" }]);
      expect(restored.load().totals).toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 3, secondsRunning: 4 });
      restored.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets orchestrator restore persisted retries", async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(path.join(os.tmpdir(), "sf-orch-store-"));
    const cfg = config(root);
    const dbPath = cfg.persistence.path;
    try {
      const tracker: TrackerClient = {
        fetchCandidateIssues: vi.fn(async () => []),
        fetchIssuesByStates: vi.fn(async () => []),
        fetchIssueStatesByIds: vi.fn(async () => [])
      };
      const runner: AgentRunner = { run: vi.fn(async () => ({ status: "succeeded" as const })) };
      const seed = new SQLiteRuntimeStore(dbPath);
      seed.upsertRetry({
        issueId: "ABC-1",
        identifier: "ABC-1",
        issueUrl: null,
        config: cfg,
        tracker,
        runner,
        attempt: 3,
        dueAtMs: Date.now() + 60_000,
        timer: null,
        error: "seeded"
      }, issue("ABC-1"));
      seed.close();

      const store = new SQLiteRuntimeStore(dbPath);
      const orchestrator = new Orchestrator({ config: cfg, tracker, runner, logger: createLogger("error"), store });
      await orchestrator.start();
      expect(orchestrator.snapshot().retrying).toMatchObject([{ issue_identifier: "ABC-1", attempt: 3, error: "seeded" }]);
      orchestrator.stop();
    } finally {
      vi.useRealTimers();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function config(root: string): ServiceConfig {
  return {
    workflowPath: path.join(root, "WORKFLOW.md"),
    workflowDir: root,
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
    workspace: { root: path.join(root, "workspaces") },
    hooks: { afterCreate: null, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 1000 },
    agent: { maxConcurrentAgents: 1, maxTurns: 1, maxRetryBackoffMs: 60_000, maxConcurrentAgentsByState: new Map() },
    codex: { command: "codex app-server", approvalPolicy: null, threadSandbox: null, turnSandboxPolicy: null, turnTimeoutMs: 1000, readTimeoutMs: 1000, stallTimeoutMs: 60_000 },
    server: { port: null },
    persistence: { path: path.join(root, "state.sqlite") }
  };
}

function issue(identifier: string): Issue {
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
    updatedAt: null
  };
}
