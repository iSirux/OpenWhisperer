//! IO-ish node executors: script, transform, file, http, delay.

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use crate::sequences::duration::parse_duration_to_secs;
use crate::sequences::error::SequenceError;
use crate::sequences::executor::{render, with_extra, SequenceExecutor};
use crate::sequences::types::*;

impl SequenceExecutor {
    // ─── Script Node (T2: shared proc runner) ────────────────────────────────

    pub(crate) async fn execute_script(
        &self,
        node: &NodeDefinition,
        script: &ScriptNode,
        context: &serde_json::Value,
        _cancel_flag: Arc<AtomicBool>,
    ) -> Result<Option<serde_json::Value>, SequenceError> {
        let rendered_cmd = render(&script.command, context)?;

        let cwd = match &script.cwd {
            Some(c) => render(c, context)?,
            None => std::env::current_dir().unwrap_or_default().to_string_lossy().to_string(),
        };

        let timeout_secs = node.timeout.unwrap_or(120);

        // Render env values; a template failure logs a warning and falls back to
        // the raw value rather than being silently swallowed (finding S11).
        let mut env: Vec<(String, String)> = Vec::new();
        if let Some(ref env_map) = script.env {
            for (k, v) in env_map {
                let rendered_v = match render(v, context) {
                    Ok(x) => x,
                    Err(e) => {
                        log::warn!(
                            "[sequence] script node '{}' env var '{}' failed to render ({}); using raw value",
                            node.id,
                            k,
                            e
                        );
                        v.clone()
                    }
                };
                env.push((k.clone(), rendered_v));
            }
        }

        #[cfg(windows)]
        let (program, flag) = ("cmd", "/C");
        #[cfg(not(windows))]
        let (program, flag) = ("sh", "-c");
        let args = vec![flag.to_string(), rendered_cmd];

        let output = tokio::time::timeout(
            std::time::Duration::from_secs(timeout_secs),
            crate::proc::run_command_async(program, &args, Some(std::path::Path::new(&cwd)), &env),
        )
        .await
        .map_err(|_| SequenceError::timeout(format!("Script timed out after {}s", timeout_secs)))?
        .map_err(SequenceError::command)?;

        if !output.success {
            let detail = if output.stderr.trim().is_empty() {
                output.stdout.trim()
            } else {
                output.stderr.trim()
            };
            return Err(SequenceError::command(format!(
                "Script failed (exit {}): {}",
                output.code.unwrap_or(-1),
                detail
            )));
        }

        Ok(Some(serde_json::json!({
            "stdout": output.stdout.trim(),
            "stderr": output.stderr.trim(),
            "exit_code": output.code.unwrap_or(0),
        })))
    }

    // ─── Transform Node ──────────────────────────────────────────────────────

    pub(crate) fn execute_transform(
        &self,
        _node: &NodeDefinition,
        transform: &TransformNode,
        context: &serde_json::Value,
    ) -> Result<Option<serde_json::Value>, SequenceError> {
        let mut current = render(&transform.input, context)?;

        for op in &transform.operations {
            match op.op_type {
                TransformOpType::Regex => {
                    let pattern = op.pattern.as_ref().ok_or_else(|| {
                        SequenceError::other("Regex transform requires 'pattern'")
                    })?;
                    let replacement = op.replacement.as_deref().unwrap_or("");
                    let re = regex::Regex::new(pattern).map_err(|e| {
                        SequenceError::other(format!("Invalid regex '{}': {}", pattern, e))
                    })?;
                    current = re.replace_all(&current, replacement).to_string();
                }
                TransformOpType::JsonPath => {
                    let path = op
                        .path
                        .as_ref()
                        .ok_or_else(|| SequenceError::other("JsonPath transform requires 'path'"))?;
                    let parsed: serde_json::Value = serde_json::from_str(&current)
                        .map_err(|e| SequenceError::other(format!("JSON parse error: {}", e)))?;
                    let mut val = &parsed;
                    for part in path.split('.') {
                        val = val.get(part).ok_or_else(|| {
                            SequenceError::other(format!("Path '{}' not found in JSON", path))
                        })?;
                    }
                    current = match val {
                        serde_json::Value::String(s) => s.clone(),
                        other => other.to_string(),
                    };
                }
                TransformOpType::Template => {
                    let tmpl = op
                        .template
                        .as_ref()
                        .ok_or_else(|| SequenceError::other("Template transform requires 'template'"))?;
                    let ctx_val = with_extra(
                        context,
                        vec![("value", serde_json::Value::String(current.clone()))],
                    );
                    current = render(tmpl, &ctx_val)?;
                }
            }
        }

        let result = serde_json::from_str::<serde_json::Value>(&current)
            .unwrap_or_else(|_| serde_json::Value::String(current));
        Ok(Some(result))
    }

    // ─── File Node ───────────────────────────────────────────────────────────

