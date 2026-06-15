# sf

`sf` is a TypeScript/Node implementation of the OpenAI Symphony service shape:
it polls Linear work, creates isolated per-issue workspaces, launches Codex
App Server locally, and exposes a small dashboard/API for runtime visibility.

Codex sessions get issue-bound Linear dynamic tools, so the `WORKFLOW.md`
prompt can ask Codex to inspect the current Linear issue, comment on that issue,
attach an HTTPS PR/artifact URL, or move that issue to an explicit workflow
state without exposing arbitrary GraphQL execution.

## Requirements

- Node.js 24+
- pnpm 11+
- Codex CLI with `codex app-server`
- Linear personal API key in `LINEAR_API_KEY`

## Setup

```bash
pnpm install
cp WORKFLOW.example.md WORKFLOW.md
```

Edit `WORKFLOW.md`:

- `tracker.project_slug`
- `tracker.required_labels`
- `workspace.root`
- workspace bootstrap hooks, especially `hooks.after_create`
- Codex approval/sandbox settings

## Run

```bash
pnpm start -- ./WORKFLOW.md
```

With dashboard:

```bash
pnpm start -- --port 3008 ./WORKFLOW.md
```

Dashboard/API:

- `GET /`
- `GET /api/v1/state`
- `GET /api/v1/<issue_identifier>`
- `POST /api/v1/refresh`

## Workflow Contract

`WORKFLOW.md` uses YAML front matter for runtime settings and a Liquid template
body for the Codex prompt. Unknown template variables and filters fail the run
attempt.

See `WORKFLOW.example.md` for a minimal starting point.

## Current Scope

Implemented:

- `WORKFLOW.md` loader with YAML front matter
- typed config defaults and `$VAR` resolution
- Linear SDK-backed tracker client using `LinearClient.client.rawRequest`
- issue normalization for state, labels, blockers, priority, timestamps, URL,
  and branch name
- per-issue workspace creation, reuse, hooks, and path safety
- strict prompt rendering
- local Codex App Server client over stdio JSON-RPC/JSONL
- issue-bound Linear dynamic tools inside Codex sessions
- orchestrator dispatch, retry, continuation retry, reconciliation, stall
  handling, token counters, and structured logs
- durable SQLite retry/session persistence across restarts
- HTTP dashboard and JSON API
- live runtime rebinding for tracker, workspace, agent, Codex, polling, and
  server port changes after `WORKFLOW.md` reload
- Vitest coverage for config, workspace, Linear normalization, orchestrator,
  persistence, dynamic tools, and dashboard routes

Not yet implemented:

- SSH worker extension
- live Linear/Codex end-to-end tests

## Verification

```bash
pnpm typecheck
pnpm test
```
