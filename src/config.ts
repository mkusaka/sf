import os from "node:os";
import path from "node:path";
import type { JsonObject, ServiceConfig, WorkflowDefinition } from "./types.ts";

export class ConfigError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
  }
}

export function resolveConfig(workflow: WorkflowDefinition): ServiceConfig {
  const workflowDir = path.dirname(workflow.path);
  const root = workflow.config;
  const tracker = objectAt(root, "tracker");
  const polling = objectAt(root, "polling");
  const workspace = objectAt(root, "workspace");
  const hooks = objectAt(root, "hooks");
  const agent = objectAt(root, "agent");
  const codex = objectAt(root, "codex");
  const server = objectAt(root, "server");
  const persistence = objectAt(root, "persistence");

  const trackerKind = stringAt(tracker, "kind");
  if (trackerKind !== "linear") throw new ConfigError("unsupported_tracker_kind", "tracker.kind must be linear");

  const apiKey = resolveEnvString(stringAt(tracker, "api_key") ?? process.env.LINEAR_API_KEY ?? "");
  if (!apiKey) throw new ConfigError("missing_tracker_api_key", "Linear API key is missing");

  const projectSlug = stringAt(tracker, "project_slug");
  if (!projectSlug) throw new ConfigError("missing_tracker_project_slug", "tracker.project_slug is required");

  const workspaceRoot = resolvePath(resolveEnvString(stringAt(workspace, "root") ?? path.join(os.tmpdir(), "symphony_workspaces")), workflowDir);

  return {
    workflowPath: workflow.path,
    workflowDir,
    tracker: {
      kind: "linear",
      endpoint: stringAt(tracker, "endpoint") ?? "https://api.linear.app/graphql",
      apiKey,
      projectSlug,
      requiredLabels: stringListAt(tracker, "required_labels", []),
      activeStates: stringListAt(tracker, "active_states", ["Todo", "In Progress"]),
      terminalStates: stringListAt(tracker, "terminal_states", ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"])
    },
    polling: {
      intervalMs: positiveIntAt(polling, "interval_ms", 30_000)
    },
    workspace: {
      root: workspaceRoot
    },
    hooks: {
      afterCreate: stringAt(hooks, "after_create"),
      beforeRun: stringAt(hooks, "before_run"),
      afterRun: stringAt(hooks, "after_run"),
      beforeRemove: stringAt(hooks, "before_remove"),
      timeoutMs: positiveIntAt(hooks, "timeout_ms", 60_000)
    },
    agent: {
      maxConcurrentAgents: positiveIntAt(agent, "max_concurrent_agents", 10),
      maxTurns: positiveIntAt(agent, "max_turns", 20),
      maxRetryBackoffMs: positiveIntAt(agent, "max_retry_backoff_ms", 300_000),
      maxConcurrentAgentsByState: positiveIntMapAt(agent, "max_concurrent_agents_by_state")
    },
    codex: {
      command: stringAt(codex, "command") ?? "codex app-server",
      approvalPolicy: valueAt(codex, "approval_policy"),
      threadSandbox: valueAt(codex, "thread_sandbox"),
      turnSandboxPolicy: valueAt(codex, "turn_sandbox_policy"),
      turnTimeoutMs: positiveIntAt(codex, "turn_timeout_ms", 3_600_000),
      readTimeoutMs: positiveIntAt(codex, "read_timeout_ms", 5_000),
      stallTimeoutMs: intAt(codex, "stall_timeout_ms", 300_000)
    },
    server: {
      port: optionalPortAt(server, "port")
    },
    persistence: {
      path: resolvePath(resolveEnvString(stringAt(persistence, "path") ?? ".symphony/state.sqlite"), workflowDir)
    }
  };
}

function objectAt(root: JsonObject, key: string): JsonObject {
  const value = root[key];
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function valueAt(root: JsonObject, key: string): unknown | null {
  return root[key] ?? null;
}

function stringAt(root: JsonObject, key: string): string | null {
  const value = root[key];
  return typeof value === "string" ? value : null;
}

function stringListAt(root: JsonObject, key: string, fallback: string[]): string[] {
  const value = root[key];
  if (!Array.isArray(value)) return fallback;
  return value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean);
}

function intAt(root: JsonObject, key: string, fallback: number): number {
  const value = root[key];
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function positiveIntAt(root: JsonObject, key: string, fallback: number): number {
  const value = intAt(root, key, fallback);
  if (value <= 0) throw new ConfigError("invalid_config", `${key} must be a positive integer`);
  return value;
}

function optionalPortAt(root: JsonObject, key: string): number | null {
  const value = root[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new ConfigError("invalid_config", `${key} must be a port number`);
  }
  return value;
}

function positiveIntMapAt(root: JsonObject, key: string): Map<string, number> {
  const map = new Map<string, number>();
  const value = root[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return map;
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (typeof entryValue === "number" && Number.isInteger(entryValue) && entryValue > 0) {
      map.set(normalizeState(entryKey), entryValue);
    }
  }
  return map;
}

export function normalizeState(value: string): string {
  return value.trim().toLowerCase();
}

export function resolveEnvString(value: string): string {
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    return process.env[value.slice(1)] ?? "";
  }
  return value;
}

export function resolvePath(value: string, baseDir: string): string {
  let resolved = value;
  if (resolved === "~" || resolved.startsWith("~/")) {
    resolved = path.join(os.homedir(), resolved.slice(2));
  }
  if (!path.isAbsolute(resolved)) resolved = path.resolve(baseDir, resolved);
  return path.normalize(resolved);
}
