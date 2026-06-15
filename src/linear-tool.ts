import type { DynamicToolCallParams, DynamicToolCallResponse, DynamicToolHandler, DynamicToolSpec, Issue } from "./types.ts";

export type LinearGraphqlExecutor = {
  rawGraphql<Data>(query: string, variables?: Record<string, unknown>): Promise<Data>;
};

export type LinearIssueToolContext = {
  issue: Issue;
  projectSlug: string;
};

type LinearIssueData = {
  issue?: {
    id?: string;
    identifier?: string;
    title?: string;
    url?: string | null;
    state?: { id?: string; name?: string } | null;
    project?: { id?: string; slugId?: string | null; name?: string | null } | null;
    team?: { id?: string; key?: string; name?: string } | null;
    labels?: { nodes?: Array<{ name?: string }> } | null;
  } | null;
};

type LinearCommentData = {
  commentCreate?: {
    success?: boolean;
    comment?: { id?: string; url?: string | null; createdAt?: string | null } | null;
  } | null;
};

type LinearAttachmentData = {
  attachmentCreate?: {
    success?: boolean;
    attachment?: { id?: string; url?: string | null; title?: string | null } | null;
  } | null;
};

type LinearStateUpdateData = {
  issueUpdate?: {
    success?: boolean;
    issue?: { id?: string; identifier?: string; state?: { id?: string; name?: string } | null } | null;
  } | null;
};

type LinearStateLookupData = {
  issue?: { team?: { id?: string } | null } | null;
  workflowStates?: { nodes?: Array<{ id?: string; name?: string; team?: { id?: string } | null }> } | null;
};

const TOOL_GET_ISSUE = "linear_get_issue";
const TOOL_COMMENT_ISSUE = "linear_comment_issue";
const TOOL_UPDATE_ISSUE_STATE = "linear_update_issue_state";
const TOOL_ATTACH_ISSUE_URL = "linear_attach_issue_url";

export function createLinearIssueTools(executor: LinearGraphqlExecutor, context: LinearIssueToolContext): DynamicToolHandler {
  return {
    specs: () => linearIssueToolSpecs(),
    call: (params) => executeLinearIssueTool(executor, context, params)
  };
}

export function linearIssueToolSpecs(): DynamicToolSpec[] {
  return [
    {
      name: TOOL_GET_ISSUE,
      description: "Read the current Linear issue bound to this Codex session. No arguments are accepted.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
      },
      deferLoading: false
    },
    {
      name: TOOL_COMMENT_ISSUE,
      description: "Create a Markdown comment on the current Linear issue bound to this Codex session.",
      inputSchema: {
        type: "object",
        properties: {
          body: { type: "string", description: "Markdown comment body to post to the current issue." }
        },
        required: ["body"],
        additionalProperties: false
      },
      deferLoading: false
    },
    {
      name: TOOL_UPDATE_ISSUE_STATE,
      description: "Move the current Linear issue to a workflow state by state_id. The state must belong to the issue's team.",
      inputSchema: {
        type: "object",
        properties: {
          state_id: { type: "string", description: "Linear workflow state UUID for the current issue's team." }
        },
        required: ["state_id"],
        additionalProperties: false
      },
      deferLoading: false
    },
    {
      name: TOOL_ATTACH_ISSUE_URL,
      description: "Attach an HTTPS URL such as a pull request or artifact link to the current Linear issue.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "HTTPS URL to attach to the current issue." },
          title: { type: "string", description: "Short title displayed for the attachment." }
        },
        required: ["url", "title"],
        additionalProperties: false
      },
      deferLoading: false
    }
  ];
}

export async function executeLinearIssueTool(executor: LinearGraphqlExecutor, context: LinearIssueToolContext, params: DynamicToolCallParams): Promise<DynamicToolCallResponse> {
  try {
    if (params.tool === TOOL_GET_ISSUE) return await getIssue(executor, context, params.arguments);
    if (params.tool === TOOL_COMMENT_ISSUE) return await commentIssue(executor, context, params.arguments);
    if (params.tool === TOOL_UPDATE_ISSUE_STATE) return await updateIssueState(executor, context, params.arguments);
    if (params.tool === TOOL_ATTACH_ISSUE_URL) return await attachIssueUrl(executor, context, params.arguments);
    return textResponse(false, `unsupported dynamic tool: ${params.tool}`);
  } catch (error) {
    return textResponse(false, safeError(error));
  }
}

