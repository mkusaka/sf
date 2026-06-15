---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: "your-project-slug"
  required_labels:
    - symphony
workspace:
  root: ./.symphony/workspaces
persistence:
  path: ./.symphony/state.sqlite
hooks:
  after_create: |
    git clone git@github.com:your-org/your-repo.git .
agent:
  max_concurrent_agents: 2
  max_turns: 5
codex:
  command: codex app-server
  approval_policy:
    granular:
      sandbox_approval: true
      rules: true
      mcp_elicitations: true
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    mode: workspace-write
    networkAccess: true
server:
  port: 3008
---

You are working on Linear issue {{ issue.identifier }}.

Title: {{ issue.title }}

Description:
{{ issue.description }}

Labels: {{ issue.labels | join: ", " }}

{% if attempt %}
This is attempt {{ attempt }}. Continue from the existing workspace and account for prior failures.
{% endif %}
