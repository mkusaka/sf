import { EventEmitter } from "node:events";
import type { AgentEvent, AgentRunner, Issue, RetryEntry, RunningEntry, RuntimeState, RuntimeStore, ServiceConfig, StoredSessionEntry, TrackerClient } from "./types.ts";
import type { Logger } from "./logger.ts";
import { normalizeState } from "./config.ts";
import { removeWorkspace, workspaceKey } from "./workspace.ts";

export class Orchestrator extends EventEmitter {
  private config: ServiceConfig;
  private tracker: TrackerClient;
  private runner: AgentRunner;
  private logger: Logger;
  private store: RuntimeStore | null;
  private tickTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private ticking = false;
  readonly state: RuntimeState = {
    running: new Map(),
    claimed: new Set(),
    retryAttempts: new Map(),
    completed: new Set(),
    codexTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
    codexRateLimits: null,
    recentEvents: [],
    lastError: null
  };

  constructor(input: { config: ServiceConfig; tracker: TrackerClient; runner: AgentRunner; logger: Logger; store?: RuntimeStore | null }) {
    super();
    this.config = input.config;
    this.tracker = input.tracker;
    this.runner = input.runner;
    this.logger = input.logger;
    this.store = input.store ?? null;
  }

  async start(): Promise<void> {
    this.logger.info("orchestrator starting", { workflow: this.config.workflowPath });
    this.restorePersistedState();
    await this.startupTerminalWorkspaceCleanup();
    this.scheduleTick(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    for (const retry of this.state.retryAttempts.values()) {
      if (retry.timer) clearTimeout(retry.timer);
    }
    for (const running of this.state.running.values()) {
      running.controller.abort();
    }
    this.store?.close();
  }

  refresh(): void {
    this.scheduleTick(0);
  }

  rebind(input: { config: ServiceConfig; tracker: TrackerClient; runner: AgentRunner }): void {
    this.config = input.config;
    this.tracker = input.tracker;
    this.runner = input.runner;
    this.logger.info("runtime rebound", {
      workflow: input.config.workflowPath,
      project_slug: input.config.tracker.projectSlug,
      workspace_root: input.config.workspace.root,
      poll_interval_ms: input.config.polling.intervalMs
    });
    this.scheduleTick(0);
  }

  snapshot() {
    const now = Date.now();
    return {
      generated_at: new Date().toISOString(),
      counts: {
        running: this.state.running.size,
        retrying: this.state.retryAttempts.size
      },
      running: [...this.state.running.values()].map(publicRunningSnapshot),
      retrying: [...this.state.retryAttempts.values()].map(publicRetrySnapshot),
      codex_totals: {
        input_tokens: this.state.codexTotals.inputTokens,
        output_tokens: this.state.codexTotals.outputTokens,
        total_tokens: this.state.codexTotals.totalTokens,
        seconds_running: this.state.codexTotals.secondsRunning + this.activeSeconds(now)
      },
      rate_limits: this.state.codexRateLimits,
      last_error: this.state.lastError,
      recent_events: this.state.recentEvents.slice(-50)
    };
  }

  issueSnapshot(identifier: string) {
    for (const entry of this.state.running.values()) {
      if (entry.issue.identifier === identifier) {
        return {
          issue_identifier: identifier,
          issue_id: entry.issue.id,
          status: "running",
          workspace: { path: `${entry.config.workspace.root}/${workspaceKey(entry.issue.identifier)}` },
          attempts: { restart_count: 0, current_retry_attempt: entry.attempt },
          running: publicRunningSnapshot(entry),
          retry: null,
          recent_events: this.state.recentEvents.filter((event) => event.issueIdentifier === identifier).slice(-20),
          last_error: null,
          tracked: {}
        };
      }
    }
    for (const retry of this.state.retryAttempts.values()) {
      if (retry.identifier === identifier) {
        return {
          issue_identifier: identifier,
          issue_id: retry.issueId,
          status: "retrying",
          workspace: { path: `${retry.config.workspace.root}/${workspaceKey(identifier)}` },
          attempts: { restart_count: 0, current_retry_attempt: retry.attempt },
          running: null,
          retry: publicRetrySnapshot(retry),
          recent_events: this.state.recentEvents.filter((event) => event.issueIdentifier === identifier).slice(-20),
          last_error: retry.error,
          tracked: {}
        };
      }
    }
    return null;
  }

  private restorePersistedState(): void {
    if (!this.store) return;
    const restored = this.store.load();
    this.state.codexTotals = restored.totals;
    this.state.codexRateLimits = restored.rateLimits;
    this.state.recentEvents = restored.recentEvents.slice(-200);

    for (const retry of restored.retries) {
      const entry: RetryEntry = {
        issueId: retry.issueId,
        identifier: retry.identifier,
        issueUrl: retry.issueUrl,
        config: this.config,
        tracker: this.tracker,
        runner: this.runner,
        attempt: retry.attempt,
        dueAtMs: retry.dueAtMs,
        timer: null,
        error: retry.error
      };
      const delayMs = Math.max(retry.dueAtMs - Date.now(), 0);
      entry.timer = setTimeout(() => void this.handleRetryTimer(entry.issueId), delayMs);
      this.state.retryAttempts.set(entry.issueId, entry);
      this.state.claimed.add(entry.issueId);
    }

    for (const session of restored.runningSessions) {
      if (this.state.retryAttempts.has(session.issueId)) continue;
      const issue = storedSessionIssue(session);
      this.store.markSessionStatus(session.issueId, "retrying", "restored from interrupted run");
      this.scheduleRetry(issue, (session.attempt ?? 0) + 1, "restored from interrupted run", 0);
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      await this.reconcileRunningIssues();
      const issues = await this.tracker.fetchCandidateIssues();
      for (const issue of sortForDispatch(issues)) {
        if (this.availableSlots(issue.state) <= 0) break;
        if (this.shouldDispatch(issue)) this.dispatch(issue, null);
      }
      this.emit("changed");
    } catch (error) {
      this.state.lastError = errorMessage(error);
      this.logger.error("tick failed", { error: this.state.lastError });
    } finally {
      this.ticking = false;
      this.scheduleTick(this.config.polling.intervalMs);
    }
  }

  private scheduleTick(delayMs: number): void {
    if (this.stopped) return;
    if (delayMs === 0 && this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = setTimeout(() => void this.tick(), delayMs);
  }

  private shouldDispatch(issue: Issue): boolean {
    if (!issue.id || !issue.identifier || !issue.title || !issue.state) return false;
    const state = normalizeState(issue.state);
    if (!this.config.tracker.activeStates.map(normalizeState).includes(state)) return false;
    if (this.config.tracker.terminalStates.map(normalizeState).includes(state)) return false;
    if (this.state.running.has(issue.id) || this.state.claimed.has(issue.id)) return false;
    if (state === "todo") {
      const terminal = new Set(this.config.tracker.terminalStates.map(normalizeState));
      if (issue.blockedBy.some((blocker) => blocker.state && !terminal.has(normalizeState(blocker.state)))) return false;
    }
    return true;
  }

  private dispatch(issue: Issue, attempt: number | null, runtime?: { config: ServiceConfig; tracker: TrackerClient; runner: AgentRunner }): void {
    const effectiveConfig = runtime?.config ?? this.config;
    const effectiveTracker = runtime?.tracker ?? this.tracker;
    const effectiveRunner = runtime?.runner ?? this.runner;
    const controller = new AbortController();
    const startedAt = Date.now();
    const runningEntry = {
      issue,
      config: effectiveConfig,
      tracker: effectiveTracker,
      runner: effectiveRunner,
      attempt,
      startedAt,
      controller,
      sessionId: null,
      codexAppServerPid: null,
      lastCodexEvent: null,
      lastCodexTimestamp: null,
      lastCodexMessage: null,
      codexInputTokens: 0,
      codexOutputTokens: 0,
      codexTotalTokens: 0,
      lastReportedInputTokens: 0,
      lastReportedOutputTokens: 0,
      lastReportedTotalTokens: 0,
      turnCount: 0,
      worker: Promise.resolve()
    };
    this.state.running.set(issue.id, runningEntry);
    this.state.claimed.add(issue.id);
    this.clearRetry(issue.id);
    this.store?.upsertSession(runningEntry, "running");
    this.logger.info("dispatching issue", { issue_id: issue.id, issue_identifier: issue.identifier, attempt });
    runningEntry.worker = effectiveRunner.run(issue, attempt, (event) => this.handleAgentEvent(issue, event), controller.signal)
      .then((result) => this.handleWorkerExit(issue, startedAt, result.status === "succeeded" ? "normal" : result.error ?? result.status))
      .catch((error) => this.handleWorkerExit(issue, startedAt, errorMessage(error)));
  }

  private handleAgentEvent(issue: Issue, event: AgentEvent): void {
    const running = this.state.running.get(issue.id);
    if (!running) return;
    running.lastCodexEvent = event.event;
    running.lastCodexTimestamp = Date.parse(event.timestamp) || Date.now();
    running.lastCodexMessage = event.message ?? null;
    running.codexAppServerPid = event.codexAppServerPid ?? running.codexAppServerPid;
    running.sessionId = event.sessionId ?? running.sessionId;
    if (event.event === "turn_started") running.turnCount += 1;
    if (event.usage) {
      const input = event.usage.inputTokens ?? running.lastReportedInputTokens;
      const output = event.usage.outputTokens ?? running.lastReportedOutputTokens;
      const total = event.usage.totalTokens ?? running.lastReportedTotalTokens;
      running.codexInputTokens += Math.max(input - running.lastReportedInputTokens, 0);
      running.codexOutputTokens += Math.max(output - running.lastReportedOutputTokens, 0);
      running.codexTotalTokens += Math.max(total - running.lastReportedTotalTokens, 0);
      running.lastReportedInputTokens = input;
      running.lastReportedOutputTokens = output;
      running.lastReportedTotalTokens = total;
    }
    if (event.rateLimits) this.state.codexRateLimits = event.rateLimits;
    if (event.rateLimits) this.store?.saveRateLimits(event.rateLimits);
    this.store?.upsertSession(running, "running");
    this.pushEvent({
      at: event.timestamp,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      event: event.event,
      ...(event.message !== undefined ? { message: event.message } : {})
    });
    this.emit("changed");
  }

  private handleWorkerExit(issue: Issue, startedAt: number, reason: string): void {
    const running = this.state.running.get(issue.id);
    if (!running) return;
    this.state.running.delete(issue.id);
    this.state.codexTotals.secondsRunning += (Date.now() - startedAt) / 1000;
    this.state.codexTotals.inputTokens += running.codexInputTokens;
    this.state.codexTotals.outputTokens += running.codexOutputTokens;
    this.state.codexTotals.totalTokens += running.codexTotalTokens;
    this.store?.saveTotals(this.state.codexTotals);
    if (reason === "normal") {
      this.state.completed.add(issue.id);
      this.store?.markSessionStatus(issue.id, "completed", null);
      this.scheduleRetry(issue, 1, "continuation", 1000, running);
    } else {
      this.store?.markSessionStatus(issue.id, "retrying", reason);
      this.scheduleRetry(issue, nextAttempt(running.attempt), reason, backoffMs(nextAttempt(running.attempt), running.config.agent.maxRetryBackoffMs), running);
    }
    this.emit("changed");
  }

  private async reconcileRunningIssues(): Promise<void> {
    const now = Date.now();
    for (const [issueId, running] of this.state.running) {
      const last = running.lastCodexTimestamp ?? running.startedAt;
      if (running.config.codex.stallTimeoutMs > 0 && now - last > running.config.codex.stallTimeoutMs) {
        running.controller.abort();
        this.state.running.delete(issueId);
        this.store?.markSessionStatus(issueId, "retrying", "stalled");
        this.scheduleRetry(running.issue, nextAttempt(running.attempt), "stalled", backoffMs(nextAttempt(running.attempt), running.config.agent.maxRetryBackoffMs), running);
      }
    }

    for (const [issueId, running] of this.state.running) {
      const [issue] = await running.tracker.fetchIssueStatesByIds([issueId]);
      if (!issue) continue;
      const active = new Set(running.config.tracker.activeStates.map(normalizeState));
      const terminal = new Set(running.config.tracker.terminalStates.map(normalizeState));
      const state = normalizeState(issue.state);
      if (terminal.has(state)) {
        running.controller.abort();
        this.state.running.delete(issueId);
        this.state.claimed.delete(issueId);
        this.store?.markSessionStatus(issueId, "terminal", null);
        this.clearRetry(issueId);
        await removeWorkspace(running.config.workspace.root, issue.identifier, running.config.hooks, this.logger);
      } else if (active.has(state)) {
        running.issue = issue;
        this.store?.upsertSession(running, "running");
      } else {
        running.controller.abort();
        this.state.running.delete(issueId);
        this.state.claimed.delete(issueId);
        this.store?.markSessionStatus(issueId, "inactive", null);
        this.clearRetry(issueId);
      }
    }
  }

  private scheduleRetry(issue: Issue, attempt: number, error: string, delayMs: number, runtime?: { config: ServiceConfig; tracker: TrackerClient; runner: AgentRunner }): void {
    this.clearRetry(issue.id);
    const entry: RetryEntry = {
      issueId: issue.id,
      identifier: issue.identifier,
      issueUrl: issue.url,
      config: runtime?.config ?? this.config,
      tracker: runtime?.tracker ?? this.tracker,
      runner: runtime?.runner ?? this.runner,
      attempt,
      dueAtMs: Date.now() + delayMs,
      timer: null,
      error
    };
    entry.timer = setTimeout(() => void this.handleRetryTimer(issue.id), delayMs);
    this.state.retryAttempts.set(issue.id, entry);
    this.state.claimed.add(issue.id);
    this.store?.upsertRetry(entry, issue);
    this.pushEvent({ at: new Date().toISOString(), issueId: issue.id, issueIdentifier: issue.identifier, event: "retry_scheduled", message: error });
  }

  private async handleRetryTimer(issueId: string): Promise<void> {
    const retry = this.state.retryAttempts.get(issueId);
    if (!retry) return;
    this.state.retryAttempts.delete(issueId);
    try {
      this.store?.deleteRetry(issueId);
      const issue = (await retry.tracker.fetchCandidateIssues()).find((candidate) => candidate.id === issueId);
      if (!issue) {
        this.state.claimed.delete(issueId);
        return;
      }
      if (this.availableSlots(issue.state, retry.config) <= 0) {
        this.scheduleRetry(issue, retry.attempt + 1, "no available orchestrator slots", backoffMs(retry.attempt + 1, retry.config.agent.maxRetryBackoffMs), retry);
        return;
      }
      this.dispatch(issue, retry.attempt, retry);
    } catch (error) {
      const synthetic: Issue = { id: issueId, identifier: retry.identifier, title: retry.identifier, description: null, priority: null, state: "unknown", branchName: null, url: retry.issueUrl, labels: [], blockedBy: [], createdAt: null, updatedAt: null };
      this.scheduleRetry(synthetic, retry.attempt + 1, errorMessage(error), backoffMs(retry.attempt + 1, retry.config.agent.maxRetryBackoffMs), retry);
    }
  }

  private clearRetry(issueId: string): void {
    const retry = this.state.retryAttempts.get(issueId);
    if (retry?.timer) clearTimeout(retry.timer);
    this.state.retryAttempts.delete(issueId);
    this.store?.deleteRetry(issueId);
  }

  private availableSlots(state: string, config: ServiceConfig = this.config): number {
    const global = Math.max(config.agent.maxConcurrentAgents - this.state.running.size, 0);
    const stateLimit = config.agent.maxConcurrentAgentsByState.get(normalizeState(state));
    if (!stateLimit) return global;
    const runningInState = [...this.state.running.values()].filter((entry) => normalizeState(entry.issue.state) === normalizeState(state)).length;
    return Math.max(Math.min(global, stateLimit - runningInState), 0);
  }

  private async startupTerminalWorkspaceCleanup(): Promise<void> {
    try {
      const terminalIssues = await this.tracker.fetchIssuesByStates(this.config.tracker.terminalStates);
      for (const issue of terminalIssues) {
        await removeWorkspace(this.config.workspace.root, issue.identifier, this.config.hooks, this.logger);
      }
    } catch (error) {
      this.logger.warn("startup terminal workspace cleanup failed", { error: errorMessage(error) });
    }
  }

  private activeSeconds(now: number): number {
    return [...this.state.running.values()].reduce((sum, entry) => sum + (now - entry.startedAt) / 1000, 0);
  }

  private pushEvent(event: RuntimeState["recentEvents"][number]): void {
    this.state.recentEvents.push(event);
    this.state.recentEvents = this.state.recentEvents.slice(-200);
    this.store?.appendEvent(event);
  }
}

export function sortForDispatch(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => {
    const priorityA = a.priority ?? Number.POSITIVE_INFINITY;
    const priorityB = b.priority ?? Number.POSITIVE_INFINITY;
    if (priorityA !== priorityB) return priorityA - priorityB;
    const createdA = a.createdAt ? Date.parse(a.createdAt) : Number.POSITIVE_INFINITY;
    const createdB = b.createdAt ? Date.parse(b.createdAt) : Number.POSITIVE_INFINITY;
    if (createdA !== createdB) return createdA - createdB;
    return a.identifier.localeCompare(b.identifier);
  });
}

function nextAttempt(attempt: number | null): number {
  return (attempt ?? 0) + 1;
}

function backoffMs(attempt: number, cap: number): number {
  return Math.min(10_000 * 2 ** Math.max(attempt - 1, 0), cap);
}

function publicRunningSnapshot(entry: RunningEntry) {
  return {
    issue_id: entry.issue.id,
    issue_identifier: entry.issue.identifier,
    issue_url: entry.issue.url,
    state: entry.issue.state,
    session_id: entry.sessionId,
    turn_count: entry.turnCount,
    last_event: entry.lastCodexEvent,
    last_message: entry.lastCodexMessage,
    started_at: new Date(entry.startedAt).toISOString(),
    last_event_at: entry.lastCodexTimestamp ? new Date(entry.lastCodexTimestamp).toISOString() : null,
    tokens: {
      input_tokens: entry.codexInputTokens,
      output_tokens: entry.codexOutputTokens,
      total_tokens: entry.codexTotalTokens
    }
  };
}

function publicRetrySnapshot(entry: RetryEntry) {
  return {
    issue_id: entry.issueId,
    issue_identifier: entry.identifier,
    issue_url: entry.issueUrl,
    attempt: entry.attempt,
    due_at: new Date(entry.dueAtMs).toISOString(),
    error: entry.error
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function storedSessionIssue(session: StoredSessionEntry): Issue {
  return session.issue ?? {
    id: session.issueId,
    identifier: session.identifier,
    title: session.identifier,
    description: null,
    priority: null,
    state: "unknown",
    branchName: null,
    url: session.issueUrl,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null
  };
}
