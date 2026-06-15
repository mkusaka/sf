import { LinearClient } from "@linear/sdk";
import type { Issue, IssueBlocker, TrackerClient, TrackerConfig } from "./types.ts";
import { normalizeState } from "./config.ts";

type RawIssueNode = {
  id?: unknown;
  identifier?: unknown;
  title?: unknown;
  description?: unknown;
  priority?: unknown;
  branchName?: unknown;
  url?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  state?: { name?: unknown } | null;
  labels?: { nodes?: Array<{ name?: unknown }> } | null;
  relations?: { nodes?: Array<{ type?: unknown; relatedIssue?: RawRelatedIssue | null }> } | null;
  inverseRelations?: { nodes?: Array<{ type?: unknown; issue?: RawRelatedIssue | null }> } | null;
};

type RawRelatedIssue = {
  id?: unknown;
  identifier?: unknown;
  state?: { name?: unknown } | null;
};

type IssuesResponse = {
  issues?: {
    nodes?: RawIssueNode[];
    pageInfo?: {
      hasNextPage?: boolean;
      endCursor?: string | null;
    };
  };
};

export class LinearTrackerClient implements TrackerClient {
  private client: LinearClient;
  private config: TrackerConfig;

  constructor(config: TrackerConfig) {
    this.config = config;
    this.client = new LinearClient({
      apiKey: config.apiKey,
      apiUrl: config.endpoint
    });
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    return this.fetchIssues({
      projectSlug: this.config.projectSlug,
      stateNames: this.config.activeStates,
      requiredLabels: this.config.requiredLabels
    });
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    if (stateNames.length === 0) return [];
    return this.fetchIssues({
      projectSlug: this.config.projectSlug,
      stateNames,
      requiredLabels: []
    });
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]> {
    if (issueIds.length === 0) return [];
    return this.fetchIssuesByIds(issueIds);
  }

  async rawGraphql<Data>(query: string, variables?: Record<string, unknown>): Promise<Data> {
    const response = await this.client.client.rawRequest<Data, Record<string, unknown>>(query, variables ?? {});
    if (response.errors?.length) {
      throw new Error(`linear_request_errors: ${response.errors.map((error) => error.message ?? "GraphQL error").join("; ")}`);
    }
    if (!response.data) throw new Error(response.error ?? "linear_unknown_payload");
    return response.data;
  }

  private async fetchIssues(input: { projectSlug: string; stateNames: string[]; requiredLabels: string[] }): Promise<Issue[]> {
    const normalizedRequiredLabels = normalizeLabels(input.requiredLabels);
    const normalizedStates = new Set(input.stateNames.map(normalizeState));
    const issues: Issue[] = [];
    let after: string | null = null;

    do {
      const data: IssuesResponse = await this.rawGraphql<IssuesResponse>(CANDIDATE_ISSUES_QUERY, {
        first: 50,
        after,
        projectSlug: input.projectSlug,
        stateNames: input.stateNames
      });
      const connection: NonNullable<IssuesResponse["issues"]> | undefined = data.issues;
      if (!connection?.nodes || !connection.pageInfo) throw new Error("linear_unknown_payload");
      for (const node of connection.nodes) {
        const issue = normalizeIssue(node);
        if (!issue) continue;
        if (!normalizedStates.has(normalizeState(issue.state))) continue;
        if (!hasRequiredLabels(issue.labels, normalizedRequiredLabels)) continue;
        issues.push(issue);
      }
      after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor ?? null : null;
      if (connection.pageInfo.hasNextPage && !after) throw new Error("linear_missing_end_cursor");
    } while (after);

    return issues;
  }

  private async fetchIssuesByIds(issueIds: string[]): Promise<Issue[]> {
    const data = await this.rawGraphql<IssuesResponse>(ISSUES_BY_IDS_QUERY, {
      first: Math.max(issueIds.length, 1),
      ids: issueIds
    });
    const nodes = data.issues?.nodes;
    if (!nodes) throw new Error("linear_unknown_payload");
    return nodes.map(normalizeIssue).filter((issue): issue is Issue => issue !== null);
  }
}

export function normalizeIssue(node: RawIssueNode): Issue | null {
  const id = stringValue(node.id);
  const identifier = stringValue(node.identifier);
  const title = stringValue(node.title);
  const state = stringValue(node.state?.name);
  if (!id || !identifier || !title || !state) return null;

  return {
    id,
    identifier,
    title,
    description: nullableString(node.description),
    priority: typeof node.priority === "number" && Number.isInteger(node.priority) ? node.priority : null,
    state,
    branchName: nullableString(node.branchName),
    url: nullableString(node.url),
    labels: normalizeLabels(node.labels?.nodes?.map((label) => stringValue(label.name) ?? "") ?? []),
    blockedBy: normalizeBlockers(node),
    createdAt: nullableString(node.createdAt),
    updatedAt: nullableString(node.updatedAt)
  };
}

function normalizeBlockers(node: RawIssueNode): IssueBlocker[] {
  const blockers: IssueBlocker[] = [];
  for (const relation of node.inverseRelations?.nodes ?? []) {
    if (relation.type === "blocks" && relation.issue) blockers.push(relatedIssue(relation.issue));
  }
  for (const relation of node.relations?.nodes ?? []) {
    if (relation.type === "blocked_by" && relation.relatedIssue) blockers.push(relatedIssue(relation.relatedIssue));
  }
  return blockers;
}

function relatedIssue(issue: RawRelatedIssue): IssueBlocker {
  return {
    id: nullableString(issue.id),
    identifier: nullableString(issue.identifier),
    state: nullableString(issue.state?.name)
  };
}

function normalizeLabels(labels: string[]): string[] {
  return labels.map((label) => label.trim().toLowerCase()).filter(Boolean);
}

function hasRequiredLabels(labels: string[], required: string[]): boolean {
  const present = new Set(labels);
  return required.every((label) => present.has(label));
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

const ISSUE_SELECTION = `
  nodes {
    id
    identifier
    title
    description
    priority
    branchName
    url
    createdAt
    updatedAt
    state { name }
    labels(first: 50) { nodes { name } }
    relations(first: 50) {
      nodes {
        type
        relatedIssue { id identifier state { name } }
      }
    }
    inverseRelations(first: 50) {
      nodes {
        type
        issue { id identifier state { name } }
      }
    }
  }
  pageInfo { hasNextPage endCursor }
`;

const CANDIDATE_ISSUES_QUERY = `
  query SymphonyCandidateIssues($first: Int!, $after: String, $projectSlug: String!, $stateNames: [String!]) {
    issues(
      first: $first
      after: $after
      filter: {
        project: { slugId: { eq: $projectSlug } }
        state: { name: { in: $stateNames } }
      }
    ) {
      ${ISSUE_SELECTION}
    }
  }
`;

const ISSUES_BY_IDS_QUERY = `
  query SymphonyIssuesByIds($first: Int!, $ids: [ID!]) {
    issues(first: $first, filter: { id: { in: $ids } }) {
      ${ISSUE_SELECTION}
    }
  }
`;
