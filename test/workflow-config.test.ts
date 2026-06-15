import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseWorkflow, WorkflowError } from "../src/workflow.ts";
import { resolveConfig } from "../src/config.ts";
import { renderPrompt } from "../src/prompt.ts";

describe("workflow/config", () => {
  it("parses YAML front matter and prompt body", () => {
    const workflow = parseWorkflow("---\ntracker:\n  kind: linear\n---\nHello {{ issue.title }}\n", "/tmp/repo/WORKFLOW.md");
    expect(workflow.config).toEqual({ tracker: { kind: "linear" } });
    expect(workflow.promptTemplate).toBe("Hello {{ issue.title }}");
  });

  it("rejects non-map front matter", () => {
    expect(() => parseWorkflow("---\n- nope\n---\nbody", "/tmp/WORKFLOW.md")).toThrow(WorkflowError);
  });

  it("applies defaults and resolves env-backed values", () => {
    vi.stubEnv("LINEAR_API_KEY", "linear-test-key");
    vi.stubEnv("SF_WORKSPACE_ROOT", "/tmp/sf-test-workspaces");
    const workflow = parseWorkflow(
      "---\ntracker:\n  kind: linear\n  project_slug: proj\nworkspace:\n  root: $SF_WORKSPACE_ROOT\n---\nBody",
      "/tmp/repo/WORKFLOW.md"
    );
    const config = resolveConfig(workflow);
    expect(config.tracker.apiKey).toBe("linear-test-key");
    expect(config.tracker.endpoint).toBe("https://api.linear.app/graphql");
    expect(config.workspace.root).toBe(path.normalize("/tmp/sf-test-workspaces"));
    expect(config.persistence.path).toBe(path.normalize("/tmp/repo/.symphony/state.sqlite"));
    expect(config.agent.maxTurns).toBe(20);
  });

  it("fails strict prompt rendering on unknown variables", async () => {
    await expect(renderPrompt("{{ missing.value }}", sampleIssue(), null)).rejects.toMatchObject({ code: "template_render_error" });
  });
});

function sampleIssue() {
  return {
    id: "i1",
    identifier: "ABC-1",
    title: "Title",
    description: null,
    priority: null,
    state: "Todo",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null
  };
}
