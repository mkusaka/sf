import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Orchestrator } from "./orchestrator.ts";

export type DashboardServer = {
  url: string;
  close(): Promise<void>;
};

export async function startDashboard(orchestrator: Orchestrator, port: number): Promise<DashboardServer> {
  const server = http.createServer((request, response) => {
    void handleRequest(orchestrator, request, response).catch((error) => {
      if (!response.headersSent) {
        sendJson(response, 500, { error: { code: "internal_error", message: error instanceof Error ? error.message : "Internal server error" } });
      } else {
        response.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

async function handleRequest(orchestrator: Orchestrator, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/") {
    return send(response, 200, renderDashboard(orchestrator.snapshot()), "text/html; charset=utf-8");
  }
  if (request.method === "GET" && url.pathname === "/api/v1/state") {
    return sendJson(response, 200, orchestrator.snapshot());
  }
  if (request.method === "POST" && url.pathname === "/api/v1/refresh") {
    orchestrator.refresh();
    return sendJson(response, 202, { queued: true, coalesced: false, requested_at: new Date().toISOString(), operations: ["poll", "reconcile"] });
  }
  const match = /^\/api\/v1\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && match?.[1]) {
    const identifier = safeDecodeURIComponent(match[1]);
    if (!identifier) return sendJson(response, 400, { error: { code: "invalid_issue_identifier", message: "Issue identifier path segment is malformed" } });
    const snapshot = orchestrator.issueSnapshot(identifier);
    if (!snapshot) return sendJson(response, 404, { error: { code: "issue_not_found", message: "Issue is not tracked in current runtime state" } });
    return sendJson(response, 200, snapshot);
  }
  if (["GET", "POST"].includes(request.method ?? "")) {
    return sendJson(response, 404, { error: { code: "not_found", message: "Route not found" } });
  }
  return sendJson(response, 405, { error: { code: "method_not_allowed", message: "Method not allowed" } });
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  send(response, status, JSON.stringify(body, null, 2), "application/json; charset=utf-8");
}

function send(response: http.ServerResponse, status: number, body: string, contentType: string): void {
  response.writeHead(status, { "content-type": contentType });
  response.end(body);
}

function renderDashboard(state: ReturnType<Orchestrator["snapshot"]>): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>sf Symphony</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f6f7f8; color: #171717; }
    header { padding: 20px 28px; border-bottom: 1px solid #d8dde3; background: #ffffff; display: flex; justify-content: space-between; align-items: center; }
    main { padding: 24px 28px; display: grid; gap: 20px; }
    h1, h2 { margin: 0; letter-spacing: 0; }
    h1 { font-size: 20px; }
    h2 { font-size: 15px; }
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
    .metric, section { background: #ffffff; border: 1px solid #d8dde3; border-radius: 8px; padding: 16px; }
    .metric strong { display: block; font-size: 26px; margin-top: 6px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border-bottom: 1px solid #e5e8eb; padding: 10px 8px; text-align: left; vertical-align: top; }
    th { color: #5d6673; font-weight: 600; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    @media (prefers-color-scheme: dark) {
      body { background: #111418; color: #edf0f2; }
      header, .metric, section { background: #171b20; border-color: #2c333a; }
      th, td { border-color: #2c333a; }
      th { color: #a8b0ba; }
    }
  </style>
</head>
<body>
  <header>
    <h1>sf Symphony</h1>
    <code>${escapeHtml(state.generated_at)}</code>
  </header>
  <main>
    <div class="metrics">
      <div class="metric">Running<strong>${state.counts.running}</strong></div>
      <div class="metric">Retrying<strong>${state.counts.retrying}</strong></div>
      <div class="metric">Tokens<strong>${state.codex_totals.total_tokens}</strong></div>
      <div class="metric">Runtime seconds<strong>${state.codex_totals.seconds_running.toFixed(1)}</strong></div>
    </div>
    ${table("Running", state.running)}
    ${table("Retrying", state.retrying)}
    ${table("Recent Events", state.recent_events)}
  </main>
</body>
</html>`;
}

function table(title: string, rows: object[]): string {
  const typedRows = rows as Array<Record<string, unknown>>;
  const keys = [...new Set(typedRows.flatMap((row) => Object.keys(row)))].slice(0, 8);
  if (typedRows.length === 0) return `<section><h2>${escapeHtml(title)}</h2><p>None</p></section>`;
  return `<section><h2>${escapeHtml(title)}</h2><table><thead><tr>${keys.map((key) => `<th>${escapeHtml(key)}</th>`).join("")}</tr></thead><tbody>${typedRows.map((row) => `<tr>${keys.map((key) => `<td>${escapeHtml(formatCell(row[key]))}</td>`).join("")}</tr>`).join("")}</tbody></table></section>`;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
