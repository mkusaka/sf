import { describe, expect, it, vi } from "vitest";
import { startDashboard } from "../src/server.ts";

describe("dashboard server", () => {
  it("serves state, issue 404, and refresh", async () => {
    const refresh = vi.fn();
    const server = await startDashboard({
      snapshot: () => ({
        generated_at: "2026-01-01T00:00:00Z",
        counts: { running: 0, retrying: 0 },
        running: [],
        retrying: [],
        codex_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
        rate_limits: null,
        last_error: null,
        recent_events: []
      }),
      issueSnapshot: () => null,
      refresh
    } as never, 0);
    try {
      const state = await fetch(`${server.url}/api/v1/state`);
      expect(state.status).toBe(200);
      expect((await state.json()).counts).toEqual({ running: 0, retrying: 0 });

      const missing = await fetch(`${server.url}/api/v1/ABC-1`);
      expect(missing.status).toBe(404);

      const malformed = await fetch(`${server.url}/api/v1/%E0%A4%A`);
      expect(malformed.status).toBe(400);
      expect((await malformed.json()).error.code).toBe("invalid_issue_identifier");

      const refreshed = await fetch(`${server.url}/api/v1/refresh`, { method: "POST" });
      expect(refreshed.status).toBe(202);
      expect(refresh).toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