async function attachIssueUrl(executor: LinearGraphqlExecutor, context: LinearIssueToolContext, args: unknown): Promise<DynamicToolCallResponse> {
  const input = parseObjectArgs(args);
  if (!input.ok) return textResponse(false, input.error);
  const url = httpsUrlField(input.value, "url");
  if (!url.ok) return textResponse(false, url.error);
  const title = stringField(input.value, "title");
  if (!title.ok) return textResponse(false, title.error);
  if (title.value.length > 200) return textResponse(false, "title must be 200 characters or fewer");

  const data = await executor.rawGraphql<LinearAttachmentData>(ATTACH_BOUND_ISSUE_URL_MUTATION, {
    issueId: context.issue.id,
    url: url.value,
    title: title.value
  });
  if (!data.attachmentCreate?.success) return textResponse(false, "Linear attachmentCreate did not report success");
  return textResponse(true, JSON.stringify({ attachment: data.attachmentCreate.attachment ?? null }, null, 2));
}

async function getIssue(executor: LinearGraphqlExecutor, context: LinearIssueToolContext, args: unknown): Promise<DynamicToolCallResponse> {
  if (!isEmptyArgs(args)) return textResponse(false, `${TOOL_GET_ISSUE} does not accept arguments`);
  const data = await executor.rawGraphql<LinearIssueData>(GET_BOUND_ISSUE_QUERY, { issueId: context.issue.id });
  const issue = data.issue;
  if (!issue?.id) return textResponse(false, "current Linear issue was not found");
  if (!isExpectedProject(issue.project?.slugId, context.projectSlug)) return textResponse(false, "current Linear issue is outside the configured project");
  return textResponse(true, JSON.stringify({ issue: publicIssue(issue) }, null, 2));
}

async function commentIssue(executor: LinearGraphqlExecutor, context: LinearIssueToolContext, args: unknown): Promise<DynamicToolCallResponse> {
  const input = parseObjectArgs(args);
  if (!input.ok) return textResponse(false, input.error);
  const body = stringField(input.value, "body");
  if (!body.ok) return textResponse(false, body.error);
  if (body.value.length > 20_000) return textResponse(false, "body must be 20000 characters or fewer");

  const data = await executor.rawGraphql<LinearCommentData>(COMMENT_BOUND_ISSUE_MUTATION, {
    issueId: context.issue.id,
    body: body.value
  });
  if (!data.commentCreate?.success) return textResponse(false, "Linear commentCreate did not report success");
  return textResponse(true, JSON.stringify({ comment: data.commentCreate.comment ?? null }, null, 2));
}

async function updateIssueState(executor: LinearGraphqlExecutor, context: LinearIssueToolContext, args: unknown): Promise<DynamicToolCallResponse> {
  const input = parseObjectArgs(args);
  if (!input.ok) return textResponse(false, input.error);
  const stateId = stringField(input.value, "state_id");
  if (!stateId.ok) return textResponse(false, stateId.error);

  const state = await lookupStateForCurrentIssue(executor, context.issue.id, stateId.value);
  if (!state) return textResponse(false, "state_id is not a workflow state for the current issue's team");

  const data = await executor.rawGraphql<LinearStateUpdateData>(UPDATE_BOUND_ISSUE_STATE_MUTATION, {
    issueId: context.issue.id,
    stateId: state.id
  });
  if (!data.issueUpdate?.success) return textResponse(false, "Linear issueUpdate did not report success");
  return textResponse(true, JSON.stringify({ issue: data.issueUpdate.issue ?? null }, null, 2));
}

