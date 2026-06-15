import { describe, expect, it } from "vitest";
import { normalizeIssue } from "../src/linear.ts";

describe("linear normalization", () => {
  it("normalizes labels and inverse blockers", () => {
    const issue = normalizeIssue({
      id: "id1",
      identifier: "ABC-1",
      title: "Implement",
      description: null,
      priority: 0,
      branchName: "abc-1",
      url: "https://linear.app/acme/issue/ABC-1",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      state: { name: "Todo" },
      labels: { nodes: [{ name: " Symphony " }] },
      inverseRelations: {
        nodes: [
          { type: "blocks", issue: { id: "id0", identifier: "ABC-0", state: { name: "In Progress" } } }
        ]
      }
    });
    expect(issue).toMatchObject({
      id: "id1",
      identifier: "ABC-1",
      priority: 0,
      labels: ["symphony"],
      blockedBy: [{ id: "id0", identifier: "ABC-0", state: "In Progress" }]
    });
  });

  it("drops malformed issues without required fields", () => {
    expect(normalizeIssue({ id: "id1", title: "Missing identifier", state: { name: "Todo" } })).toBeNull();
  });
});
