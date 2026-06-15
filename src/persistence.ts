import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Issue, RetryEntry, RuntimeState, RuntimeStore, RunningEntry, StoredRetryEntry, StoredSessionEntry } from "./types.ts";

type MetaRow = { value_json: string } | undefined;
type RetryRow = {
  issue_id: string;
  identifier: string;
  issue_url: string | null;
  issue_json: string | null;
  attempt: number;
  due_at_ms: number;
  error: string | null;
};
type SessionRow = {
  issue_id: string;
  identifier: string;
  issue_url: string | null;
  issue_json: string | null;
  status: string;
  attempt: number | null;
  started_at_ms: number | null;
  last_event_at_ms: number | null;
  last_event: string | null;
  last_message: string | null;
  error: string | null;
};
type EventRow = {
  at: string;
  issue_id: string | null;
  issue_identifier: string | null;
  event: string;
  message: string | null;
};

const SCHEMA_VERSION = 1;

export class SQLiteRuntimeStore implements RuntimeStore {
  private db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  load(): {
    retries: StoredRetryEntry[];
    runningSessions: StoredSessionEntry[];
    totals: RuntimeState["codexTotals"];
    rateLimits: unknown | null;
    recentEvents: RuntimeState["recentEvents"];
  } {
    const retries = this.db.prepare("SELECT * FROM retry_queue ORDER BY due_at_ms ASC").all() as RetryRow[];
    const runningSessions = this.db.prepare("SELECT * FROM issue_sessions WHERE status = 'running'").all() as SessionRow[];
    const events = this.db.prepare("SELECT * FROM runtime_events ORDER BY id DESC LIMIT 200").all() as EventRow[];
    return {
      retries: retries.map((row) => ({
        issueId: row.issue_id,
        identifier: row.identifier,
        issueUrl: row.issue_url,
        issue: parseJson<Issue>(row.issue_json),
        attempt: row.attempt,
        dueAtMs: row.due_at_ms,
        timer: null,
        error: row.error
      })),
      runningSessions: runningSessions.map((row) => ({
        issueId: row.issue_id,
        identifier: row.identifier,
        issueUrl: row.issue_url,
        issue: parseJson<Issue>(row.issue_json),
        status: row.status,
        attempt: row.attempt,
        startedAt: row.started_at_ms,
        lastEventAt: row.last_event_at_ms,
        lastEvent: row.last_event,
        lastMessage: row.last_message,
        error: row.error
      })),
      totals: this.loadMeta("codex_totals", { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 }),
      rateLimits: this.loadMeta("codex_rate_limits", null),
      recentEvents: events.reverse().map((row) => ({
        at: row.at,
        ...(row.issue_id ? { issueId: row.issue_id } : {}),
        ...(row.issue_identifier ? { issueIdentifier: row.issue_identifier } : {}),
        event: row.event,
        ...(row.message ? { message: row.message } : {})
      }))
    };
  }

  upsertRetry(entry: RetryEntry, issue?: Issue): void {
    this.db.prepare(`
      INSERT INTO retry_queue(issue_id, identifier, issue_url, issue_json, attempt, due_at_ms, error, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(issue_id) DO UPDATE SET
        identifier = excluded.identifier,
        issue_url = excluded.issue_url,
        issue_json = excluded.issue_json,
        attempt = excluded.attempt,
        due_at_ms = excluded.due_at_ms,
        error = excluded.error,
        updated_at_ms = excluded.updated_at_ms
    `).run(entry.issueId, entry.identifier, entry.issueUrl, JSON.stringify(issue ?? null), entry.attempt, entry.dueAtMs, entry.error, Date.now());
  }

  deleteRetry(issueId: string): void {
    this.db.prepare("DELETE FROM retry_queue WHERE issue_id = ?").run(issueId);
  }