async function lookupStateForCurrentIssue(executor: LinearGraphqlExecutor, issueId: string, stateId: string): Promise<{ id: string; name: string | null } | null> {
  const data = await executor.rawGraphql<LinearStateLookupData>(BOUND_ISSUE_STATE_LOOKUP_QUERY, { issueId, stateId });
  const teamId = data.issue?.team?.id;
  if (!teamId) return null;
  const state = data.workflowStates?.nodes?.find((node) => node.id === stateId && node.team?.id === teamId);
  if (!state?.id) return null;
  return { id: state.id, name: state.name ?? null };
}

function parseObjectArgs(value: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const object = typeof value === "string" ? parseJsonObject(value) : value;
  if (!isRecord(object)) return { ok: false, error: "tool arguments must be an object" };
  return { ok: true, value: object };
}

function isEmptyArgs(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  const parsed = typeof value === "string" ? parseJsonObject(value) : value;
  return isRecord(parsed) && Object.keys(parsed).length === 0;
}

function parseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function stringField(object: Record<string, unknown>, key: string): { ok: true; value: string } | { ok: false; error: string } {
  const value = object[key];
  if (typeof value !== "string" || value.trim().length === 0) return { ok: false, error: `${key} must be a non-empty string` };
  return { ok: true, value: value.trim() };
}

function httpsUrlField(object: Record<string, unknown>, key: string): { ok: true; value: string } | { ok: false; error: string } {
  const value = stringField(object, key);
  if (!value.ok) return value;
  if (value.value.length > 2048) return { ok: false, error: `${key} must be 2048 characters or fewer` };
  try {
    const url = new URL(value.value);
    if (url.protocol !== "https:") return { ok: false, error: `${key} must use https` };
    if (!url.hostname.includes(".")) return { ok: false, error: `${key} must use a public hostname` };
    return { ok: true, value: url.toString() };
  } catch {
    return { ok: false, error: `${key} must be a valid URL` };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExpectedProject(slugId: string | null | undefined, expectedSlug: string): boolean {
  return typeof slugId === "string" && slugId.toLowerCase() === expectedSlug.toLowerCase();
}

function publicIssue(issue: NonNullable<LinearIssueData["issue"]>): Record<string, unknown> {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url ?? null,
    state: issue.state ? { id: issue.state.id, name: issue.state.name } : null,
    project: issue.project ? { id: issue.project.id, slug_id: issue.project.slugId, name: issue.project.name } : null,
    team: issue.team ? { id: issue.team.id, key: issue.team.key, name: issue.team.name } : null,
    labels: issue.labels?.nodes?.map((label) => label.name).filter(Boolean) ?? []
  };
}

function textResponse(success: boolean, text: string): DynamicToolCallResponse {
  return { success, contentItems: [{ type: "inputText", text }] };
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/(api[_-]?key["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]+/gi, "$1<redacted>")
    .slice(0, 1000);
}

const GET_BOUND_ISSUE_QUERY = `
  query SfCurrentIssue($issueId: String!) {
    issue(id: $issueId) {
      id
      identifier
      title
      url
      state { id name }
      project { id slugId name }
      team { id key name }
      labels(first: 50) { nodes { name } }
    }
  }
`;

const COMMENT_BOUND_ISSUE_MUTATION = `
  mutation SfCommentCurrentIssue($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) {
      success
      comment { id url createdAt }
    }
  }
`;

const ATTACH_BOUND_ISSUE_URL_MUTATION = `
  mutation SfAttachCurrentIssueUrl($issueId: String!, $url: String!, $title: String!) {
    attachmentCreate(input: { issueId: $issueId, url: $url, title: $title }) {
      success
      attachment { id url title }
    }
  }
`;

const UPDATE_BOUND_ISSUE_STATE_MUTATION = `
  mutation SfUpdateCurrentIssueState($issueId: String!, $stateId: String!) {
    issueUpdate(id: $issueId, input: { stateId: $stateId }) {
      success
      issue { id identifier state { id name } }
    }
  }
`;

const BOUND_ISSUE_STATE_LOOKUP_QUERY = `
  query SfCurrentIssueStateLookup($issueId: String!, $stateId: String!) {
    issue(id: $issueId) { team { id } }
    workflowStates(first: 1, filter: { id: { eq: $stateId } }) {
      nodes { id name team { id } }
    }
  }
`;
