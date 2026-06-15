export type JsonObject = Record<string, unknown>;

export type IssueBlocker = {
  id: string | null;
  identifier: string | null;
  state: string | null;
};

export type Issue = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branchName: string | null;
  url: string | null;
  labels: string[];
  blockedBy: IssueBlocker[];
  createdAt: string | null;
  updatedAt: string | null;
};

export type WorkflowDefinition = {
  path: string;
  config: JsonObject;
  promptTemplate: string;
};

export type TrackerConfig = {
  kind: "linear";
  endpoint: string;
  apiKey: string;
  projectSlug: string;
  requiredLabels: string[];
  activeStates: string[];
  terminalStates: string[];
};

export type HooksConfig = {
  afterCreate: string | null;
  beforeRun: string | null;
  afterRun: string | null;
  beforeRemove: string | null;
  timeoutMs: number;
};

export type AgentConfig = {
  maxConcurrentAgents: number;
  maxTurns: number;
  maxRetryBackoffMs: number;
  maxConcurrentAgentsByState: Map<string, number>;
};

export type CodexConfig = {
  command: string;
  approvalPolicy: unknown | null;
  threadSandbox: unknown | null;
  turnSandboxPolicy: unknown | null;
  turnTimeoutMs: number;
  readTimeoutMs: number;
  stallTimeoutMs: number;
};

export type ServerConfig = {
  port: number | null;
};

export type PersistenceConfig = {
  path: string;
};

export type ServiceConfig = {
  workflowPath: string;
  workflowDir: string;
  tracker: TrackerConfig;
  polling: {
    intervalMs: number;
  };
  workspace: {
    root: string;
  };
  hooks: HooksConfig;
  agent: AgentConfig;
  codex: CodexConfig;
  server: ServerConfig;
  persistence: PersistenceConfig;
};

export type Workspace = {
  path: string;
  key: string;
  createdNow: boolean;
};

export type AgentEvent = {
  event: string;
  timestamp: string;
  sessionId?: string;
  codexAppServerPid?: number;
  message?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  rateLimits?: unknown;
};

export type AgentRunResult = {
  status: "succeeded" | "failed" | "timed_out" | "stalled" | "cancelled";
  error?: string;
};

export type TrackerClient = {
  fetchCandidateIssues(): Promise<Issue[]>;
  fetchIssuesByStates(stateNames: string[]): Promise<Issue[]>;
  fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]>;
};

export type AgentRunner = {
  run(issue: Issue, attempt: number | null, onEvent: (event: AgentEvent) => void, signal: AbortSignal): Promise<AgentRunResult>;
};

export type RunningEntry = {
  issue: Issue;
  config: ServiceConfig;
  tracker: TrackerClient;
  runner: AgentRunner;
  attempt: number | null;
  startedAt: number;
  controller: AbortController;
  sessionId: string | null;
  codexAppServerPid: number | null;
  lastCodexEvent: string | null;
  lastCodexTimestamp: number | null;
  lastCodexMessage: string | null;
  codexInputTokens: number;
  codexOutputTokens: number;
  codexTotalTokens: number;
  lastReportedInputTokens: number;
  lastReportedOutputTokens: number;
  lastReportedTotalTokens: number;
  turnCount: number;
  worker: Promise<void>;
};

export type RetryEntry = {
  issueId: string;
  identifier: string;
  issueUrl: string | null;
  config: ServiceConfig;
  tracker: TrackerClient;
  runner: AgentRunner;
  attempt: number;
  dueAtMs: number;
  timer: NodeJS.Timeout | null;
  error: string | null;
};

export type StoredRetryEntry = {
  issueId: string;
  identifier: string;
  issueUrl: string | null;
  issue: Issue | null;
  attempt: number;
  dueAtMs: number;
  timer: null;
  error: string | null;
};

export type StoredSessionEntry = {
  issueId: string;
  identifier: string;
  issueUrl: string | null;
  issue: Issue | null;
  status: string;
  attempt: number | null;
  startedAt: number | null;
  lastEventAt: number | null;
  lastEvent: string | null;
  lastMessage: string | null;
  error: string | null;
};

export type RuntimeState = {
  running: Map<string, RunningEntry>;
  claimed: Set<string>;
  retryAttempts: Map<string, RetryEntry>;
  completed: Set<string>;
  codexTotals: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    secondsRunning: number;
  };
  codexRateLimits: unknown | null;
  recentEvents: Array<{ at: string; issueId?: string; issueIdentifier?: string; event: string; message?: string }>;
  lastError: string | null;
};

export type RuntimeStore = {
  load(): {
    retries: StoredRetryEntry[];
    runningSessions: StoredSessionEntry[];
    totals: RuntimeState["codexTotals"];
    rateLimits: unknown | null;
    recentEvents: RuntimeState["recentEvents"];
  };
  upsertRetry(entry: RetryEntry, issue?: Issue): void;
  deleteRetry(issueId: string): void;
  upsertSession(entry: RunningEntry, status: string, error?: string | null): void;
  markSessionStatus(issueId: string, status: string, error?: string | null): void;
  saveTotals(totals: RuntimeState["codexTotals"]): void;
  saveRateLimits(rateLimits: unknown | null): void;
  appendEvent(event: RuntimeState["recentEvents"][number]): void;
  close(): void;
};

export type DynamicToolSpec = {
  namespace?: string | null;
  name: string;
  description: string;
  inputSchema: unknown;
  deferLoading?: boolean;
};

export type DynamicToolCallParams = {
  arguments: unknown;
  callId: string;
  namespace?: string | null;
  threadId: string;
  tool: string;
  turnId: string;
};

export type DynamicToolCallResponse = {
  contentItems: Array<{ type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string }>;
  success: boolean;
};

export type DynamicToolHandler = {
  specs(): DynamicToolSpec[];
  call(params: DynamicToolCallParams): Promise<DynamicToolCallResponse>;
};
