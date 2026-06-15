import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { HooksConfig, Workspace } from "./types.ts";
import type { Logger } from "./logger.ts";

export class WorkspaceError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
  }
}

export function workspaceKey(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function workspacePath(root: string, identifier: string): string {
  const rootPath = path.resolve(root);
  const child = path.resolve(rootPath, workspaceKey(identifier));
  assertInsideRoot(rootPath, child);
  return child;
}

export async function createWorkspace(root: string, identifier: string, hooks: HooksConfig, logger: Logger): Promise<Workspace> {
  const rootPath = path.resolve(root);
  const child = workspacePath(rootPath, identifier);
  await mkdir(rootPath, { recursive: true });

  let createdNow = false;
  try {
    const info = await stat(child);
    if (!info.isDirectory()) throw new WorkspaceError("workspace_not_directory", `${child} exists but is not a directory`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(child, { recursive: true });
    createdNow = true;
  }

  if (createdNow && hooks.afterCreate) {
    await runHook("after_create", hooks.afterCreate, child, hooks.timeoutMs, logger);
  }

  return { path: child, key: path.basename(child), createdNow };
}

export async function removeWorkspace(root: string, identifier: string, hooks: HooksConfig, logger: Logger): Promise<void> {
  const child = workspacePath(root, identifier);
  try {
    await stat(child);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (hooks.beforeRemove) {
    try {
      await runHook("before_remove", hooks.beforeRemove, child, hooks.timeoutMs, logger);
    } catch (error) {
      logger.warn("before_remove hook failed; continuing cleanup", { workspace: child, error: errorMessage(error) });
    }
  }
  await rm(child, { recursive: true, force: true });
}

export async function runHook(name: string, script: string, cwd: string, timeoutMs: number, logger: Logger): Promise<void> {
  logger.info("hook started", { hook: name, cwd });
  await new Promise<void>((resolve, reject) => {
    const child = spawn("bash", ["-lc", script], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new WorkspaceError("hook_timeout", `${name} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      output = output.slice(-4000);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      output = output.slice(-4000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        logger.info("hook completed", { hook: name });
        resolve();
      } else {
        reject(new WorkspaceError("hook_failed", `${name} exited with ${code}: ${output.trim()}`));
      }
    });
  });
}

export function assertInsideRoot(root: string, child: string): void {
  const normalizedRoot = path.resolve(root);
  const normalizedChild = path.resolve(child);
  const relative = path.relative(normalizedRoot, normalizedChild);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new WorkspaceError("workspace_outside_root", `${normalizedChild} is outside ${normalizedRoot}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
