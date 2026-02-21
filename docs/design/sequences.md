# Sequences — Design Document

> Automation workflows for Claude Whisperer that chain AI operations, git actions, notifications, and human gates into repeatable, schedulable pipelines.

**Status:** Draft
**Date:** 2026-02-21

---

## Table of Contents

1. [Vision](#1-vision)
2. [Core Concepts](#2-core-concepts)
3. [Architecture](#3-architecture)
4. [YAML Format Specification](#4-yaml-format-specification)
5. [Node Types](#5-node-types)
6. [Execution Engine](#6-execution-engine)
7. [Templating & Context System](#7-templating--context-system)
8. [Notification System](#8-notification-system)
9. [Triggers & Scheduling](#9-triggers--scheduling)
10. [Scoping & Multi-Repo Support](#10-scoping--multi-repo-support)
11. [Visual Editor](#11-visual-editor)
12. [AI Workflow Generation](#12-ai-workflow-generation)
13. [Persistence & State Management](#13-persistence--state-management)
14. [Pre-Built Templates](#14-pre-built-templates)
15. [Voice Integration](#15-voice-integration)
16. [Security Model](#16-security-model)
17. [Frontend Integration](#17-frontend-integration)
18. [Implementation Phases](#18-implementation-phases)

---

## 1. Vision

Developers repeat the same multi-step workflows constantly: implement a feature, review the code, simplify it, run tests, create a PR, wait for CI, merge. Today these steps are manual and context-switching-heavy. Sequences turns them into defined, repeatable, auditable pipelines where each step can use the right AI model (Haiku for classification, Sonnet for implementation, Opus for complex review) and the right tools.

### Design Principles

- **YAML-first** — Workflows are stored as human-readable YAML files that both AI and humans can author and understand
- **Visual + Text hybrid** — Drag-and-drop in a visual node editor in-app, or edit YAML directly in your preferred text editor
- **AI-native** — AI can generate, modify, and optimize workflows. Every node type is designed to be AI-authorable
- **Repo-portable** — Sequences work across repos via context variables, not hardcoded paths
- **Progressive complexity** — Simple linear sequences are trivial to create; branching, parallelism, and scheduling are available when needed
- **Trust through verification** — Every action node can have verification steps; human approval gates are first-class

### What This Is NOT

- Not a general-purpose workflow engine (Temporal, n8n) — focused specifically on developer + AI workflows
- Not a CI/CD replacement — complements CI/CD by automating the human steps around it
- Not always-running — executions are triggered, not continuously polling (except scheduled triggers)

---

## 2. Core Concepts

### Sequence
A reusable workflow definition stored as a YAML file. Contains nodes, connections, defaults, and metadata. Can be global, per-repo, or multi-repo.

### Node
A single step in a sequence. Has a type (prompt, route, git action, notification, etc.), configuration, inputs from previous nodes, and outputs for subsequent nodes.

### Execution
A running instance of a sequence. Tracks current node, accumulated state, token usage, cost, and duration. Can be paused, resumed, or cancelled. Persisted to survive app restarts.

### Context
The runtime data available to nodes via template variables. Includes repo info, previous node outputs, execution metadata, and user-defined variables.

### Trigger
What starts an execution: manual run, voice command, schedule (cron), or internal event (e.g., SDK session completion).

---

## 3. Architecture

### Overview

```
┌─────────────────────────────────────────────────────────┐
│  Frontend (Svelte)                                       │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ Visual Editor │  │ Execution    │  │ Sequence      │  │
│  │ (Node Canvas) │  │ Monitor      │  │ Library       │  │
│  └──────┬───────┘  └──────┬───────┘  └───────┬───────┘  │
│         │                  │                   │          │
│  ┌──────┴──────────────────┴───────────────────┴───────┐  │
│  │  sequences store (Svelte 5 runes)                   │  │
│  │  sequenceExecutions store                           │  │
│  └─────────────────────┬───────────────────────────────┘  │
└────────────────────────┼──────────────────────────────────┘
                         │ Tauri commands + events
┌────────────────────────┼──────────────────────────────────┐
│  Backend (Rust)        │                                   │
│  ┌─────────────────────┴───────────────────────────────┐  │
│  │  Sequence Engine (src-tauri/src/sequences/)          │  │
│  │  ┌─────────────┐  ┌──────────┐  ┌───────────────┐  │  │
│  │  │ Executor     │  │ Scheduler│  │ State Manager │  │  │
│  │  │ (node runner)│  │ (cron)   │  │ (persistence) │  │  │
│  │  └──────┬───────┘  └──────────┘  └───────────────┘  │  │
│  └─────────┼───────────────────────────────────────────┘  │
│            │                                               │
│  ┌─────────┼──────────────────────────────────┐           │
│  │  Existing Infrastructure                    │           │
│  │  ┌──────┴──────┐  ┌────────┐  ┌─────────┐ │           │
│  │  │ Sidecar     │  │ Git    │  │ LLM     │ │           │
│  │  │ (SDK)       │  │ Module │  │ Client  │ │           │
│  │  └─────────────┘  └────────┘  └─────────┘ │           │
│  └────────────────────────────────────────────┘           │
└────────────────────────────────────────────────────────────┘
```

### Execution Engine Lives in Rust Backend

The execution engine runs in the Rust backend for:

- **Durability** — Survives frontend navigation, window minimize, app backgrounding
- **Long-running operations** — PR monitoring, scheduled triggers, wait nodes can run for hours/days
- **System access** — Git operations, file system, network calls without browser sandbox limitations
- **Resource efficiency** — No Svelte reactivity overhead for background execution

The frontend receives execution state via Tauri events and provides the UI layer (visual editor, sequence session view, library browser).

### New Rust Modules

```
src-tauri/src/sequences/
├── mod.rs              # Module exports, SequenceEngine struct
├── types.rs            # Sequence, Node, Execution, Context types
├── executor.rs         # Node execution logic, control flow
├── scheduler.rs        # Cron-based trigger management
├── state.rs            # Execution state persistence & recovery
├── template.rs         # {{ variable }} resolution engine (minijinja)
├── nodes/
│   ├── mod.rs          # Node trait, registry
│   ├── prompt.rs       # AI prompt node (via sidecar)
│   ├── route.rs        # Route node (expression + AI classification)
│   ├── git.rs          # Branch, worktree, commit, push
│   ├── github.rs       # PR create, PR wait, merge
│   ├── script.rs       # Shell command execution
│   ├── notify.rs       # Slack, Discord, system, webhook
│   ├── approval.rs     # Human-in-the-loop gate
│   ├── wait.rs         # Timer, polling, condition wait
│   ├── transform.rs    # Data transformation / extraction
│   ├── for_each.rs     # Collection iteration
│   ├── file.rs         # File read/write/copy operations
│   ├── http.rs         # Generic HTTP request node
│   └── sub_sequence.rs # Run another sequence as a node
```

### New Tauri Commands

```
src-tauri/src/commands/sequences_cmds.rs
├── list_sequences()                         # List all available sequences
├── get_sequence(id)                         # Get sequence definition
├── save_sequence(definition)                # Create or update
├── delete_sequence(id)                      # Remove sequence
├── import_sequence(yaml_string)             # Import from YAML text
├── export_sequence(id) -> yaml_string       # Export to YAML text
├── validate_sequence(definition)            # Dry-run validation
├── start_execution(sequence_id, context)    # Run a sequence
├── get_execution(execution_id)              # Get execution state
├── list_executions(filters)                 # List running/recent executions
├── pause_execution(execution_id)            # Pause at next node boundary
├── resume_execution(execution_id)           # Resume paused execution
├── cancel_execution(execution_id)           # Stop and cleanup
├── approve_node(execution_id, node_id)      # Approve an approval gate
├── reject_node(execution_id, node_id, reason) # Reject an approval gate
├── retry_node(execution_id, node_id)        # Retry a failed node
```

### New Tauri Events

```
sequence-node-start-{execution_id}      # Node began executing
sequence-node-complete-{execution_id}    # Node finished (success)
sequence-node-error-{execution_id}      # Node failed
sequence-node-waiting-{execution_id}    # Node waiting for approval/condition
sequence-status-{execution_id}          # Execution status changed
sequence-log-{execution_id}             # Log entry added
sequence-done-{execution_id}            # Execution completed
```

---

## 4. YAML Format Specification

### File Structure

```yaml
# Sequence metadata
name: "Code Review & PR Pipeline"
description: "Reviews code changes, creates a PR, waits for CI"
version: 1
tags: [review, pr, ci]

# Default settings (overridable per-node)
defaults:
  model: sonnet
  effort: high                    # off | low | medium | high | max
  repo: auto                     # auto = use active repo at execution time
  isolation: worktree             # worktree | lock | none (git concurrency strategy)
  timeout: 300000                 # 5 min default node timeout (ms)
  on_error: stop                 # stop | retry | skip | goto:<node_id>

# Input parameters (prompted at execution time or passed programmatically)
inputs:
  - name: feature_description
    type: string
    description: "What does this feature do?"
    required: true
    validation:
      min_length: 10
      max_length: 500
  - name: target_branch
    type: string
    default: main
    validation:
      pattern: "^[a-zA-Z0-9/_-]+$"
  - name: draft_pr
    type: boolean
    default: false

# Cleanup nodes (always run on completion or failure — see Section 5.17)
cleanup:
  - id: remove_worktree
    type: git_delete_worktree
    path: "{{ nodes.worktree.path }}"
    condition: "{{ nodes.worktree.path }}"   # Only if worktree was created

# Node definitions (executed in order unless routing changes flow)
nodes:
  - id: review
    type: prompt
    name: "Code Review"
    model: haiku                 # Override default — cheap classification
    output_format: json          # Instruct AI to respond in JSON
    prompt: |
      Review the recent changes in this repository.
      Focus on: code quality, potential bugs, security issues, and architecture.

      Respond in JSON with this structure:
      {
        "summary": "...",
        "critical_issues": [...],
        "suggestions": [...]
      }
    outputs:
      summary: "{{ response | json | get('summary') }}"
      critical_count: "{{ response | json | get('critical_issues') | length }}"
      suggestions: "{{ response | json | get('suggestions') }}"

  - id: has_critical
    type: route
    eval: "{{ nodes.review.critical_count > 0 }}"
    branches:
      true: fix_issues
      false: create_pr

  - id: fix_issues
    type: prompt
    name: "Fix Critical Issues"
    model: sonnet
    effort: high
    prompt: |
      The code review found these critical issues:
      {{ nodes.review.suggestions }}

      Please fix all critical issues.
    next: run_tests

  - id: run_tests
    type: script
    name: "Run Tests"
    command: "npm test"
    timeout: 120000
    on_error: stop
    next: create_pr

  - id: create_pr
    type: github_pr
    name: "Create Pull Request"
    title: "{{ inputs.feature_description | truncate(70) }}"
    body: |
      ## Summary
      {{ nodes.review.summary }}

      ## Review Notes
      {{ nodes.review.suggestions }}

      ---
      *Auto-generated by Claude Whisperer Sequence*
    target_branch: "{{ inputs.target_branch }}"
    draft: "{{ inputs.draft_pr }}"
    next: notify_team

  - id: notify_team
    type: notify
    name: "Notify Team"
    channel: slack
    preset: pr_created           # Use pre-configured Slack preset
    message: |
      New PR created: {{ nodes.create_pr.url }}
      {{ nodes.review.summary }}
    next: wait_ci

  - id: wait_ci
    type: wait
    name: "Wait for CI"
    condition: "{{ nodes.create_pr.checks_passed }}"
    poll_interval: 60000         # Check every minute
    timeout: 1800000             # 30 min max
    on_timeout: notify_timeout
    on_success: done
    on_failure: notify_failure

  - id: notify_timeout
    type: notify
    channel: system
    message: "CI timed out for PR {{ nodes.create_pr.url }}"

  - id: notify_failure
    type: notify
    channel: system
    message: "CI failed for PR {{ nodes.create_pr.url }}"

  - id: done
    type: notify
    channel: system
    message: "PR ready for review: {{ nodes.create_pr.url }}"
```

### YAML Conventions

- **Node IDs** — snake_case, unique within the sequence
- **Template variables** — `{{ expression }}` syntax (Jinja2-inspired via minijinja)
- **Flow control** — `next` for explicit next node; `branches` for route nodes; falls through to next node in list if not specified
- **Outputs** — Named outputs extracted from node results, available as `{{ nodes.<id>.<output> }}`
- **Timeouts** — In milliseconds, configurable per-node and as defaults
- **Error handling** — `on_error` per-node or in defaults: `stop`, `retry`, `skip`, `goto:<node_id>`
- **Output format** — `output_format: json` on prompt nodes instructs the AI to respond in structured JSON, enabling reliable `json` filter extraction
- **Git isolation** — `isolation` controls how the sequence interacts with the repo's git state:
  - `worktree` — Automatically creates a git worktree for isolation. User's working directory is never touched. Cleanup block should remove the worktree. Best for sequences that modify files.
  - `lock` — Acquires a repo lock. Prevents concurrent sequence + user git operations on the same repo. Second sequence queues until the first finishes.
  - `none` — No protection. Suitable for read-only sequences or sequences that don't do git operations.

### Input Validation

Inputs support optional `validation` rules:

| Type | Validation Options |
|------|-------------------|
| `string` | `min_length`, `max_length`, `pattern` (regex), `enum` (allowed values) |
| `number` | `min`, `max`, `integer` (boolean) |
| `boolean` | *(no additional validation)* |
| `repo_list` | `min_count`, `max_count`, `tags` (filter by repo tags) |

Validation runs before execution starts. Invalid inputs show descriptive error messages in the UI.

### File Storage

All sequences are stored globally. Per-repo sequences are not supported — instead, sequences can be restricted to specific repos via the `repos` field.

```
# All user sequences
~/.config/claude-whisperer/sequences/
├── code-review.yaml
├── feature-pipeline.yaml
└── daily-maintenance.yaml

# Built-in templates (bundled with app, read-only, can be copied to user dir)
<app>/templates/sequences/
├── code-review.yaml
├── code-simplify.yaml
├── feature-pipeline.yaml
└── pr-workflow.yaml
```

### Repo Restrictions

By default, sequences are available to all repos. To restrict a sequence to specific repos, use the `repos` field:

```yaml
# Available to all repos (default — field omitted)
name: "Code Review"

# Restricted to specific repos by name
name: "API Deploy Pipeline"
repos: [API, Backend]            # Only available when these repos are active

# Restricted by repo tags
name: "Frontend Lint Check"
repos: tagged:frontend           # Only repos with the "frontend" tag
```

When `repos` is specified, the sequence only appears in the library and only triggers (for event/schedule triggers) when one of the listed repos is active.

---

## 5. Node Types

### 5.1 Prompt Node

Sends a prompt to an AI model via the existing sidecar/SDK infrastructure. The core node type.

```yaml
- id: analyze
  type: prompt
  name: "Analyze Codebase"

  # Model configuration (overrides sequence defaults)
  model: sonnet                  # haiku | sonnet | opus | auto
  provider: claude               # claude | openai (Codex)
  effort: high                   # off | low | medium | high | max

  # The prompt (supports template variables)
  prompt: |
    Analyze the codebase and identify areas for improvement.
    Focus on: {{ inputs.focus_areas }}

  # Optional system prompt override
  system_prompt: "You are a senior code reviewer..."

  # Optional: instruct AI to respond in structured JSON
  output_format: json

  # Optional images (file paths or URLs)
  images:
    - "{{ repo.path }}/docs/architecture.png"

  # Output extraction (use json filter for structured responses)
  outputs:
    summary: "{{ response | json | get('summary') }}"
    score: "{{ response | json | get('quality_score') }}"

  # Tool access control (see Tool Access section below)
  tools: readonly                # full | readonly | none | [explicit list]

  # MCP servers for this node (see MCP section below)
  mcp_servers: [github, filesystem]

  # Session behavior
  session: new                   # new | continue:<node_id> | shared | note

  # Context window management (for continue/shared sessions)
  on_context_full: new_session   # new_session | error | summarize

  timeout: 300000
```

**Session modes:**
- `new` — Fresh SDK session for this node (default)
- `continue:<node_id>` — Continue the session from a previous prompt node (preserves conversation context)
- `shared` — All prompt nodes with `session: shared` share one session throughout the execution
- `note` — Note mode session (Haiku, no effort, restricted tools: Read/Glob/Grep only). Useful for lightweight summarization or analysis tasks

**Provider support:**
- `claude` — Anthropic Claude via the Claude Agent SDK (default)
- `openai` — OpenAI Codex SDK for code-focused tasks. Uses `Thread`/`runStreamed()` with Codex-specific tool mapping

**Tool access control:**

The `tools` field controls which SDK tools the prompt node can use. This maps to the SDK's `allowedTools` and `settingSources` options.

```yaml
# Presets
tools: full                # All tools (Read, Write, Edit, Bash, Glob, Grep, etc.) — default
tools: readonly            # Read-only: Read, Glob, Grep only. No file writes, no shell.
tools: none                # No tools at all. Pure conversation / text generation.

# Explicit allowlist
tools:
  - Read
  - Glob
  - Grep
  - Bash                   # Include specific tools by name

# Explicit blocklist (everything except these)
tools:
  exclude:
    - Bash                 # Allow everything except Bash
    - Write
```

Presets are shorthand:
| Preset | Allowed Tools | settingSources | Use Case |
|--------|---------------|----------------|----------|
| `full` | All SDK tools | `["user", "project", "local"]` | Implementation, refactoring, code changes |
| `readonly` | `Read`, `Glob`, `Grep` | `[]` | Code review, analysis, summarization |
| `none` | (empty) | `[]` | Classification, text generation, JSON output |

When `session: note` is used, tools default to `readonly` regardless of the `tools` field (note mode enforces read-only).

**MCP server selection:**

The `mcp_servers` field controls which MCP servers are available to this prompt node. MCP server tools are always added to `allowedTools` in addition to the base tools.

```yaml
# Use specific MCP servers by ID (from global config or repo association)
mcp_servers: [github, jira, filesystem]

# Use all enabled MCP servers (default behavior)
mcp_servers: all

# No MCP servers
mcp_servers: none

# Use MCP servers from a specific repo's config
mcp_servers: repo                # Uses the active repo's mcp_servers list
```

When `mcp_servers` is not specified:
- If the node runs in a repo that has `mcp_servers` configured → use that repo's servers
- Otherwise → use all globally enabled MCP servers

MCP tools are auto-allowed via wildcard patterns (`mcp__<server_id>__*`) and the `canUseTool` callback, matching the existing sidecar behavior.

**Context window management:**
For `continue` and `shared` sessions, conversation context grows with each prompt node. The `on_context_full` strategy determines what happens when the context window is exhausted:
- `new_session` — Start a fresh session with a summary of prior context (default)
- `error` — Fail the node
- `summarize` — Use a cheap model (Haiku) to summarize the conversation, then continue in the same session

### 5.2 Route Node

A unified routing node that directs execution to one or more branches. Supports expression-based evaluation and AI-powered classification. Branches are user-definable — default is `true`/`false`, but users can define any set of values (enums).

#### Expression Mode

When `eval` is provided, the expression is evaluated via minijinja and the **stringified result** is matched against branch keys.

```yaml
# Simple true/false (default branches)
- id: tests_pass
  type: route
  eval: "{{ nodes.test.exit_code == 0 }}"
  branches:
    true: create_pr
    false: fix_issues
```

**How eval → branch matching works:**

1. The expression is evaluated: `{{ nodes.test.exit_code == 0 }}` → `true`
2. The result is stringified: boolean `true` → string `"true"`
3. The string is matched against branch keys (case-insensitive)
4. If no match, `default` branch is used; if no default, node fails

This means branch keys for boolean results must be the strings `"true"` and `"false"`. For non-boolean results, the expression should produce a string that matches a key:

```yaml
# Expression producing a string key directly
- id: route_by_score
  type: route
  eval: "{{ 'high' if nodes.review.score > 80 else ('medium' if nodes.review.score > 50 else 'low') }}"
  branches:
    high: auto_merge
    medium: request_review
    low: deep_review
  default: deep_review
```

For multi-select mode, `eval` should produce a comma-separated string or a list:

```yaml
- id: select_checks
  type: route
  multi: true
  eval: "{{ nodes.analyze.required_checks | join(',') }}"
  branches:
    security: security_review
    performance: performance_review
    architecture: architecture_review
```

#### AI Mode

When `prompt` is provided (and no `eval`), an LLM classifies the input into one of the branch keys.

**Automatic context injection:** In AI mode, the **previous node's primary output** is automatically included as context. You don't need to wire it manually. The `context` field is an optional **override** — if specified, it replaces the auto-injected context.

```yaml
# AI with default true/false branches
# (automatically receives the previous node's output as context)
- id: needs_human
  type: route
  model: haiku
  prompt: "Does this code review require human attention?"
  branches:
    true: approval_gate
    false: auto_proceed

# AI with custom enum branches (explicit context override)
- id: classify_issue
  type: route
  model: haiku
  prompt: "What type of work does this issue describe?"
  context: "{{ nodes.read_issue.body }}"    # Override auto-context
  branches:
    bug: fix_bug
    feature: implement_feature
    refactor: plan_refactor
    unclear: ask_human
  default: unclear

# AI with described branches (descriptions guide the AI classifier)
- id: assess_risk
  type: route
  model: haiku
  prompt: "What is the risk level of these changes?"
  branches:
    low:
      description: "Minor changes — typos, formatting, comments"
      next: auto_merge
    medium:
      description: "Moderate changes — new functions, refactors, config changes"
      next: request_review
    high:
      description: "Major changes — architecture, security, database, public API"
      next: approval_gate
  default: medium
```

#### Multi-Select Mode

By default, a route picks exactly **one** branch. With `multi: true`, the route can activate **multiple** branches that run in parallel (or sequentially).

```yaml
# AI picks which review types are needed (one or more)
- id: select_reviews
  type: route
  multi: true
  model: haiku
  prompt: "Which types of review does this PR need?"
  branches:
    security:
      description: "Changes affect auth, crypto, input validation, or data access"
      next: security_review
    performance:
      description: "Changes affect hot paths, database queries, or resource usage"
      next: performance_review
    architecture:
      description: "Changes affect system structure, APIs, or module boundaries"
      next: architecture_review
    docs:
      description: "Changes affect public APIs or user-facing behavior that needs documentation"
      next: docs_review
  min: 1                         # At least 1 branch must be selected
  max: 4                         # At most 4 (optional, defaults to all)
  execution: parallel            # parallel | sequential (how selected branches run)
  next: merge_reviews            # Where to go after all selected branches complete
```

**AI multi-select classification:**
1. System prompt instructs: "Select ALL categories that apply. Respond with a comma-separated list."
2. Response `"security, architecture"` → parsed into `["security", "architecture"]`
3. Matched branches execute in parallel (or sequentially)
4. When all selected branches complete, execution continues to `next`
5. If fewer than `min` branches match, `default` is added; if still under `min`, node fails

**Expression multi-select:** `eval` should produce a comma-separated string or list. Each value is matched against branch keys.

#### Branch Format

Branches support two formats:

```yaml
# Short form — key maps directly to target node ID
branches:
  true: node_a
  false: node_b

# Long form — key has description (for AI guidance) and target
branches:
  approved:
    description: "Changes look good, ready to merge"
    next: merge_pr
  needs_work:
    description: "Issues found that need fixing before merge"
    next: request_changes
  blocked:
    description: "Blocked by external dependency or missing context"
    next: notify_team
```

**Descriptions are optional** but recommended for AI mode — they help the classifier distinguish between branches with nuanced differences. In expression mode, descriptions are ignored.

#### How AI Classification Works

1. Engine builds a system prompt listing branch keys and their descriptions:
   ```
   Classify the following into exactly one of these categories:
   - bug: Issues, errors, or broken behavior
   - feature: New functionality or capabilities
   - refactor: Code restructuring without behavior change
   - unclear: Cannot determine from the description

   Respond with ONLY the category name, nothing else.
   ```
   (For `multi: true`: "Select ALL categories that apply. Respond with a comma-separated list.")
2. The user's `prompt` is sent as the user message, with context appended (auto-injected from previous node, or from explicit `context` override)
3. Response is normalized (lowercased, trimmed) and matched against branch keys
4. If no match, `default` branch is used (if specified)
5. If no match and no default, the node fails with an error

#### Configuration Reference

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `eval` | No | — | Template expression; stringified result matched against branch keys |
| `prompt` | No | — | Natural language question for AI classification |
| `context` | No | Previous node output | Override context for AI mode |
| `model` | No | `haiku` | Model for AI classification |
| `branches` | Yes | — | Map of branch keys to target nodes (short or long form) |
| `default` | No | — | Fallback branch key if no match |
| `multi` | No | `false` | Allow multiple branches to be selected |
| `min` | No | `1` | Minimum selected branches (multi mode only) |
| `max` | No | all | Maximum selected branches (multi mode only) |
| `execution` | No | `parallel` | How multi-selected branches run: `parallel` or `sequential` |

At least one of `eval` or `prompt` must be provided.

### 5.3 Git Nodes

```yaml
# Create branch
- id: branch
  type: git_branch
  branch_name: "feature/{{ inputs.feature_name | slugify }}"
  from: main                     # Base branch (default: current)

# Create worktree
- id: worktree
  type: git_worktree
  branch_name: "feature/{{ inputs.feature_name | slugify }}"
  # worktree_path auto-generated if not specified

# Commit
- id: commit
  type: git_commit
  message: "feat: {{ inputs.feature_name }}"
  add: all                       # all | staged | specific files
  files:                         # Only if add: specific
    - "src/**/*.ts"
    - "tests/**/*.ts"

# Push
- id: push
  type: git_push
  remote: origin
  force: false

# Delete branch
- id: cleanup
  type: git_delete_branch
  branch: "{{ nodes.branch.branch_name }}"
  remote: true                   # Also delete remote branch

# Delete worktree
- id: cleanup_worktree
  type: git_delete_worktree
  path: "{{ nodes.worktree.path }}"
```

### 5.5 GitHub PR Nodes

```yaml
# Create PR
- id: create_pr
  type: github_pr
  title: "{{ inputs.feature_name }}"
  body: |
    ## Summary
    {{ nodes.implement.summary }}
  target_branch: main
  draft: false
  labels: [auto-generated]
  reviewers: []                  # GitHub usernames
  outputs:
    url: "{{ pr.html_url }}"
    number: "{{ pr.number }}"
    checks_passed: "{{ pr.checks_status == 'success' }}"

# Wait for PR status
- id: wait_pr
  type: github_pr_wait
  pr: "{{ nodes.create_pr.number }}"
  wait_for: checks_pass          # checks_pass | review_approved | merged | closed
  poll_interval: 60000
  timeout: 3600000               # 1 hour
  outputs:
    status: "{{ pr.state }}"
    checks: "{{ pr.checks_status }}"

# Merge PR
- id: merge
  type: github_pr_merge
  pr: "{{ nodes.create_pr.number }}"
  method: squash                 # merge | squash | rebase
  delete_branch: true
```

### 5.6 Script Node

Execute shell commands with output capture.

```yaml
- id: run_tests
  type: script
  name: "Run Test Suite"
  command: "npm test"
  cwd: "{{ repo.path }}"        # Defaults to active repo
  timeout: 120000
  env:
    NODE_ENV: test
  outputs:
    exit_code: "{{ result.code }}"
    stdout: "{{ result.stdout }}"
    stderr: "{{ result.stderr }}"
    passed: "{{ result.code == 0 }}"
```

**Security:** Template variables interpolated into `command` are automatically shell-escaped to prevent command injection (see [Section 16: Security Model](#16-security-model)). The `cwd` is restricted to configured repo paths.

### 5.7 Notification Node

Send notifications to various channels. Pre-configured presets for common services + generic webhook for anything else.

```yaml
# Slack (pre-configured)
- id: notify_slack
  type: notify
  channel: slack
  webhook: "{{ secrets.SLACK_WEBHOOK }}"   # Or configured in settings
  message: "PR created: {{ nodes.create_pr.url }}"
  # Optional: failure policy (default: inherited from on_error)
  on_notify_error: warn          # warn (log + continue) | stop | retry
  # Optional rich formatting
  blocks:
    title: "New PR: {{ nodes.create_pr.title }}"
    color: "#36a64f"
    fields:
      - name: Repository
        value: "{{ repo.name }}"
      - name: Author
        value: "{{ user.name }}"

# Discord (pre-configured)
- id: notify_discord
  type: notify
  channel: discord
  webhook: "{{ secrets.DISCORD_WEBHOOK }}"
  message: "Build complete for {{ repo.name }}"
  # Optional embed
  embed:
    title: "Build Report"
    description: "{{ nodes.build.summary }}"
    color: 0x00ff00

# System notification (OS native toast)
- id: notify_system
  type: notify
  channel: system
  title: "Sequence Complete"
  message: "{{ execution.name }} finished in {{ execution.duration | human_duration }}"
  sound: true

# Generic webhook (works with anything)
- id: notify_custom
  type: notify
  channel: webhook
  url: "https://hooks.example.com/endpoint"
  method: POST
  headers:
    Authorization: "Bearer {{ secrets.CUSTOM_TOKEN }}"
  body: |
    {
      "text": "{{ nodes.review.summary }}",
      "repo": "{{ repo.name }}"
    }
```

**Notification failure policy:**

Notifications are often non-critical. The `on_notify_error` field provides a notification-specific failure policy that overrides the node's `on_error`:
- `warn` — Log the failure and continue execution (default for system notifications)
- `stop` — Halt execution (same as `on_error: stop`)
- `retry` — Retry with backoff (same as `on_error: retry`)

### 5.8 Approval Node

Pauses execution and waits for human approval via the app UI.

```yaml
- id: approve_deploy
  type: approval
  name: "Approve Deployment"
  message: |
    Ready to deploy to production.

    Changes:
    {{ nodes.review.summary }}

    Test results: {{ nodes.test.passed ? 'All passed' : 'FAILURES DETECTED' }}

  timeout: 86400000              # 24 hours
  on_timeout: cancel             # cancel | skip | auto_approve

  # Optional notification when approval is needed
  notify:
    channel: slack
    message: "Approval needed: {{ execution.name }}"
```

### 5.9 Wait Node

Pauses execution until a condition is met, with periodic polling.

```yaml
- id: wait_for_deploy
  type: wait
  condition: "{{ nodes.deploy.status == 'healthy' }}"
  poll_interval: 30000           # Check every 30 seconds
  timeout: 600000                # 10 minutes max

  # Optional: run a command to check the condition
  poll_command: "curl -s https://api.example.com/health | jq .status"

  on_timeout: escalate
  on_success: celebrate
```

### 5.10 Transform Node

Data transformation and extraction without AI (fast, free).

```yaml
- id: extract_files
  type: transform
  input: "{{ nodes.review.response }}"
  operations:
    - type: regex
      pattern: "```(?:diff)?\\n([\\s\\S]*?)```"
      output: code_blocks
    - type: json_path
      path: "$.files[*].name"
      output: changed_files
    - type: template
      template: "{{ changed_files | join(', ') }}"
      output: file_list
```

### 5.11 Parallel Node

Run multiple nodes concurrently, wait for all to complete.

```yaml
- id: parallel_checks
  type: parallel
  branches:
    - lint_check
    - type_check
    - test_suite
    - security_scan
  wait: all                      # all | any | N (number of branches)
  on_branch_error: cancel_others # cancel_others | continue | fail_fast
  next: merge_results
```

**Failure semantics:**
- `cancel_others` — When any branch fails, cancel all other running branches and fail the parallel node (default)
- `continue` — Let all branches finish regardless of failures; collect errors and report them all
- `fail_fast` — Immediately fail the parallel node on first branch error; don't wait for others to finish or cancel them

### 5.12 Loop Node

Repeat one or more inline nodes until a condition is met or a `break` is triggered.

```yaml
# Simple loop with until condition (checked after each iteration)
- id: fix_loop
  type: loop
  max_iterations: 5
  until: "{{ loop.test.passed }}"
  on_max_iterations: approval_gate   # Where to go if max reached without break/until
  on_break: create_pr                # Where to go after break (default: next node)
  nodes:
    - id: fix
      type: prompt
      model: sonnet
      prompt: |
        Fix the failing tests. Previous attempt:
        {{ loop.test.stderr | default('First attempt') }}
    - id: test
      type: script
      command: "npm test"

# Loop with route-based break (more control than until)
- id: review_loop
  type: loop
  max_iterations: 3
  nodes:
    - id: review
      type: prompt
      model: haiku
      output_format: json
      prompt: "Review the code quality. Respond with { \"quality\": \"good\" | \"needs_work\" }"
    - id: decide
      type: route
      eval: "{{ loop.review.response | json | get('quality') }}"
      branches:
        good: break              # Special target: exit the loop
        needs_work: continue     # Special target: next iteration
  on_break: ship_it
  on_max_iterations: manual_review

# Single-node loop
- id: poll_deploy
  type: loop
  max_iterations: 20
  until: "{{ loop.check.deploy_status == 'healthy' }}"
  delay: 30000                   # Wait 30s between iterations
  nodes:
    - id: check
      type: http
      method: GET
      url: "https://api.example.com/deploy/status"
```

#### Loop Mechanics

**Iteration flow:**
1. Execute all `nodes` in order (one full pass = one iteration)
2. After each iteration, check `until` condition — if true, exit loop → go to `on_break`
3. If a route node inside the loop targets `break`, exit immediately → go to `on_break`
4. If a route node targets `continue`, skip remaining nodes in this iteration, start next
5. If `max_iterations` reached without break/until, exit → go to `on_max_iterations`
6. Optional `delay` (ms) between iterations

**Loop context variables:**
Inside a loop, node outputs are accessed via `loop.<node_id>` (not `nodes.<node_id>`). This gives access to **the current iteration's** outputs:

```yaml
"{{ loop.test.passed }}"          # Current iteration's test result
"{{ loop.fix.response }}"         # Current iteration's fix response
"{{ loop.iteration }}"            # Current iteration index (0-based)
"{{ loop.iterations_left }}"      # Remaining iterations before max
```

After the loop exits, external nodes can access the **last iteration's** outputs via `nodes.<loop_id>.<inner_node_id>`:

```yaml
"{{ nodes.fix_loop.test.passed }}"   # Last iteration's test result
"{{ nodes.fix_loop.iterations }}"    # Total iterations executed
```

#### Configuration Reference

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `nodes` | Yes | — | Inline node definitions executed each iteration |
| `max_iterations` | Yes | — | Safety limit on iteration count |
| `until` | No | — | Expression checked after each iteration; loop exits when true |
| `delay` | No | `0` | Milliseconds to wait between iterations |
| `on_break` | No | next node | Where to go when loop exits via `break` or `until` |
| `on_max_iterations` | No | error | Where to go when max iterations exhausted |

**Special route targets inside loops:**
- `break` — Exit the loop immediately
- `continue` — Skip to the next iteration

### 5.13 For-Each Node

Iterate over a collection, executing a sub-sequence for each item.

```yaml
- id: update_each_repo
  type: for_each
  items: "{{ inputs.repos }}"
  variable: current_item         # Variable name for the current item
  mode: sequential               # sequential | parallel
  max_parallel: 3                # Only for parallel mode; limits concurrency
  on_item_error: continue        # continue | stop (stop halts the loop)
  nodes:
    - id: update
      type: prompt
      repo: "{{ current_item.path }}"
      prompt: "Update dependencies and fix breaking changes"
    - id: test
      type: script
      cwd: "{{ current_item.path }}"
      command: "npm test"
  outputs:
    results: "{{ items_results }}"     # Array of per-item results
    failed_count: "{{ items_failed }}" # Number of items that errored
```

**Variable scoping:**
- `current_item` (or whatever `variable` is set to) is available inside the loop's `nodes`
- `items_results` is an array of result objects (one per item) available after the for-each completes
- `items_failed` is the count of items that errored
- Each iteration's node outputs are namespaced: `{{ nodes.update_each_repo.results[0].update.response }}`

### 5.14 Sub-Sequence Node

Run another sequence as a step, enabling composability.

```yaml
- id: review_step
  type: sub_sequence
  sequence: code-review          # Reference by name or ID
  inputs:
    focus_areas: "security, performance"
  outputs:
    review_summary: "{{ result.summary }}"
```

### 5.15 Delay Node

Simple timer pause.

```yaml
- id: cooldown
  type: delay
  duration: 60000                # 1 minute
  message: "Waiting for deployment to stabilize..."
```

### 5.16 File Node

Read, write, or copy files with template variable support. For file operations that don't need AI.

```yaml
# Read a file
- id: read_config
  type: file
  operation: read                # read | write | copy | append
  path: "{{ repo.path }}/package.json"
  outputs:
    content: "{{ file.content }}"
    exists: "{{ file.exists }}"

# Write a file (with template interpolation)
- id: write_changelog
  type: file
  operation: write
  path: "{{ repo.path }}/CHANGELOG.md"
  content: |
    ## {{ inputs.version }}
    {{ nodes.summarize.changelog }}

# Copy a file
- id: backup_config
  type: file
  operation: copy
  source: "{{ repo.path }}/config.json"
  destination: "{{ repo.path }}/config.json.bak"
```

**Security:** File paths are validated to be within configured repo paths. No access to system directories or paths outside the repo (see [Section 16](#16-security-model)).

### 5.17 HTTP Request Node

Generic HTTP requests for REST APIs, webhooks, or service integrations.

```yaml
- id: check_deploy_status
  type: http
  method: GET                    # GET | POST | PUT | PATCH | DELETE
  url: "https://api.example.com/deploys/{{ nodes.deploy.id }}"
  headers:
    Authorization: "Bearer {{ secrets.DEPLOY_TOKEN }}"
    Accept: application/json
  timeout: 30000
  outputs:
    status_code: "{{ http.status }}"
    body: "{{ http.body }}"
    deploy_status: "{{ http.body | json | get('status') }}"

---

# POST with body
- id: trigger_deploy
  type: http
  method: POST
  url: "https://api.example.com/deploys"
  headers:
    Authorization: "Bearer {{ secrets.DEPLOY_TOKEN }}"
    Content-Type: application/json
  body: |
    {
      "ref": "{{ repo.branch }}",
      "environment": "staging"
    }
  expected_status: [200, 201]    # Fail if status not in list (optional)
```

### 5.18 Cleanup Block

A special section at the sequence level that **always runs** after execution completes, whether it succeeded, failed, or was cancelled. Used for resource cleanup.

```yaml
# Defined at the sequence top level, alongside nodes:
cleanup:
  - id: remove_worktree
    type: git_delete_worktree
    path: "{{ nodes.worktree.path }}"
    condition: "{{ nodes.worktree.path }}"   # Only run if the worktree was created

  - id: close_session
    type: notify
    channel: system
    message: "Sequence {{ execution.status }}: {{ execution.name }}"
```

**Behavior:**
- Cleanup nodes execute sequentially in order
- Cleanup nodes have access to the full execution context (all previous node outputs)
- A `condition` field can gate cleanup nodes (skip if the resource was never created)
- Cleanup node failures are logged but don't change the execution's final status
- Cleanup runs even when an execution is cancelled or fails

---

## 6. Execution Engine

### Lifecycle

```
                    ┌──────────┐
           ┌───────│ Scheduled │
           │       └──────────┘
           │
           v
┌──────────────────┐      ┌─────────────┐
│   Initializing   │─────>│   Running    │
└──────────────────┘      └──────┬──────┘
                                 │
                    ┌────────────┼────────────┐
                    │            │             │
                    v            v             v
             ┌──────────┐ ┌──────────┐ ┌────────────┐
             │  Paused   │ │ Waiting  │ │  Failed    │
             │ (manual)  │ │(approval/│ │  (error)   │
             └─────┬─────┘ │ timer)   │ └──────┬─────┘
                   │       └────┬─────┘        │
                   │            │               │
                   v            v               v
              ┌─────────────────────┐    ┌──────────┐
              │     Running         │──> │Completed │
              └─────────────────────┘    └──────────┘
                         │                     │
                         v                     v
                    ┌──────────────────────────────┐
                    │  Cleanup (always runs)         │
                    └──────────────────────────────┘
```

### Execution State

```rust
pub struct SequenceExecution {
    pub id: String,
    pub sequence_id: String,
    pub sequence_version: u32,

    // Snapshot of the sequence definition at start time (for version safety)
    pub sequence_snapshot: SequenceDefinition,

    // Timing
    pub started_at: u64,
    pub completed_at: Option<u64>,
    pub paused_at: Option<u64>,

    // Status
    pub status: ExecutionStatus,
    pub current_node_id: Option<String>,

    // State
    pub context: ExecutionContext,       // Template variables + node outputs
    pub node_results: HashMap<String, NodeResult>,
    pub session_ids: HashMap<String, String>,  // Node ID -> SDK session ID

    // Inputs (user-provided at start)
    pub inputs: HashMap<String, serde_json::Value>,

    // Tracking
    pub total_tokens: TokenUsage,
    pub total_cost: f64,
    pub log: Vec<LogEntry>,

    // Error state
    pub error: Option<ExecutionError>,

    // Idempotency tracking (for recovery — see Recovery section)
    pub completed_node_ids: HashSet<String>,
}

pub enum ExecutionStatus {
    Initializing,
    Running,
    Paused,
    WaitingForApproval { node_id: String },
    WaitingForCondition { node_id: String },
    Completed,
    Failed,
    Cancelled,
    CleaningUp,   // Running cleanup block
}
```

### Node Execution Flow

For each node:

1. **Check idempotency** — If `completed_node_ids` contains this node (recovery scenario), skip re-execution for idempotent nodes or apply idempotency strategy
2. **Resolve templates** — Replace all `{{ }}` expressions with values from context (single-pass, no recursive evaluation)
3. **Check preconditions** — Verify required inputs are available
4. **Emit `sequence-node-start`** — Frontend updates UI
5. **Execute node logic** — Dispatch to node-specific handler
6. **Capture outputs** — Store named outputs in execution context
7. **Mark completed** — Add node ID to `completed_node_ids`
8. **Track usage** — Accumulate tokens, cost, duration
9. **Emit `sequence-node-complete`** — Frontend updates UI
10. **Determine next node** — Follow `next`, `then`/`else`, or fall through
11. **Handle errors** — Apply `on_error` strategy (stop/retry/skip/goto)

### Prompt Node Execution Detail

Prompt nodes reuse the existing sidecar infrastructure:

1. Create (or reuse) an SDK session via `create_sdk_session` (supports both Claude and Codex providers)
2. Send the resolved prompt via `send_sdk_prompt`
3. Collect streaming events (`sdk-text-{id}`, `sdk-tool-*-{id}`, etc.)
4. Wait for `sdk-done-{id}` or `sdk-error-{id}`
5. Extract the final text response as the node output
6. Record usage from `sdk-usage-{id}`

The engine subscribes to the same Tauri events the frontend uses, so the frontend can optionally show the live streaming output of the current node.

### Error Handling

```yaml
# Per-node error strategies
on_error: stop          # Halt the entire sequence (default)
on_error: retry         # Retry the node (respects retry_count, retry_delay)
on_error: skip          # Skip this node, continue to next
on_error: goto:fallback # Jump to a specific node

# Retry configuration
retry_count: 3
retry_delay: 5000       # ms between retries
retry_backoff: exponential  # linear | exponential
```

### Cancellation & Cleanup

When an execution is cancelled (user action, timeout, or error with `on_error: stop`), the engine performs ordered cleanup:

1. **In-flight prompt nodes** — Interrupt the SDK session via `queryIterator.interrupt()` (same mechanism used by the existing sidecar)
2. **In-flight script nodes** — Kill the process group (SIGTERM, then SIGKILL after 5s)
3. **Active polling loops** (wait/approval nodes) — Cancel the polling task
4. **In-flight HTTP requests** — Abort via request cancellation token
5. **Parallel node branches** — Cancel all active branches
6. **Run cleanup block** — Execute the sequence's `cleanup` section (if any)
7. **Close SDK sessions** — Clean up any sessions created during execution

Git operations (commits, branches, pushes) and GitHub operations (PRs) that have already completed are **not rolled back** — they are inherently difficult to reverse safely. The cleanup block should be used for explicit resource cleanup (deleting worktrees, temporary branches, etc.).

### Recovery & Idempotency

On app restart, the engine recovers in-progress executions:

1. Load execution index
2. For each execution with status `running` or `waiting`:
   - Load full snapshot (includes the `sequence_snapshot` so definition changes don't affect in-progress executions)
   - Check `completed_node_ids` to determine which nodes finished

3. **Per-node idempotency strategy:**

| Node Type | On Re-Run | Strategy |
|-----------|-----------|----------|
| `prompt` | Always re-run | AI responses aren't deterministic; re-running is safe |
| `script` | Always re-run | Side effects unknown; safest to re-run |
| `git_commit` | Check HEAD | If HEAD commit message matches, skip; otherwise re-run |
| `git_branch` | Check existence | If branch exists, skip creation and reuse |
| `git_push` | Always re-run | Push is idempotent |
| `github_pr` | Check existence | If PR already exists for this branch, reuse it |
| `notify` | Always re-run | Duplicate notifications are acceptable |
| `approval` | Restore prompt | Show the approval UI again |
| `wait` | Restart polling | Resume polling from where it left off |
| `file` | Always re-run | File writes are idempotent |
| `http` | Always re-run | Depends on endpoint; generally safe |

4. Emit events so the UI reflects the restored state

### Rate Limiting

Multiple prompt nodes executing in quick succession (especially in `parallel` or `for_each` nodes) can hit API rate limits. The execution engine applies backpressure:

- **Global concurrency limit** — Maximum number of concurrent prompt nodes across all executions (default: 3)
- **Per-provider rate limiting** — Track requests per minute per provider (Claude, Codex); pause execution when approaching limits
- **Retry on 429** — When a rate limit response is received, automatically retry with the `Retry-After` delay
- **Parallel node awareness** — Parallel branches with prompt nodes are staggered slightly (100ms between starts) to avoid burst requests

### Dry-Run Mode

Validate a sequence without executing it:

```
validate_sequence(definition) -> ValidationResult
```

Dry-run performs:
1. **YAML parsing** — Syntax validation
2. **Node type validation** — All node types exist
3. **Connection validation** — All `next`, `then`, `else`, `goto` targets exist
4. **Template validation** — All `{{ }}` expressions parse correctly
5. **Variable reachability** — Template variables reference nodes that execute before them
6. **Required field check** — All required fields per node type are present
7. **Input completeness** — All required inputs are defined
8. **Cycle detection** — No infinite loops in node connections (loops must use the `loop` node type)

Returns warnings and errors with line numbers referencing the YAML source.

### Concurrency

- **Single execution per sequence** by default (prevent conflicting git operations)
- **Configurable** — `max_concurrent_executions: N` in sequence definition
- **Parallel nodes** within an execution run on separate tokio tasks
- **Shared sessions** are serialized (one prompt at a time)

---

## 7. Templating & Context System

### Template Engine

The template engine uses **minijinja** (`minijinja` Rust crate) — a minimal, sandboxed Jinja2 implementation for Rust. Chosen for:

- **Jinja2 syntax** — `{{ expression }}` is familiar to developers and AI models alike
- **Sandboxed** — No filesystem access, no arbitrary code execution
- **Fast** — Compiled templates, minimal overhead
- **Custom filters** — Easy to add domain-specific filters
- **Good error messages** — Helpful diagnostics when templates fail to parse or evaluate

### Template Syntax

```yaml
# Variable access
"{{ inputs.feature_name }}"
"{{ nodes.review.summary }}"
"{{ repo.name }}"

# Filters (pipe syntax)
"{{ nodes.review.summary | truncate(100) }}"
"{{ inputs.feature_name | slugify }}"
"{{ nodes.test.duration | human_duration }}"
"{{ nodes.review.files | join(', ') }}"
"{{ nodes.review.response | json | get('score') }}"
"{{ nodes.review.critical_count | default(0) }}"

# Expressions
"{{ nodes.test.exit_code == 0 }}"
"{{ nodes.review.score > 80 }}"
"{{ nodes.review.critical_count > 0 and not inputs.force }}"

# Ternary
"{{ nodes.test.passed ? 'All tests passed' : 'Tests failed' }}"
```

### Template Safety: Single-Pass Evaluation

Templates are evaluated in a **single pass** — node outputs stored in the context are treated as raw strings, never re-processed through the template engine. This prevents template injection:

```
# If a node's response contains "{{ secrets.SLACK_WEBHOOK }}", it is stored
# and displayed as the literal string "{{ secrets.SLACK_WEBHOOK }}" —
# it is NOT resolved to the actual secret value.
```

### Structured Output & the `json` Filter

For reliable data extraction from AI responses, prompt nodes should use `output_format: json` and the `json` filter:

```yaml
- id: review
  type: prompt
  output_format: json            # Instructs AI to respond in valid JSON
  prompt: |
    Review changes. Respond in JSON:
    { "score": <number>, "issues": [...], "summary": "..." }
  outputs:
    score: "{{ response | json | get('score') }}"
    issues: "{{ response | json | get('issues') }}"
```

**How it works:**
1. `output_format: json` appends an instruction to the prompt telling the AI to respond with only valid JSON (no markdown fences, no preamble)
2. The `json` filter parses the response string into a structured object
3. The `get(key)` filter performs a JSON path lookup on the parsed object
4. If JSON parsing fails, the filter returns an error and the node fails with a descriptive message

This is deterministic, instant, and free — no hidden LLM calls. For unstructured responses, use the `regex` filter or `transform` nodes instead.

### Built-in Context Variables

```yaml
# Repo context (resolved at execution time)
repo.path             # Absolute path to repo
repo.name             # Repo display name
repo.branch           # Current git branch
repo.description      # LLM-generated description (if available)

# Execution context
execution.id          # Execution ID
execution.name        # Sequence name
execution.started_at  # ISO timestamp
execution.duration    # Elapsed ms
execution.status      # Current status

# User context
user.name             # OS username

# Node outputs (per-node)
nodes.<id>.response   # Full text response (prompt nodes)
nodes.<id>.output     # Primary output (all nodes)
nodes.<id>.duration   # Node execution time
nodes.<id>.cost       # Token cost
nodes.<id>.<output>   # Named outputs

# Secrets (from settings, never logged, never stored in snapshots)
secrets.SLACK_WEBHOOK
secrets.DISCORD_WEBHOOK
secrets.GITHUB_TOKEN
```

### Built-in Filters

| Filter | Description | Example |
|--------|-------------|---------|
| `truncate(n)` | Truncate to N characters | `{{ summary \| truncate(70) }}` |
| `slugify` | URL-safe slug | `{{ name \| slugify }}` → `my-feature` |
| `upper` / `lower` | Case transform | `{{ status \| upper }}` |
| `join(sep)` | Join array | `{{ files \| join(', ') }}` |
| `length` | Array/string length | `{{ items \| length }}` |
| `default(val)` | Default if empty | `{{ score \| default(0) }}` |
| `json` | Parse string as JSON object | `{{ response \| json }}` |
| `get(key)` | Get key from JSON object | `{{ obj \| get('score') }}` |
| `regex(pattern)` | Extract first regex match | `{{ text \| regex('\\d+') }}` |
| `human_duration` | Format ms as "2m 30s" | `{{ duration \| human_duration }}` |
| `first` / `last` | First/last array element | `{{ items \| first }}` |
| `trim` | Trim whitespace | `{{ text \| trim }}` |
| `shell_escape` | Escape for shell interpolation | `{{ value \| shell_escape }}` |

---

## 8. Notification System

### Architecture

Notifications are handled by the `notify` node type. Pre-configured channels have built-in formatting; the generic webhook handles everything else.

### Channel Configuration (in Settings)

```yaml
# In app config (settings → Sequences → Notifications)
notifications:
  channels:
    - id: slack_team
      type: slack
      name: "Team Slack"
      webhook_url: "https://hooks.slack.com/services/..."
      default_channel: "#dev"

    - id: discord_alerts
      type: discord
      name: "Discord Alerts"
      webhook_url: "https://discord.com/api/webhooks/..."

    - id: custom_webhook
      type: webhook
      name: "PagerDuty"
      url: "https://events.pagerduty.com/v2/enqueue"
      method: POST
      headers:
        Content-Type: application/json
      body_template: |
        {
          "routing_key": "{{ secrets.PD_KEY }}",
          "event_action": "trigger",
          "payload": {
            "summary": "{{ message }}",
            "source": "claude-whisperer"
          }
        }
```

### Pre-configured Channels

| Channel | Transport | Rich Formatting | Setup |
|---------|-----------|-----------------|-------|
| **Slack** | Webhook POST | Blocks, attachments, colors, fields | Webhook URL |
| **Discord** | Webhook POST | Embeds, colors, fields | Webhook URL |
| **System** | OS native notification | Title + body + sound | None (built-in) |
| **Webhook** | HTTP request | Custom body template | URL + method + headers |

### Using Notifications in Sequences

```yaml
# Simple — reference channel by ID from settings
- id: notify
  type: notify
  channel: slack_team            # Configured channel ID
  message: "Build complete!"

# Inline — configure directly (useful for generic webhooks)
- id: notify
  type: notify
  channel: webhook
  url: "https://api.example.com/notify"
  method: POST
  body: '{"text": "{{ execution.name }} completed"}'
```

---

## 9. Triggers & Scheduling

### Trigger Types

#### Manual (default)
User explicitly runs the sequence via UI or voice command.

#### Scheduled (cron)
```yaml
triggers:
  - type: schedule
    cron: "0 9 * * 1-5"         # Weekdays at 9 AM
    timezone: "America/New_York"
    inputs:                      # Default inputs for scheduled runs
      target_branch: main
```

#### Event-based
Internal app events — session lifecycle, sequence completion, recordings. No external incoming webhooks.

##### Session End Trigger

Fires when a session ends (query completes or terminal closes). Supports filtering by session mode, provider, model, repo, and status.

The app has three SDK session modes:
- **Execute** — Standard mode. Claude/Codex runs with full tool access.
- **Plan** — Planning mode. Claude proposes a plan via `ask_planning_questions` / `complete_planning` MCP tools.
- **Note** — Lightweight mode. Haiku with restricted tools (Read/Glob/Grep only).

Plus PTY sessions (Interactive/Prompt terminal mode) and Sequence sub-sessions.

```yaml
triggers:
  # After any execute-mode session with Claude completes
  - type: session_end
    filter:
      mode: execute              # execute | plan | note | pty | any (default: any)
      provider: claude           # claude | openai | any (default: any)
      status: completed          # completed | error | any (default: completed)
    inputs:
      session_id: "{{ event.session_id }}"
      prompt: "{{ event.prompt }}"

  # After any Opus session — run a cheap review to check for over-engineering
  - type: session_end
    filter:
      mode: execute
      model: opus                # Specific model ID
    inputs:
      session_id: "{{ event.session_id }}"

  # After any Codex session — run lint check
  - type: session_end
    filter:
      provider: openai
    inputs:
      repo_path: "{{ event.repo_path }}"

  # After any session in the API repo — auto-run tests
  - type: session_end
    filter:
      repo: API                  # Match repo by name
    inputs:
      repo_path: "{{ event.repo_path }}"

  # After any errored session — notify
  - type: session_end
    filter:
      status: error
    inputs:
      error_message: "{{ event.error }}"
      session_name: "{{ event.session_name }}"

  # After any note session — save the note to a file
  - type: session_end
    filter:
      mode: note
    inputs:
      note_content: "{{ event.last_response }}"

  # After any plan-mode session — start executing the plan
  - type: session_end
    filter:
      mode: plan
      status: completed
    inputs:
      plan_summary: "{{ event.plan_summary }}"
      plan_file: "{{ event.plan_file_path }}"
      feature_name: "{{ event.feature_name }}"
```

**Filter fields:**

| Field | Values | Default | Description |
|-------|--------|---------|-------------|
| `mode` | `sdk`, `execute`, `plan`, `note`, `pty`, `any` | `any` | Session mode filter (see below) |
| `provider` | `claude`, `openai`, `any` | `any` | SDK provider (Claude vs Codex) |
| `model` | Model ID or `any` | `any` | Specific model (e.g., `opus`, `sonnet`, `haiku`, `o3`, `gpt-4.1`) |
| `repo` | Repo name or `any` | `any` | Repo the session ran in |
| `status` | `completed`, `error`, `any` | `completed` | Session end status |

**Mode hierarchy:**
- `any` — All session types
- `sdk` — Any SDK session (shorthand for execute + plan + note)
  - `execute` — Standard SDK sessions with full tool access
  - `plan` — Plan mode sessions (propose-then-execute flow)
  - `note` — Note mode sessions (Haiku, restricted tools)
- `pty` — PTY terminal sessions (Interactive or Prompt mode)

All filter fields are optional. Omitted fields default to `any`. Multiple filters are AND-ed together.

**Additional condition:** An optional `condition` expression for fine-grained filtering beyond what the declarative filters support:

```yaml
  - type: session_end
    filter:
      mode: execute
    condition: "{{ event.cost > 0.50 }}"   # Only trigger for expensive sessions
```

**Event context variables** (available in `condition` and `inputs`):

```yaml
# Session identity
event.session_id        # Session ID
event.session_name      # AI-generated or user-given name
event.mode              # execute | plan | note | pty
event.provider          # claude | openai
event.model             # Model ID used

# Status
event.status            # completed | error
event.error             # Error message (if status == error)

# Repository
event.repo_path         # Repo absolute path
event.repo_name         # Repo display name

# Usage
event.cost              # Total cost in dollars
event.tokens_in         # Input tokens
event.tokens_out        # Output tokens
event.duration          # Duration in ms

# Content
event.prompt            # First user prompt text
event.last_response     # Last assistant response text (truncated to 10k chars)
event.message_count     # Total messages in the session

# Plan mode specific
event.plan_summary      # Plan summary (if mode == plan)
event.plan_file_path    # Path to plan file (if mode == plan)
event.feature_name      # Feature name from planning (if mode == plan)

# Note mode specific
event.effort_level      # Effort level used (off | low | medium | high | max)
```

##### Sequence End Trigger

Fires when another sequence execution completes.

```yaml
triggers:
  - type: sequence_end
    filter:
      sequence: "Code Review"   # Sequence name or any
      status: completed          # completed | failed | any
    inputs:
      review_summary: "{{ event.context.nodes.review.summary }}"
```

**Event context:** Full execution context from the completed sequence, including all node outputs.

##### Recording Trigger

Fires when a voice recording is transcribed (before it becomes a session).

```yaml
triggers:
  - type: recording_end
    condition: "{{ 'deploy' in event.transcript }}"  # Only if transcript mentions deploy
    inputs:
      transcript: "{{ event.transcript }}"
      audio_duration: "{{ event.duration }}"
```

##### App Start Trigger

Fires once when the app launches. Useful for initialization or daily checks.

```yaml
triggers:
  - type: app_start
    # Optional: only once per day (skip if already ran today)
    once_per_day: true
```

##### Trigger Guards

Triggers include built-in guards to prevent runaway loops:

- **Cooldown** — `cooldown: 60000` prevents re-triggering within N ms (default: 0)
- **Max per day** — `max_per_day: 10` limits daily trigger count (default: unlimited)
- **Self-exclusion** — A sequence's own sub-sessions never trigger its own `session_end` trigger (prevents infinite loops)
- **Sequence sub-sessions excluded by default** — Sessions created by prompt nodes within sequences are excluded from `session_end` triggers unless the trigger explicitly adds `include_sequence_sessions: true`

### Scheduler Implementation

The scheduler runs as a background tokio task in the Rust backend:

1. On app startup, load all sequences with schedule triggers
2. Calculate next execution time for each
3. Sleep until next trigger
4. When triggered:
   - Create execution with default inputs
   - Run via the normal execution engine
   - Emit events so UI can show the execution
5. Recalculate next execution time
6. Persist last-run timestamps for reliability

Scheduled executions are marked differently in the UI (clock icon vs. play icon).

---

## 10. Scoping & Multi-Repo Support

### All Sequences Are Global

All sequences are stored in a single global location (`~/.config/claude-whisperer/sequences/`). There are no per-repo sequence directories. This keeps things simple — one library, one place to manage.

Sequences are **available to all repos by default**. To restrict a sequence to specific repos, use the `repos` field in the YAML definition (see [Section 4: Repo Restrictions](#repo-restrictions)).

| Storage | Location | Visibility |
|---------|----------|------------|
| **User sequences** | `~/.config/claude-whisperer/sequences/` | Always available (or filtered by `repos` field) |
| **Built-in templates** | Bundled with app | Always available (read-only, can be copied to user dir) |

### Repo-Portable Sequences

Sequences should use `{{ repo.path }}` and `{{ repo.name }}` instead of hardcoded paths. This makes any sequence work with any repo:

```yaml
# GOOD — works with any repo
- id: review
  type: prompt
  prompt: "Review changes in {{ repo.path }}"

# BAD — hardcoded to one repo
- id: review
  type: prompt
  prompt: "Review changes in /home/user/myproject"
```

### Multi-Repo Sequences

For sequences that operate across multiple repos (e.g., monorepo sync, cross-project dependency updates):

```yaml
name: "Cross-Repo Dependency Update"

inputs:
  - name: repos
    type: repo_list              # Special input type — shows repo picker (multi-select)
    description: "Which repos to update?"
    default: all                 # all | tagged:frontend | specific list

nodes:
  - id: update_each
    type: for_each
    items: "{{ inputs.repos }}"
    variable: current_repo
    nodes:
      - id: update
        type: prompt
        repo: "{{ current_repo.path }}"
        prompt: "Update dependencies and fix breaking changes"
      - id: test
        type: script
        cwd: "{{ current_repo.path }}"
        command: "npm test"
```

### Repo Tags

Repos can be tagged in settings for group operations:

```yaml
# In repo config
repos:
  - path: /projects/frontend
    name: Frontend
    tags: [frontend, web]
  - path: /projects/api
    name: API
    tags: [backend, api]
  - path: /projects/shared
    name: Shared Libs
    tags: [shared, frontend, backend]
```

Then in sequences: `repos: tagged:frontend` selects all repos with the `frontend` tag.

---

## 11. Visual Editor

### Design Approach

The visual editor is the **primary in-app editing interface**. There is no in-app YAML text editor — users who prefer editing YAML directly can click "Open in Editor" to open the file in their system editor (VS Code, etc.).

The canvas reads from YAML on load and writes to YAML on save. Changes in the canvas are saved to the YAML file when the user saves or when the sequence is run.

```
┌─────────────────────────────────────────────────────────────┐
│  Sequence Editor                             [Open in Editor]│
│  ┌──────────────────────────────────┐ ┌──────────────────┐  │
│  │        Node Canvas               │ │  Node Inspector  │  │
│  │                                  │ │                  │  │
│  │   ┌──────────┐                   │ │  Name: Review    │  │
│  │   │ Review   │──┐               │ │  Type: prompt    │  │
│  │   │ (prompt) │  │               │ │  Model: haiku    │  │
│  │   └──────────┘  │               │ │  Tools: readonly │  │
│  │                  ▼               │ │                  │  │
│  │           ┌──────────┐          │ │  Prompt:         │  │
│  │           │ Critical? │          │ │  ┌────────────┐  │  │
│  │           │ (route)  │          │ │  │ Review the │  │  │
│  │           └──┬────┬──┘          │ │  │ latest...  │  │  │
│  │          yes │    │ no          │ │  └────────────┘  │  │
│  │              ▼    ▼             │ │                  │  │
│  │   ┌──────┐  ┌──────────┐      │ │  MCP: [github]   │  │
│  │   │ Fix  │  │ Create PR│      │ │                  │  │
│  │   └──┬───┘  └────┬─────┘      │ │  [Delete Node]   │  │
│  │      │            │             │ │                  │  │
│  │      ▼            ▼             │ │                  │  │
│  │   ┌──────┐  ┌──────────┐      │ │                  │  │
│  │   │ Test │  │ Notify   │      │ │                  │  │
│  │   └──────┘  └──────────┘      │ │                  │  │
│  │                                  │ │                  │  │
│  │  [+ Add Node]                   │ │                  │  │
│  └──────────────────────────────────┘ └──────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Canvas Features

- **Drag-and-drop** nodes from a palette
- **Connect** nodes by dragging from output port to input port
- **Select node** to edit its configuration in the inspector panel
- **Zoom & pan** for large sequences
- **Mini-map** for navigation
- **Color-coded** node types (prompt=blue, route=yellow, git=green, notify=purple, etc.)
- **Status overlay** during execution (pending/running/complete/error per node)
- **"Open in Editor"** button — opens the YAML file in the user's system editor for manual editing

### Node Palette

```
┌─ AI ──────────────────────┐
│  📝 Prompt                │
│  🔄 Loop (AI-driven)     │
├─ Control Flow ────────────┤
│  🔀 Route / Fork         │
│  ⏸️ Approval Gate        │
│  ⏳ Wait / Poll           │
│  ⏰ Delay                │
│  🔁 Loop                 │
│  ║║ Parallel             │
│  📊 For Each             │
│  📦 Sub-Sequence         │
├─ Git ─────────────────────┤
│  🌿 Create Branch        │
│  🌲 Create Worktree      │
│  💾 Commit               │
│  📤 Push                 │
│  🗑️ Delete Branch       │
├─ GitHub ──────────────────┤
│  📋 Create PR            │
│  ⏳ Wait for PR          │
│  🔀 Merge PR            │
├─ Actions ─────────────────┤
│  ⚙️ Run Script           │
│  🌐 HTTP Request         │
│  📁 File Operation       │
│  🔔 Notify              │
│  🔄 Transform           │
└───────────────────────────┘
```

### Technology

Use an existing Svelte-compatible canvas library:

**@xyflow/svelte** (Svelte Flow) — Port of React Flow, battle-tested. Large community, good docs, handles edge routing, minimap, controls.

---

## 12. AI Workflow Generation

### Three Levels of AI Assistance

#### Level 1: Full Generation

User describes the workflow in natural language (voice or text), AI generates the complete YAML.

```
User: "Create a sequence that reviews my code, runs tests, and if
       everything passes, creates a PR and notifies the team on Slack"

AI generates → code-review-pr.yaml (complete, ready to use)
```

**Implementation:**
- Send description to LLM (Gemini/OpenAI via existing LLM integration layer)
- System prompt includes the YAML schema, all node types, and examples
- Generated YAML is parsed, validated (via dry-run), and opened in the visual editor for review
- User can run immediately or edit first

#### Level 2: Template + Customize

AI suggests a template based on the description, pre-filling what it can and leaving placeholders for what it can't.

```
User: "I need a deploy pipeline"

AI suggests → deploy-pipeline.yaml template with:
  - Pre-filled: test node, branch node, PR node, notify node
  - Placeholders: {{ FILL: test command }}, {{ FILL: deploy target }}
  - User fills in blanks via the visual editor inspector
```

#### Level 3: Inline Node Assist

While editing in the visual editor, AI helps with individual nodes:

- **Prompt authoring** — "Write a prompt for code review focusing on security"
- **Route generation** — "What branches should I check after the test node?"
- **Template help** — "How do I reference the PR URL from the create_pr node?"

### AI Generation Architecture

```
┌──────────────────────────────────────────────┐
│  User Input (voice/text)                      │
│  "review code, test, create PR, notify"       │
└──────────────┬───────────────────────────────┘
               │
               v
┌──────────────────────────────────────────────┐
│  LLM Integration Layer (existing)             │
│  Provider: Gemini / OpenAI / Groq / Local     │
│                                               │
│  System Prompt:                               │
│  - YAML schema definition                     │
│  - All node types with examples               │
│  - Available repos + descriptions             │
│  - Configured notification channels           │
│  - Template variable reference                │
└──────────────┬───────────────────────────────┘
               │
               v
┌──────────────────────────────────────────────┐
│  Validation Layer (dry-run)                   │
│  - Parse YAML                                 │
│  - Validate node types exist                  │
│  - Verify template variables are resolvable   │
│  - Check for missing required fields          │
│  - Warn about potential issues                │
└──────────────┬───────────────────────────────┘
               │
               v
┌──────────────────────────────────────────────┐
│  Visual Editor (for review + edit)            │
│  - AI-generated YAML opened in canvas editor  │
│  - Highlighted placeholders if any            │
│  - User reviews, edits, saves                 │
└──────────────────────────────────────────────┘
```

### Prompt Engineering for Generation

The system prompt for AI generation includes:

```
You are a workflow generator for Claude Whisperer Sequences.
Generate YAML workflow definitions based on user descriptions.

## Available Node Types
[full schema for each node type with examples]

## Available Context Variables
[repo.*, execution.*, nodes.*, inputs.*, secrets.*]

## Available Notification Channels
[list from user's configured channels]

## Available Repositories
[list with descriptions from user's config]

## Rules
- Use {{ template }} syntax for dynamic values
- Prefer repo-portable variables over hardcoded paths
- Use appropriate models: haiku for classification, sonnet for coding, opus for complex tasks
- Use appropriate effort levels: off for simple, medium for typical, high for complex, max for hardest
- Use output_format: json with json/get filters for structured extraction
- Include error handling for critical nodes
- Add notifications for key state changes
- Use descriptive node IDs and names
- Include a cleanup block for any resources that need cleanup (worktrees, temp branches)
```

---

## 13. Persistence & State Management

### Sequence Definitions

Stored as YAML files in the filesystem (global and per-repo locations). Indexed in memory on app startup.

### Execution State

Stored in a dedicated directory, one JSON file per execution:

```
~/.config/claude-whisperer/sequences/executions/
├── exec_abc123.json      # Active execution
├── exec_def456.json      # Completed execution (kept for history)
└── index.json            # Execution index for quick listing
```

### Execution Snapshots

The engine saves a snapshot after each node completes:

```json
{
  "id": "exec_abc123",
  "sequence_id": "code-review",
  "sequence_version": 1,
  "status": "waiting_for_approval",
  "current_node_id": "approve_deploy",
  "started_at": 1708531200000,
  "completed_node_ids": ["review", "create_pr"],
  "node_results": {
    "review": {
      "status": "completed",
      "output": "...",
      "duration": 2300,
      "cost": 0.003
    },
    "create_pr": {
      "status": "completed",
      "output": { "url": "...", "number": 42 },
      "duration": 1200,
      "cost": 0.0
    }
  },
  "context": {
    "inputs": { "feature_name": "auth refactor" },
    "nodes": { "review": { "summary": "..." } }
  },
  "session_ids": {
    "review": "sdk_session_xyz"
  },
  "log": [
    { "timestamp": 1708531200000, "node": "review", "type": "start" },
    { "timestamp": 1708531202300, "node": "review", "type": "complete" }
  ]
}
```

**Secrets exclusion:** Resolved secret values are **never** stored in execution snapshots. The context store only contains the `{{ secrets.KEY }}` template reference, which is resolved at execution time from the secure keychain.

### Sequence Version Safety

When an execution starts, the engine takes a **snapshot** of the sequence definition and stores it in the execution state (`sequence_snapshot`). If the user edits the sequence YAML while an execution is in progress:

- The running execution continues using the snapshotted definition
- New executions use the updated definition
- The execution history shows which version was used

### Recovery

On app restart:

1. Load execution index
2. For each execution with status `running` or `waiting`:
   - Load full snapshot (includes sequence definition snapshot)
   - If `running`: resume from current node using idempotency checks (see [Execution Engine: Recovery](#recovery--idempotency))
   - If `waiting_for_approval`: restore the approval prompt in the UI
   - If `waiting_for_condition`: restart the polling loop
3. Emit events so the UI reflects the restored state

### History & Cleanup

- Completed executions kept for 30 days (configurable)
- Execution history viewable in the UI with filtering by sequence, status, date
- Manual cleanup option in settings
- Token usage and costs aggregated into the existing usage tracking system

---

## 14. Pre-Built Templates

### Starter Sequences (bundled with app)

#### 1. Code Review
```yaml
name: "Code Review"
description: "AI-powered code review of recent changes"
nodes:
  - prompt: Review changes (haiku — cheap, fast)
  - route: Critical issues? (true/false)
  - prompt: Generate improvement suggestions (sonnet)
  - notify: System notification with summary
```

#### 2. Code Simplifier
```yaml
name: "Code Simplifier"
description: "Analyze and simplify complex code"
nodes:
  - prompt: Identify overly complex code (haiku)
  - prompt: Suggest simplifications (sonnet)
  - approval: Review suggestions before applying
  - prompt: Apply approved simplifications (sonnet)
  - script: Run tests
  - route: Tests pass? (true/false)
  - git_commit: Commit changes
```

#### 3. Feature Pipeline
```yaml
name: "Feature Pipeline"
description: "Plan → Branch → Implement → Test → PR"
inputs: [feature_description]
cleanup:
  - git_delete_worktree (if created)
nodes:
  - prompt: Plan the feature (sonnet, effort: high)
  - approval: Review plan
  - git_branch: Create feature branch
  - prompt: Implement the feature (sonnet/opus based on complexity)
  - script: Run tests
  - loop: Fix issues until tests pass (max 3)
  - git_commit: Commit changes
  - git_push: Push to remote
  - github_pr: Create PR
  - notify: Slack notification
```

#### 4. PR Workflow
```yaml
name: "PR Workflow"
description: "Create PR, wait for CI, notify on result"
nodes:
  - git_push: Push current branch
  - github_pr: Create PR
  - notify: Slack — PR created
  - github_pr_wait: Wait for checks
  - route: Checks passed? (true/false)
  - notify: System — result notification
```

#### 5. Daily Maintenance (scheduled)
```yaml
name: "Daily Maintenance"
description: "Check deps, run tests, report issues"
triggers:
  - type: schedule
    cron: "0 9 * * 1-5"
nodes:
  - script: npm audit
  - script: npm outdated
  - script: npm test
  - prompt: Summarize findings (haiku)
  - route: Issues found? (true/false)
  - notify: Slack — daily report
```

#### 6. Multi-Repo Sync
```yaml
name: "Multi-Repo Dependency Sync"
description: "Update shared dependencies across repos"
inputs:
  - repos: repo_list
nodes:
  - for_each: repos
    - script: npm update <package>
    - script: npm test
    - route: Tests pass? (true/false)
    - git_commit + git_push
  - notify: Summary of all repos
```

---

## 15. Voice Integration

Sequences integrate with Claude Whisperer's existing voice command system.

### Running Sequences by Voice

```
User: "Run the code review sequence"
User: "Start the feature pipeline for user authentication"
User: "Execute daily maintenance"
```

**Implementation:**
- Add `sequence_commands` to voice command config alongside existing `active_commands`
- When a voice command matches a sequence name (fuzzy match via LLM), start the execution
- **Input extraction from voice:** The LLM parses the voice command to extract input values. "Start the feature pipeline for user authentication" → `feature_description = "user authentication"`. The LLM sees the sequence's input definitions (names, types, descriptions) and maps parts of the utterance to matching inputs.
- If the LLM can't parse all required inputs, the remaining ones are collected via the `SequenceInputDialog` in the UI
- Optional inputs that aren't mentioned in the voice command use their defaults

### Voice During Execution

```
User: "Approve" → Approves the current approval gate
User: "Cancel the sequence" → Cancels the current execution
User: "Skip this step" → Skips the current node (if skippable)
User: "What's the status?" → Reads current execution status aloud (TTS future feature)
```

### Sequence Voice Commands Config

```yaml
# In app config
voice_commands:
  sequence_triggers:
    - phrase: "run sequence"
      action: start_sequence     # Followed by sequence name
    - phrase: "approve"
      action: approve_current
    - phrase: "cancel sequence"
      action: cancel_current
    - phrase: "skip step"
      action: skip_current
```

---

## 16. Security Model

### Threat Model

Sequences execute arbitrary AI prompts, shell commands, and external HTTP requests. The security model focuses on preventing accidental damage and protecting sensitive data.

### Template Injection Prevention

**Shell context:** Template variables interpolated into `command` fields on script nodes are automatically escaped via the `shell_escape` filter applied by the engine. Users can also explicitly use `{{ value | shell_escape }}` in other contexts.

```yaml
# Engine transforms this:
command: "git commit -m '{{ inputs.message }}'"
# Into this (internally):
command: "git commit -m 'fix: don'\\''t break things'"
```

**Template context:** Template evaluation is single-pass. Node outputs stored in the execution context are raw strings, never re-evaluated as templates. An AI response containing `{{ secrets.KEY }}` is treated as a literal string.

### Script Node Sandboxing

- **Working directory restriction** — `cwd` is validated to be within a configured repo path or the system temp directory
- **Timeout enforcement** — All script nodes have a mandatory timeout (default from sequence `defaults.timeout`, max 10 minutes)
- **Process group kill** — On timeout or cancellation, the entire process group is killed (not just the parent process)
- **No secret interpolation in commands** — The `secrets.*` namespace is not available in script `command` fields. Secrets should be passed via `env` variables instead:

```yaml
# GOOD — secrets via environment
- type: script
  command: "deploy.sh"
  env:
    API_TOKEN: "{{ secrets.DEPLOY_TOKEN }}"

# BAD — secret in command string (blocked by engine)
- type: script
  command: "curl -H 'Auth: {{ secrets.TOKEN }}' ..."
```

### File Node Restrictions

- File paths are validated to be within configured repo paths
- No access to system directories, home directory dotfiles, or paths outside repos
- Symlinks are resolved and re-validated before access

### Secrets Management

- **At rest** — Encrypted via Tauri keychain integration (OS-level secure storage)
- **In memory** — Resolved only at the moment of use, then discarded from template context
- **In logs** — Secret values are redacted from execution logs (replaced with `***`)
- **In snapshots** — Execution snapshots store `{{ secrets.KEY }}` references, never resolved values
- **In exports** — YAML exports never include secret values

### HTTP Request Safety

- HTTP request nodes use `reqwest` with timeout enforcement
- Redirect following is limited to 5 hops
- Response body size is limited (10MB default) to prevent memory exhaustion
- Private/internal network ranges (127.0.0.0/8, 10.0.0.0/8, 192.168.0.0/16, etc.) are blocked by default unless explicitly allowed in settings

---

## 17. Frontend Integration

### Sequences as Sessions

A running sequence execution appears as a **session** in the main sidebar session list, alongside PTY and SDK sessions. This unifies the UX — the session list is the single place to see everything that's happening.

**Session types in the sidebar:**

| Type | Icon | Description |
|------|------|-------------|
| PTY | Terminal icon | Interactive/Prompt mode terminal sessions |
| SDK | Claude icon | Direct SDK sessions (user-created) |
| SDK (sequence) | Sequence badge | SDK sub-sessions created by prompt nodes in a sequence |
| Sequence | Pipeline icon | The sequence execution itself |

**Sequence sessions** show the sequence name + status (running/paused/waiting/completed/failed).

**SDK sub-sessions** created by prompt nodes appear as flat entries in the session list (not nested), tagged with the parent sequence name. The sequence session view has links to jump to each sub-session, and sub-sessions have a back-link to the parent sequence.

### Sequence Session View

Clicking a sequence session in the sidebar opens a **full-width scrollable view** — similar to how SDK sessions render messages. Each node is rendered vertically:

```
┌─ Sequence: Code Review Pipeline ───────────┐
│                                              │
│  ✓ Review (haiku, 2.3s, $0.003)             │
│  ┌────────────────────────────────────┐      │
│  │ Found 2 issues... [collapsed]      │      │
│  └────────────────────────────────────┘      │
│                                              │
│  ✓ Route → true → Fix Issues                │
│                                              │
│  ● Fix Issues (sonnet, running...)    [↗]   │
│  ┌────────────────────────────────────┐      │
│  │ [live streaming SDK output]        │      │
│  │ Looking at the code in src/...     │      │
│  │ █                                  │      │
│  └────────────────────────────────────┘      │
│                                              │
│  ○ Run Tests (pending)                      │
│  ○ Create PR (pending)                      │
│                                              │
│  ┌──────────────────────────────────────┐    │
│  │ Tokens: 12.4k in / 3.2k out          │    │
│  │ Cost: $0.12  Duration: 4m 12s        │    │
│  └──────────────────────────────────────┘    │
└──────────────────────────────────────────────┘
```

**Node rendering rules:**
- **Completed nodes** — Status icon, name, model, duration, cost. Output collapsed by default, click to expand.
- **Route nodes** — Show which branch was taken: `✓ Route → true → Fix Issues`
- **Running prompt node** — Live streaming SDK output inline (same events as `SdkView`). `[↗]` link opens the full sub-session.
- **Running script node** — Stdout/stderr streaming inline.
- **Pending nodes** — Grayed out with status.
- **Failed nodes** — Red status with error message, retry button.
- **Approval nodes** — Inline approve/reject buttons with the approval message. Voice commands also work.
- **Loop nodes** — Show iteration count: `● Fix Loop (iteration 2/5, running...)`
- **Parallel nodes** — Show branch status as sub-items.

This view doubles as the primary debugging tool — users can see exactly what happened at each step, inspect outputs, and understand why a route took a particular branch.

### Routing

```
/                               # Main view — session list includes sequence sessions
/sequences                      # Sequence library (browse, create, manage)
/sequences/edit/:id             # Visual editor for a sequence
```

Execution viewing doesn't need its own route — sequence sessions are viewed like any other session in the main view.

### Store Structure

```
src/lib/stores/
├── sequences.ts                # Sequence definitions (CRUD, load from backend)
└── sequenceExecutions.ts       # Active + recent executions, event listeners, session integration
```

Both stores use Svelte 5 runes and follow the same patterns as `sdkSessions.ts`. The `sequenceExecutions` store creates session entries in the session list and manages the lifecycle of sub-sessions.

### Component Structure

```
src/lib/components/sequences/
├── SequenceLibrary.svelte      # Grid/list of saved sequences with search + create
├── SequenceCard.svelte         # Card for a single sequence (name, tags, last run, repo restrictions)
├── SequenceEditor.svelte       # Visual editor wrapper (canvas + inspector)
├── NodeCanvas.svelte           # @xyflow/svelte node graph canvas
├── NodeInspector.svelte        # Side panel for editing selected node properties
├── NodePalette.svelte          # Draggable node type list
├── SequenceSessionView.svelte  # Full-width scroll view for a running/completed sequence
├── SequenceNodeRow.svelte      # Single node rendered in the session view
├── SequenceApproval.svelte     # Inline approval prompt (approve/reject buttons)
├── SequenceInputDialog.svelte  # Modal for collecting sequence inputs at start
└── SequenceUsageBar.svelte     # Token/cost/duration summary bar
```

### Error Feedback

**Authoring errors** (invalid YAML, missing required fields, broken references):
- Toast notification with the error summary
- Error details in the execution log
- Clickable link to open the YAML file in the user's system editor at the error location

**Runtime errors** (node failures, API errors, timeout):
- Failed node shows red in the sequence session view with expandable error details
- Toast notification for the error
- Retry button on failed nodes where applicable

### Overlay Integration

The overlay window does **not** show sequence status. Sequences are background operations; the overlay stays focused on recording and transcription. Sequence status is only visible in the main app via the session list.

### Settings Integration

New settings tab: **Settings → Sequences**

Sub-sections:
- **General** — Default timeout, max concurrent executions, execution history retention
- **Notifications** — Configure Slack, Discord, and webhook channels

---

## 18. Implementation Phases

### Phase 1: Foundation (Core Engine + Linear Sequences)

**Goal:** Run simple linear sequences of prompt nodes from YAML files.

**Backend:**
- [ ] `sequences/` module with types, executor, state manager
- [ ] Template engine integration (minijinja with custom filters)
- [ ] Prompt node execution (reuse sidecar infrastructure, both Claude and Codex providers)
- [ ] Route node — expression mode (eval via minijinja) and AI classification mode (haiku)
- [ ] Script node (shell command execution with security: shell escaping, cwd validation, timeouts)
- [ ] System notification node
- [ ] Execution state persistence (JSON snapshots with secret exclusion)
- [ ] Cleanup block execution
- [ ] Dry-run validation command
- [ ] Tauri commands: CRUD + start/cancel/get execution
- [ ] Tauri events for execution progress

**Frontend:**
- [ ] Sequences store + execution store (integrates with session list)
- [ ] Sequence session type in sidebar (pipeline icon, sequence badge on sub-sessions)
- [ ] `SequenceSessionView` — full-width scroll view with node rows, live streaming, collapsed outputs
- [ ] `/sequences` route with sequence library view
- [ ] YAML import/export
- [ ] `SequenceInputDialog` for collecting inputs at start
- [ ] Inline secret prompting (prompt user when a referenced secret doesn't exist)
- [ ] Settings tab for sequences (general + notification channels)

**Deliverables:**
- Can define a sequence in YAML, load it, run it, see results
- Sequence executions appear as sessions in the sidebar
- Prompt → Route → Prompt → Script → Notify chains work
- Execution survives app restart with idempotency
- Template variables resolve correctly with single-pass safety
- Dry-run validation catches errors before execution

### Phase 2: Git & GitHub Integration

**Goal:** Full git workflow automation + PR lifecycle.

**Backend:**
- [ ] Git nodes: branch, worktree, commit, push, delete (with idempotency checks)
- [ ] Git isolation strategies: worktree auto-creation, repo locking
- [ ] GitHub PR nodes: create, wait, merge (via `gh` CLI)
- [ ] Approval node with inline UI integration
- [ ] Wait/poll node for PR status monitoring
- [ ] Error handling: retry, skip, goto strategies
- [ ] File node (read/write/copy with path validation)
- [ ] HTTP request node (with timeout, redirect limits, private network blocking)

**Frontend:**
- [ ] `SequenceApproval` — inline approve/reject in sequence session view (+ voice command support)
- [ ] Git isolation UI — worktree/lock status indicators
- [ ] Failed node retry button in sequence session view
- [ ] Loop iteration display in node rows

**Deliverables:**
- Full feature pipeline: branch → implement → test → PR → wait → merge → cleanup
- Human-in-the-loop approval gates
- PR monitoring with configurable polling
- Cleanup blocks prevent resource leaks

### Phase 3: Visual Editor + AI Generation

**Goal:** Drag-and-drop sequence builder + AI workflow generation.

**Frontend:**
- [ ] Node canvas (@xyflow/svelte)
- [ ] Node palette (draggable node types)
- [ ] Node inspector panel (edit selected node config)
- [ ] Connection drawing (drag output → input)
- [ ] Canvas → YAML save (canvas is primary editor; writes to YAML file on save)
- [ ] YAML → Canvas load (reads YAML on open; "Open in Editor" link for manual YAML editing)
- [ ] Zoom, pan, mini-map
- [ ] Execution overlay on canvas (live status per node)

**AI Generation:**
- [ ] Full generation from natural language description (generates YAML, opens in canvas)
- [ ] Template suggestion based on description
- [ ] Inline node assist (prompt authoring, route branch generation)
- [ ] Dry-run validation with helpful error messages

**Deliverables:**
- Visual sequence builder with drag-and-drop
- AI generates sequences from "create a workflow that..."
- "Open in Editor" for power users who prefer YAML directly

### Phase 4: Notifications + Scheduling

**Goal:** External notifications + time-based triggers.

**Backend:**
- [ ] Slack webhook integration
- [ ] Discord webhook integration
- [ ] Generic webhook node
- [ ] Notification channel configuration in settings
- [ ] Notification failure policies (warn/stop/retry)
- [ ] Cron scheduler (tokio background task)
- [ ] Schedule trigger support in sequences

**Frontend:**
- [ ] Notification channel settings UI
- [ ] Schedule configuration in sequence editor
- [ ] Scheduled execution indicators in UI

**Deliverables:**
- Sequences can notify Slack, Discord, or any webhook
- Cron-scheduled sequences (daily maintenance, weekly reports)
- Notification failures don't break sequences (with warn policy)

### Phase 5: Advanced Features

**Goal:** Composability, multi-repo, parallelism, voice integration.

- [ ] Parallel node (concurrent execution with configurable failure semantics)
- [ ] Loop node (repeat until condition)
- [ ] For-each node (iterate over collections, sequential or parallel)
- [ ] Sub-sequence node (composability)
- [ ] Multi-repo support (for_each repos, repo tags)
- [ ] Route node AI mode with custom branch descriptions (LLM-powered classification)
- [ ] Voice command integration for sequence control
- [ ] Rate limiting / backpressure for parallel prompt nodes
- [ ] Event-based triggers: session_end (with type/provider/model/repo/status filters), sequence_end, recording_end, app_start
- [ ] Trigger guards: cooldown, max_per_day, self-exclusion, sequence sub-session exclusion
- [ ] Advanced templating (custom filters)

---

## Appendix A: Example Sequences

### A.1 Post-Implementation Review & Simplify

```yaml
name: "Review & Simplify"
description: "After implementing a feature, review and simplify the code"

defaults:
  model: sonnet

nodes:
  - id: review
    type: prompt
    model: haiku
    output_format: json
    prompt: |
      Review the changes made in this session. Identify:
      1. Code that could be simplified
      2. Unnecessary complexity
      3. Opportunities to reduce duplication
      4. Missing error handling

      Respond in JSON:
      { "has_improvements": true/false, "summary": "...", "items": [...] }
    outputs:
      summary: "{{ response | json | get('summary') }}"
      has_improvements: "{{ response | json | get('has_improvements') }}"

  - id: check
    type: route
    eval: "{{ nodes.review.has_improvements }}"
    branches:
      true: simplify
      false: done

  - id: simplify
    type: prompt
    model: sonnet
    effort: high
    prompt: |
      Based on this review:
      {{ nodes.review.summary }}

      Apply the suggested simplifications. Focus on readability
      and maintainability. Do not change behavior.

  - id: verify
    type: script
    command: "npm test"
    on_error: goto:rollback

  - id: commit
    type: git_commit
    message: "refactor: simplify implementation"
    next: done

  - id: rollback
    type: prompt
    prompt: "Tests failed after simplification. Revert the changes."
    next: notify_failure

  - id: notify_failure
    type: notify
    channel: system
    message: "Simplification reverted — tests failed"

  - id: done
    type: notify
    channel: system
    message: "Code review complete. {{ nodes.review.summary | truncate(100) }}"
```

### A.2 Issue-to-PR Pipeline

```yaml
name: "Issue to PR"
description: "Read a GitHub issue, implement the fix, create a PR"

inputs:
  - name: issue_number
    type: number
    description: "GitHub issue number"
    required: true
    validation:
      min: 1
      integer: true

cleanup:
  - id: cleanup_branch
    type: git_delete_branch
    branch: "fix/issue-{{ inputs.issue_number }}"
    remote: true
    condition: "{{ execution.status == 'failed' }}"

nodes:
  - id: read_issue
    type: script
    command: "gh issue view {{ inputs.issue_number }} --json title,body,labels"
    outputs:
      issue: "{{ stdout | json }}"

  - id: plan
    type: prompt
    model: sonnet
    effort: high
    prompt: |
      Analyze this GitHub issue and plan the implementation:

      Title: {{ nodes.read_issue.issue.title }}
      Body: {{ nodes.read_issue.issue.body }}
      Labels: {{ nodes.read_issue.issue.labels | join(', ') }}

      Provide a plan with specific files to change and approach.
    outputs:
      plan: "{{ response }}"

  - id: branch
    type: git_branch
    branch_name: "fix/issue-{{ inputs.issue_number }}"

  - id: implement
    type: prompt
    model: sonnet
    effort: high
    prompt: |
      Implement the fix according to this plan:
      {{ nodes.plan.plan }}

      Make sure to follow existing code patterns and conventions.

  - id: test
    type: script
    command: "npm test"
    on_error: retry
    retry_count: 2

  - id: commit
    type: git_commit
    message: "fix: {{ nodes.read_issue.issue.title }} (closes #{{ inputs.issue_number }})"

  - id: push
    type: git_push

  - id: pr
    type: github_pr
    title: "Fix #{{ inputs.issue_number }}: {{ nodes.read_issue.issue.title }}"
    body: |
      ## Issue
      Closes #{{ inputs.issue_number }}

      ## Changes
      {{ nodes.plan.plan }}

      ## Testing
      All tests passing.

      ---
      *Auto-generated by Claude Whisperer Sequence*
    draft: false

  - id: notify
    type: notify
    channel: slack
    on_notify_error: warn
    message: |
      PR created for issue #{{ inputs.issue_number }}: {{ nodes.pr.url }}
```

### A.3 Scheduled Dependency Audit

```yaml
name: "Weekly Dependency Audit"
description: "Check for vulnerable and outdated dependencies"

triggers:
  - type: schedule
    cron: "0 10 * * 1"          # Monday at 10 AM

nodes:
  - id: audit
    type: script
    command: "npm audit --json"
    on_error: skip               # npm audit returns non-zero if vulnerabilities found
    outputs:
      audit_result: "{{ stdout | json }}"

  - id: outdated
    type: script
    command: "npm outdated --json"
    on_error: skip
    outputs:
      outdated_result: "{{ stdout | json }}"

  - id: analyze
    type: prompt
    model: haiku
    output_format: json
    prompt: |
      Analyze these dependency reports and provide a summary:

      Audit: {{ nodes.audit.audit_result }}
      Outdated: {{ nodes.outdated.outdated_result }}

      Categorize by severity and recommend which to update.
      Respond in JSON:
      { "has_critical": true/false, "summary": "..." }
    outputs:
      summary: "{{ response | json | get('summary') }}"
      has_critical: "{{ response | json | get('has_critical') }}"

  - id: check_critical
    type: route
    eval: "{{ nodes.analyze.has_critical }}"
    branches:
      true: urgent_notify
      false: weekly_notify

  - id: urgent_notify
    type: notify
    channel: slack
    message: |
      Critical dependency vulnerabilities found in {{ repo.name }}!
      {{ nodes.analyze.summary }}

  - id: weekly_notify
    type: notify
    channel: slack
    on_notify_error: warn
    message: |
      Weekly dependency report for {{ repo.name }}:
      {{ nodes.analyze.summary }}
```

---

## Appendix B: Secrets Management

Sequences need access to sensitive values (webhook URLs, API tokens) without exposing them in YAML files.

### Storage

Secrets are stored in the app's secure keychain (via Tauri keychain integration), separate from sequence definitions. The app config only stores key names, never values:

```yaml
# In app config — only tracks which secrets exist
sequence_secrets:
  - SLACK_WEBHOOK
  - DISCORD_WEBHOOK
  - GITHUB_TOKEN
  - DEPLOY_TOKEN
```

### Usage in Sequences

Referenced via `{{ secrets.KEY }}`:

```yaml
- id: notify
  type: notify
  channel: slack
  webhook: "{{ secrets.SLACK_WEBHOOK }}"
```

### Inline Secret Prompting

When a sequence references a secret that doesn't exist in the keychain yet, the user is **prompted to enter it on first run**:

1. Engine resolves `{{ secrets.SLACK_WEBHOOK }}` → not found in keychain
2. Execution pauses at that node
3. UI shows an inline prompt in the sequence session view: "This sequence needs a secret: `SLACK_WEBHOOK`. Enter the value:"
4. User enters the value (input is masked)
5. Value is stored in OS keychain for future runs
6. Execution resumes

This eliminates the need for a separate secrets management UI for initial setup. Secrets can still be viewed (masked) and deleted in **Settings → Sequences → Secrets** for housekeeping.

### Security Lifecycle

| Stage | Handling |
|-------|----------|
| **At rest** | Encrypted in OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service) |
| **Config files** | Only key names stored, never values |
| **YAML definitions** | Reference syntax only (`{{ secrets.KEY }}`), never actual values |
| **Template resolution** | Resolved at moment of use, value passed directly to the consumer (HTTP client, env var) |
| **Execution snapshots** | Template references stored, never resolved values |
| **Execution logs** | Values redacted and replaced with `***` |
| **YAML export** | Secret references preserved, values never included |
| **Visual editor** | Secret values masked in the inspector UI |
| **Script commands** | Not available in `command` field; must use `env` variables instead |
| **First use** | Inline prompt if secret not found; stored in keychain after entry |

---

## Appendix C: Comparison with Existing Tools

| Feature | Claude Whisperer Sequences | GitHub Actions | Cursor Composer | Aider | Cline/Roo Code |
|---------|---------------------------|---------------|-----------------|-------|----------------|
| AI-native nodes | First-class | Via actions | First-class | CLI-based | First-class |
| Per-node model selection | Yes | N/A | No | Per-session | No |
| Per-node effort level | Yes | N/A | No | No | No |
| Voice-triggered | Yes | No | No | No | No |
| Visual editor | Yes | No (YAML only) | No | No | No |
| AI generation | Yes | No | No | No | No |
| Git-native | Yes | Yes | Partial | Yes | Partial |
| Desktop-native | Yes | Cloud | IDE plugin | CLI | IDE plugin |
| Human approval gates | Yes | Environments | No | No | Manual |
| Scheduling | Yes | Yes | No | No | No |
| Multi-repo | Yes | Per-repo | No | No | No |
| Multi-provider | Yes (Claude + Codex) | N/A | Partial | Yes | Yes |
| Cost tracking per step | Yes | Minutes-based | No | No | No |
| Cleanup blocks | Yes | No | N/A | N/A | N/A |

### Unique Differentiators

1. **Voice-first** — Trigger and control sequences by voice
2. **Per-node AI model + effort selection** — Right-size cost per step (Haiku for classification, Opus for complex reasoning) with granular effort levels
3. **AI-generated workflows** — Describe what you want, get a working sequence
4. **Desktop-native** — No server needed, works with local repos
5. **Hybrid text+visual** — Visual canvas in-app, YAML in external editor for power users
6. **Integrated with Claude Whisperer** — Reuses existing sessions, transcription, repo management, MCP servers
7. **Multi-provider** — Same sequence can use Claude (Anthropic) for reasoning and Codex (OpenAI) for code generation
8. **Deterministic extraction** — JSON output format + `json`/`get` filters for reliable structured data, no hidden LLM calls
