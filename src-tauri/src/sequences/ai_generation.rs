use serde::{Deserialize, Serialize};

use crate::llm::{GenerationResult, LlmClient};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SequenceYamlResult {
    pub yaml: String,
}

/// Generate a complete sequence YAML from a natural language description
pub async fn generate_sequence(
    client: &LlmClient,
    description: &str,
    repos: &[String],
) -> Result<GenerationResult<SequenceYamlResult>, String> {
    let repos_str = if repos.is_empty() {
        "No specific repositories configured.".to_string()
    } else {
        format!("Available repositories:\n{}", repos.join("\n"))
    };

    let prompt = format!(
        r#"Generate a YAML sequence definition for the Claude Whisperer automation system.

Description of what the sequence should do:
{description}

{repos_str}

The sequence YAML format is:
```yaml
name: "Sequence Name"
description: "What this sequence does"
tags: [tag1, tag2]
inputs:
  - name: input_name
    type: string  # string, number, boolean, repo_list
    description: "Description"
    required: true
nodes:
  - id: step_id
    type: node_type  # See types below
    # ... type-specific fields
    next: next_step_id  # optional, defaults to next in list
cleanup:
  - id: cleanup_step
    type: notify
    message: "Cleanup complete"
triggers:
  - type: manual
```

Available node types:
- prompt: AI prompt (fields: prompt, model [opus/sonnet/haiku], effort [low/medium/high], system_prompt)
- route: Conditional branching (fields: eval OR prompt, branches: {{key: {{next: target_id}}}}, default)
- script: Shell command (fields: command, cwd, env, timeout)
- notify: Notification (fields: system_notification [bool, default true], play_sound [bool], sound [1-10], channel [external channel id], message, title)
- delay: Timed wait (fields: duration [e.g. "5s", "1m"])
- transform: Data transformation (fields: input, operations: [{{type: regex/json_path/template, ...}}])
- approval: Human approval gate (fields: message, timeout)
- wait: Condition wait (fields: poll_condition, poll_interval, poll_command)
- loop: Loop with nodes (fields: max_iterations, until, delay, nodes: [...])
- parallel: Parallel branches (fields: branches: {{name: [...nodes]}}, wait: all/first)
- for_each: Iterate items (fields: items, variable, mode: sequential/parallel, nodes: [...])
- sub_sequence: Call another sequence (fields: sequence, inputs)
- git_branch: Create branch (fields: branch_name, from)
- git_commit: Git commit (fields: message, add, files)
- git_push: Git push (fields: remote, force)
- github_pr: Create PR (fields: title, body, target_branch, draft, labels, reviewers)
- github_pr_wait: Wait for PR checks/reviews (fields: pr, wait_for: checks/reviews/merge)
- github_pr_merge: Merge PR (fields: pr, method: merge/squash/rebase, delete_branch)
- file: File operations (fields: operation: read/write/copy/append, path, content, source, destination)
- http: HTTP request (fields: method, url, headers, body, timeout, expected_status)

Template syntax: {{{{ inputs.name }}}}, {{{{ nodes.step_id.field }}}}

Respond with ONLY a JSON object:
{{"yaml": "the complete YAML string"}}"#
    );

    let schema = serde_json::json!({
        "type": "object",
        "properties": {
            "yaml": {
                "type": "string",
                "description": "Complete YAML sequence definition"
            }
        },
        "required": ["yaml"]
    });

    client.generate_with_usage(&prompt, Some(schema)).await
}

/// Generate configuration for a single node based on description
pub async fn generate_node(
    client: &LlmClient,
    node_type: &str,
    description: &str,
    context: &str,
) -> Result<serde_json::Value, String> {
    let prompt = format!(
        r#"Generate configuration fields for a sequence node of type "{node_type}".

Description of what this node should do:
{description}

Current node context:
{context}

Generate ONLY the type-specific fields for this node type as a JSON object.
Do NOT include id, name, type, condition, timeout, on_error, retry_count, next, or outputs — only the fields specific to the "{node_type}" node type.

For example, for a "prompt" node, return: {{"prompt": "...", "model": "sonnet"}}
For a "script" node, return: {{"command": "...", "cwd": "..."}}
For a "notify" node, return: {{"system_notification": true, "play_sound": true, "sound": 1, "message": "...", "title": "..."}}

Respond with ONLY the JSON object."#
    );

    let result: GenerationResult<serde_json::Value> =
        client.generate_with_usage(&prompt, None).await?;

    Ok(result.data)
}