    pub(crate) async fn execute_file(
        &self,
        _node: &NodeDefinition,
        file_node: &FileNode,
        context: &serde_json::Value,
    ) -> Result<Option<serde_json::Value>, SequenceError> {
        match file_node.operation {
            FileOperation::Read => {
                let path = file_node
                    .path
                    .as_ref()
                    .ok_or_else(|| SequenceError::other("File read requires 'path'"))?;
                let rendered_path = render(path, context)?;
                let content = tokio::fs::read_to_string(&rendered_path).await.map_err(|e| {
                    SequenceError::command(format!("Failed to read file '{}': {}", rendered_path, e))
                })?;
                Ok(Some(serde_json::json!({ "content": content, "path": rendered_path })))
            }
            FileOperation::Write => {
                let path = file_node
                    .path
                    .as_ref()
                    .ok_or_else(|| SequenceError::other("File write requires 'path'"))?;
                let rendered_path = render(path, context)?;
                let content = file_node
                    .content
                    .as_ref()
                    .ok_or_else(|| SequenceError::other("File write requires 'content'"))?;
                let rendered_content = render(content, context)?;

                if let Some(parent) = std::path::Path::new(&rendered_path).parent() {
                    tokio::fs::create_dir_all(parent).await.map_err(|e| {
                        SequenceError::command(format!("Failed to create parent directory: {}", e))
                    })?;
                }
                tokio::fs::write(&rendered_path, &rendered_content).await.map_err(|e| {
                    SequenceError::command(format!("Failed to write file '{}': {}", rendered_path, e))
                })?;
                Ok(Some(serde_json::json!({
                    "written": true,
                    "path": rendered_path,
                    "bytes": rendered_content.len(),
                })))
            }
            FileOperation::Append => {
                let path = file_node
                    .path
                    .as_ref()
                    .ok_or_else(|| SequenceError::other("File append requires 'path'"))?;
                let rendered_path = render(path, context)?;
                let content = file_node
                    .content
                    .as_ref()
                    .ok_or_else(|| SequenceError::other("File append requires 'content'"))?;
                let rendered_content = render(content, context)?;

                use tokio::io::AsyncWriteExt;
                let mut file = tokio::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&rendered_path)
                    .await
                    .map_err(|e| {
                        SequenceError::command(format!("Failed to open file '{}': {}", rendered_path, e))
                    })?;
                file.write_all(rendered_content.as_bytes()).await.map_err(|e| {
                    SequenceError::command(format!("Failed to append to file '{}': {}", rendered_path, e))
                })?;
                Ok(Some(serde_json::json!({
                    "appended": true,
                    "path": rendered_path,
                    "bytes": rendered_content.len(),
                })))
            }
            FileOperation::Copy => {
                let source = file_node
                    .source
                    .as_ref()
                    .ok_or_else(|| SequenceError::other("File copy requires 'source'"))?;
                let destination = file_node
                    .destination
                    .as_ref()
                    .ok_or_else(|| SequenceError::other("File copy requires 'destination'"))?;
                let rendered_source = render(source, context)?;
                let rendered_dest = render(destination, context)?;

                if let Some(parent) = std::path::Path::new(&rendered_dest).parent() {
                    tokio::fs::create_dir_all(parent).await.map_err(|e| {
                        SequenceError::command(format!("Failed to create parent directory: {}", e))
                    })?;
                }
                tokio::fs::copy(&rendered_source, &rendered_dest).await.map_err(|e| {
                    SequenceError::command(format!(
                        "Failed to copy '{}' to '{}': {}",
                        rendered_source, rendered_dest, e
                    ))
                })?;
                Ok(Some(serde_json::json!({
                    "copied": true,
                    "source": rendered_source,
                    "destination": rendered_dest,
                })))
            }
        }
    }

    // ─── HTTP Node ───────────────────────────────────────────────────────────

    pub(crate) async fn execute_http(
        &self,
        node: &NodeDefinition,
        http_node: &HttpNode,
        context: &serde_json::Value,
    ) -> Result<Option<serde_json::Value>, SequenceError> {
        let rendered_url = render(&http_node.url, context)?;
        let method_str = http_node.method.as_deref().unwrap_or("GET").to_uppercase();
        let timeout_secs = node.timeout.unwrap_or(60);

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(timeout_secs))
            .build()
            .map_err(|e| SequenceError::command(format!("Failed to create HTTP client: {}", e)))?;

        let method = method_str
            .parse::<reqwest::Method>()
            .map_err(|e| SequenceError::other(format!("Invalid HTTP method '{}': {}", method_str, e)))?;

        let mut request = client.request(method, &rendered_url);

        if let Some(ref headers) = http_node.headers {
            for (key, value) in headers {
                let rendered_value = render(value, context)?;
                request = request.header(key.as_str(), rendered_value);
            }
        }
        if let Some(ref body) = http_node.body {
            request = request.body(render(body, context)?);
        }

        let response = request
            .send()
            .await
            .map_err(|e| SequenceError::command(format!("HTTP request to '{}' failed: {}", rendered_url, e)))?;

        let status = response.status().as_u16();
        if let Some(ref expected) = http_node.expected_status {
            if !expected.contains(&status) {
                return Err(SequenceError::command(format!(
                    "HTTP request returned status {} (expected one of {:?})",
                    status, expected
                )));
            }
        }

        let resp_headers: HashMap<String, String> = response
            .headers()
            .iter()
            .map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string()))
            .collect();

        let resp_body = response
            .text()
            .await
            .map_err(|e| SequenceError::command(format!("Failed to read HTTP response body: {}", e)))?;

        Ok(Some(serde_json::json!({
            "status": status,
            "body": resp_body,
            "headers": resp_headers,
        })))
    }

    // ─── Delay Node ──────────────────────────────────────────────────────────

    pub(crate) async fn execute_delay(
        &self,
        _node: &NodeDefinition,
        delay: &DelayNode,
        context: &serde_json::Value,
    ) -> Result<Option<serde_json::Value>, SequenceError> {
        let rendered_duration = render(&delay.duration, context)?;
        let secs = parse_duration_to_secs(&rendered_duration).map_err(SequenceError::other)?;

        if let Some(ref message) = delay.message {
            let rendered = render(message, context)?;
            log::info!("[sequence] Delay {}s: {}", secs, rendered);
        }

        tokio::time::sleep(std::time::Duration::from_secs(secs)).await;
        Ok(Some(serde_json::json!({ "delayed_seconds": secs })))
    }
}
