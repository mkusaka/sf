import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.ts";
import { createWorkspace, workspaceKey, workspacePath } from "../src/workspace.ts";

describe("workspace", () => {
  it("sanitizes issue identifiers", () => {
    expect(workspaceKey("ABC/123: hello")).toBe("ABC_123__hello");
  });

  it("keeps workspace paths inside root", () => {
    const root = "/tmp/sf-root";
    expect(workspacePath(root, "../ABC-1")).toBe(path.join(root, ".._ABC-1"));
  });

  it("creates workspace and runs after_create only once", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sf-workspace-"));
    try {
      const logger = createLogger("error");
      const hooks = {
        afterCreate: "printf created > marker",
        beforeRun: null,
        afterRun: null,
        beforeRemove: null,
        timeoutMs: 5000
      };
      const first = await createWorkspace(root, "ABC-1", hooks, logger);
      const second = await createWorkspace(root, "ABC-1", hooks, logger);
      expect(first.createdNow).toBe(true);
      expect(second.createdNow).toBe(false);
      expect(await readFile(path.join(first.path, "marker"), "utf8")).toBe("created");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects existing non-directory workspace target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sf-workspace-"));
    try {
      await writeFile(path.join(root, "ABC-1"), "file");
      await expect(createWorkspace(root, "ABC-1", {
        afterCreate: null,
        beforeRun: null,
        afterRun: null,
        beforeRemove: null,
        timeoutMs: 1000
      }, createLogger("error"))).rejects.toMatchObject({ code: "workspace_not_directory" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
