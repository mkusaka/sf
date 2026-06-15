import { describe, expect, it, vi } from "vitest";
import { executeLinearIssueTool, linearIssueToolSpecs, type LinearGraphqlExecutor } from "../src/linear-tool.ts";
import type { Issue } from "../src/types.ts";

describe("Linear issue dynamic tools", () => {
  it("advertises issue-bound tools instead of raw GraphQL", () => {
    expect(linearIssueToolSpecs().map((spec) => spec.name)).toEqual([
      "linear_get_issue",
      "linear_comment_issue",
      "linear_update_issue_state",
      "linear_attach_issue_url"
    ]);
  });

  it("reads the current issue with a fixed query and project check", async () => {
    const rawGraphql = vi.fn(async (_query: string, _variables?: Record<string, unknown>) => ({
      issue: {
        id: "issue-id",
        identifier: "ABC-1",
        title: "Title",
        url: "https://linear.app/acme/issue/ABC-1/title",
        state: { id: "state-1", name: "Todo" },
        project: { id: "project-1", slugId: "proj", name: "Project" },
        team: { id: "team-1", key: "ABC", name: "Team" },
        labels: { nodes: [{ name: "symphony" }] }
      }
    }));
    const response = await executeLinearIssueTool(executor(rawGraphql), context(), {
      tool: "linear_get_issue",
      callId: "call-1",
      threadId: "thread-1",
      turnId: "turn-1",
      arguments: {}
    });

    expect(rawGraphql.mock.calls[0]?.[0]).toContain("query SfCurrentIssue");
    expect(rawGraphql.mock.calls[0]?.[1]).toEqual({ issueId: "issue-id" });
    expect(response.success).toBe(true);
    expect(JSON.parse(response.contentItems[0]?.type === "inputText" ? response.contentItems[0].text : "{}").issue.project.slug_id).toBe("proj");
  });

  it("comments on only the bound issue with fixed variables", async () => {
    const rawGraphql = vi.fn(async (_query: string, _variables?: Record<string, unknown>) => ({
      commentCreate: { success: true, comment: { id: "comment-1", url: "https://linear.app/comment", createdAt: "2026-01-01T00:00:00Z" } }
    }));
    const response = await executeLinearIssueTool(executor(rawGraphql), context(), {
      tool: "linear_comment_issue",
      callId: "call-1",
      threadId: "thread-1",
      turnId: "turn-1",
      arguments: { body: "done" }
    });

    expect(rawGraphql.mock.calls[0]?.[0]).toContain("mutation SfCommentCurrentIssue");
    expect(rawGraphql.mock.calls[0]?.[1]).toEqual({ issueId: "issue-id", body: "done" });
    expect(response.success).toBe(true);
  });

  it("updates state only after confirming the state belongs to the bound issue team", async () => {
    const rawGraphql = vi.fn(async (_query: string, _variables?: Record<string, unknown>) => ({}))
      .mockResolvedValueOnce({
        issue: { team: { id: "team-1" } },
        workflowStates: { nodes: [{ id: "state-2", name: "Done", team: { id: "team-1" } }] }
      })
      .mockResolvedValueOnce({
        issueUpdate: { success: true, issue: { id: "issue-id", identifier: "ABC-1", state: { id: "state-2", name: "Done" } } }
      });
    const response = await executeLinearIssueTool(executor(rawGraphql), context(), {
      tool: "linear_update_issue_state",
      callId: "call-1",
      threadId: "thread-1",
      turnId: "turn-1",
      arguments: { state_id: "state-2" }
    });

    expect(rawGraphql.mock.calls[0]?.[0]).toContain("query SfCurrentIssueStateLookup");
    expect(rawGraphql.mock.calls[0]?.[1]).toEqual({ issueId: "issue-id", stateId: "state-2" });
    expect(rawGraphql.mock.calls[1]?.[0]).toContain("mutation SfUpdateCurrentIssueState");
    expect(rawGraphql.mock.calls[1]?.[1]).toEqual({ issueId: "issue-id", stateId: "state-2" });
    expect(response.success).toBe(true);
  });

  it("attaches only HTTPS URLs to the bound issue with fixed variables", async () => {
    const rawGraphql = vi.fn(async (_query: string, _variables?: Record<string, unknown>) => ({
      attachmentCreate: { success: true, attachment: { id: "attachment-1", url: "https://github.com/acme/repo/pull/1", title: "PR #1" } }
    }));
    const response = await executeLinearIssueTool(executor(rawGraphql), context(), {
      tool: "linear_attach_issue_url",
      callId: "call-1",
      threadId: "thread-1",
      turnId: "turn-1",
      arguments: { url: "https://github.com/acme/repo/pull/1", title: "PR #1" }
    });

    expect(rawGraphql.mock.calls[0]?.[0]).toContain("mutation SfAttachCurrentIssueUrl");
    expect(rawGraphql.mock.calls[0]?.[1]).toEqual({
      issueId: "issue-id",
      url: "https://github.com/acme/repo/pull/1",
      title: "PR #1"
    });
    expect(response.success).toBe(true);
  });

  it("rejects non-HTTPS attachment URLs without calling Linear", async () => {
    const rawGraphql = vi.fn(async (_query: string, _variables?: Record<string, unknown>) => ({}));
    const response = await executeLinearIssueTool(executor(rawGraphql), context(), {
      tool: "linear_attach_issue_url",
      callId: "call-1",
      threadId: "thread-1",
      turnId: "turn-1",
      arguments: { url: "http://localhost:3000/result", title: "Local result" }
    });

    expect(response.success).toBe(false);
    expect(rawGraphql).not.toHaveBeenCalled();
  });

  it("rejects unsupported tools and raw GraphQL-shaped arguments", async () => {
    const rawGraphql = vi.fn(async (_query: string, _variables?: Record<string, unknown>) => ({}));
    const testExecutor = executor(rawGraphql);

    await expect(executeLinearIssueTool(testExecutor, context(), {
      tool: "linear_graphql",
      callId: "call-1",
      threadId: "thread-1",
      turnId: "turn-1",
      arguments: { query: "query Viewer { viewer { id } }" }
    })).resolves.toMatchObject({ success: false });

    await expect(executeLinearIssueTool(testExecutor, context(), {
      tool: "linear_comment_issue",
      callId: "call-2",
      threadId: "thread-1",
      turnId: "turn-1",
      arguments: { query: "mutation Any { viewer { id } }" }
    })).resolves.toMatchObject({ success: false });

    expect(rawGraphql).not.toHaveBeenCalled();
  });
});

function executor(rawGraphql: (query: string, variables?: Record<string, unknown>) => Promise<unknown>): LinearGraphqlExecutor {
  return {
    async rawGraphql<Data>(query: string, variables?: Record<string, unknown>): Promise<Data> {
      return await rawGraphql(query, variables) as Data;
    }
  };
}

function context() {
  return {
    issue: issue(),
    projectSlug: "proj"
  };
}

function issue(): Issue {
  return {
    id: "issue-id",
    identifier: "ABC-1",
    title: "Title",
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
