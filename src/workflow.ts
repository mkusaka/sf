import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { JsonObject, WorkflowDefinition } from "./types.ts";

export class WorkflowError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
  }
}

export async function loadWorkflow(workflowPath = path.resolve(process.cwd(), "WORKFLOW.md")): Promise<WorkflowDefinition> {
  const absolutePath = path.resolve(workflowPath);
  let text: string;
  try {
    text = await readFile(absolutePath, "utf8");
  } catch (error) {
    throw new WorkflowError("missing_workflow_file", `Cannot read workflow file: ${absolutePath}`);
  }
  return parseWorkflow(text, absolutePath);
}

export function parseWorkflow(text: string, workflowPath: string): WorkflowDefinition {
  if (!text.startsWith("---")) {
    return { path: path.resolve(workflowPath), config: {}, promptTemplate: text.trim() };
  }

  const lines = text.split(/\r?\n/);
  let closing = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === "---") {
      closing = index;
      break;
    }
  }
  if (closing === -1) {
    throw new WorkflowError("workflow_parse_error", "YAML front matter is missing a closing delimiter");
  }

  const yamlText = lines.slice(1, closing).join("\n");
  let parsed: unknown;
  try {
    parsed = yamlText.trim() ? YAML.parse(yamlText) : {};
  } catch (error) {
    throw new WorkflowError("workflow_parse_error", error instanceof Error ? error.message : "Invalid YAML front matter");
  }

  if (!isPlainObject(parsed)) {
    throw new WorkflowError("workflow_front_matter_not_a_map", "Workflow front matter must be a map/object");
  }

  return {
    path: path.resolve(workflowPath),
    config: parsed,
    promptTemplate: lines.slice(closing + 1).join("\n").trim()
  };
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