  upsertSession(entry: RunningEntry, status: string, error: string | null = null): void {
    this.db.prepare(`
      INSERT INTO issue_sessions(
        issue_id, identifier, issue_url, issue_json, status, attempt, started_at_ms,
        session_id, codex_app_server_pid, last_event, last_message, last_event_at_ms,
        turn_count, input_tokens, output_tokens, total_tokens, error, updated_at_ms
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(issue_id) DO UPDATE SET
        identifier = excluded.identifier,
        issue_url = excluded.issue_url,
        issue_json = excluded.issue_json,
        status = excluded.status,
        attempt = excluded.attempt,
        started_at_ms = excluded.started_at_ms,
        session_id = excluded.session_id,
        codex_app_server_pid = excluded.codex_app_server_pid,
        last_event = excluded.last_event,
        last_message = excluded.last_message,
        last_event_at_ms = excluded.last_event_at_ms,
        turn_count = excluded.turn_count,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        total_tokens = excluded.total_tokens,
        error = excluded.error,
        updated_at_ms = excluded.updated_at_ms
    `).run(
      entry.issue.id,
      entry.issue.identifier,
      entry.issue.url,
      JSON.stringify(entry.issue),
      status,
      entry.attempt,
      entry.startedAt,
      entry.sessionId,
      entry.codexAppServerPid,
      entry.lastCodexEvent,
      entry.lastCodexMessage,
      entry.lastCodexTimestamp,
      entry.turnCount,
      entry.codexInputTokens,
      entry.codexOutputTokens,
      entry.codexTotalTokens,
      error,
      Date.now()
    );
  }

  markSessionStatus(issueId: string, status: string, error: string | null = null): void {
    this.db.prepare(`
      UPDATE issue_sessions
      SET status = ?, error = ?, updated_at_ms = ?, completed_at_ms = ?
      WHERE issue_id = ?
    `).run(status, error, Date.now(), Date.now(), issueId);
  }

  saveTotals(totals: RuntimeState["codexTotals"]): void {
    this.saveMeta("codex_totals", totals);
  }

  saveRateLimits(rateLimits: unknown | null): void {
    this.saveMeta("codex_rate_limits", rateLimits);
  }

  appendEvent(event: RuntimeState["recentEvents"][number]): void {
    this.db.prepare(`
      INSERT INTO runtime_events(at, issue_id, issue_identifier, event, message)
      VALUES (?, ?, ?, ?, ?)
    `).run(event.at, event.issueId ?? null, event.issueIdentifier ?? null, event.event, event.message ?? null);
    this.db.exec(`
      DELETE FROM runtime_events
      WHERE id NOT IN (SELECT id FROM runtime_events ORDER BY id DESC LIMIT 200)
    `);
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_meta (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS retry_queue (
        issue_id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL,
        issue_url TEXT,
        issue_json TEXT,
        attempt INTEGER NOT NULL,
        due_at_ms INTEGER NOT NULL,
        error TEXT,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS issue_sessions (
        issue_id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL,
        issue_url TEXT,
        issue_json TEXT,
        status TEXT NOT NULL,
        attempt INTEGER,
        started_at_ms INTEGER,
        session_id TEXT,
        codex_app_server_pid INTEGER,
        last_event TEXT,
        last_message TEXT,
        last_event_at_ms INTEGER,
        turn_count INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        completed_at_ms INTEGER,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        issue_id TEXT,
        issue_identifier TEXT,
        event TEXT NOT NULL,
        message TEXT
      );
    `);
    this.saveMeta("schema_version", SCHEMA_VERSION);
  }

  private loadMeta<T>(key: string, fallback: T): T {
    const row = this.db.prepare("SELECT value_json FROM runtime_meta WHERE key = ?").get(key) as MetaRow;
    return parseJson<T>(row?.value_json) ?? fallback;
  }

  private saveMeta(key: string, value: unknown): void {
    this.db.prepare(`
      INSERT INTO runtime_meta(key, value_json)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
    `).run(key, JSON.stringify(value));
  }
}

function parseJson<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
