use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use chrono::{DateTime, Utc};

// ─── Execution Status ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ExecutionStatus {
    Initializing,
    Running,
    Paused,
    WaitingForApproval { node_id: String },
    WaitingForCondition { node_id: String },
    Completed,
    Failed,
    Cancelled,
    CleaningUp,
}

impl Default for ExecutionStatus {
    fn default() -> Self {
        ExecutionStatus::Initializing
    }
}

// ─── Node Status ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum NodeStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Skipped,
    WaitingApproval,
    Retrying,
}

impl Default for NodeStatus {
    fn default() -> Self {
        NodeStatus::Pending
    }
}

// ─── Log Level ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum LogLevel {
    Info,
    Warn,
    Error,
    Debug,
}

// ─── Token Usage ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TokenUsage {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read: u64,
    #[serde(default)]
    pub cache_creation: u64,
}

impl TokenUsage {
    /// Add another TokenUsage into this one (accumulate)
    pub fn add(&mut self, other: &TokenUsage) {
        self.input_tokens += other.input_tokens;
        self.output_tokens += other.output_tokens;
        self.cache_read += other.cache_read;
        self.cache_creation += other.cache_creation;
    }
}

// ─── Node Result ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeResult {
    pub status: NodeStatus,
    #[serde(default)]
    pub started_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub finished_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub output: Option<serde_json::Value>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub retry_count: u32,
    #[serde(default)]
    pub sdk_session_id: Option<String>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
    #[serde(default)]
    pub cost: Option<f64>,
    #[serde(default)]
    pub tokens: Option<TokenUsage>,
}

impl Default for NodeResult {
    fn default() -> Self {
        Self {
            status: NodeStatus::Pending,
            started_at: None,
            finished_at: None,
            output: None,
            error: None,
            retry_count: 0,
            sdk_session_id: None,
            duration_ms: None,
            cost: None,
            tokens: None,
        }
    }
}

// ─── Log Entry ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub timestamp: DateTime<Utc>,
    #[serde(default)]
    pub node_id: Option<String>,
    pub level: LogLevel,
    pub message: String,
}

// ─── Execution Context ───────────────────────────────────────────────────────

/// Namespaced context for template rendering during sequence execution.
///
/// Provides structured access via namespaces:
/// - `inputs.*` — user-provided input values
/// - `nodes.<node_id>.*` — output values from completed nodes
/// - `repo.*` — repository metadata
/// - `execution.*` — execution-level metadata (id, timestamp, etc.)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ExecutionContext {
    #[serde(default)]
    data: HashMap<String, serde_json::Value>,
}

impl ExecutionContext {
    pub fn new() -> Self {
        Self {
            data: HashMap::new(),
        }
    }

    /// Set an input value at `inputs.{key}`
    pub fn set_input(&mut self, key: &str, value: serde_json::Value) {
        let inputs = self.data
            .entry("inputs".to_string())
            .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));

        if let serde_json::Value::Object(map) = inputs {
            map.insert(key.to_string(), value);
        }
    }

    /// Set a node output value at `nodes.{node_id}.{key}`
    pub fn set_node_output(&mut self, node_id: &str, key: &str, value: serde_json::Value) {
        let nodes = self.data
            .entry("nodes".to_string())
            .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));

        if let serde_json::Value::Object(nodes_map) = nodes {
            let node_obj = nodes_map
                .entry(node_id.to_string())
                .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));

            if let serde_json::Value::Object(node_map) = node_obj {
                node_map.insert(key.to_string(), value);
            }
        }
    }

    /// Set a repo metadata value at `repo.{key}`
    pub fn set_repo(&mut self, key: &str, value: serde_json::Value) {
        let repo = self.data
            .entry("repo".to_string())
            .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));

        if let serde_json::Value::Object(map) = repo {
            map.insert(key.to_string(), value);
        }
    }

    /// Set an execution metadata value at `execution.{key}`
    pub fn set_execution(&mut self, key: &str, value: serde_json::Value) {
        let execution = self.data
            .entry("execution".to_string())
            .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));

        if let serde_json::Value::Object(map) = execution {
            map.insert(key.to_string(), value);
        }
    }

    /// Get a value by dotted path (e.g., "nodes.review.result" or "inputs.branch_name")
    pub fn get(&self, path: &str) -> Option<&serde_json::Value> {
        let parts: Vec<&str> = path.splitn(2, '.').collect();
        if parts.is_empty() {
            return None;
        }

        let top = self.data.get(parts[0])?;

        if parts.len() == 1 {
            return Some(top);
        }

        // Recursively navigate the remaining path
        let remaining = parts[1];
        Self::resolve_path(top, remaining)
    }

    /// Recursively resolve a dotted path within a serde_json::Value
    fn resolve_path<'a>(value: &'a serde_json::Value, path: &str) -> Option<&'a serde_json::Value> {
        if path.is_empty() {
            return Some(value);
        }

        let parts: Vec<&str> = path.splitn(2, '.').collect();
        match value {
            serde_json::Value::Object(map) => {
                let child = map.get(parts[0])?;
                if parts.len() == 1 {
                    Some(child)
                } else {
                    Self::resolve_path(child, parts[1])
                }
            }
            _ => None,
        }
    }

    /// Flatten the context into a single serde_json::Value for template rendering
    pub fn to_value(&self) -> serde_json::Value {
        serde_json::Value::Object(
            self.data
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        )
    }

    /// Merge node result output into the `nodes.{node_id}` namespace
    pub fn merge_node_result(&mut self, node_id: &str, result: &NodeResult) {
        if let Some(output) = &result.output {
            // If the output is an object, merge each key
            if let serde_json::Value::Object(map) = output {
                for (key, val) in map {
                    self.set_node_output(node_id, key, val.clone());
                }
            } else {
                // For non-object outputs, store under "result" key
                self.set_node_output(node_id, "result", output.clone());
            }
        }

        // Always store status
        self.set_node_output(
            node_id,
            "status",
            serde_json::Value::String(format!("{:?}", result.status).to_lowercase()),
        );

        // Store error if present
        if let Some(error) = &result.error {
            self.set_node_output(
                node_id,
                "error",
                serde_json::Value::String(error.clone()),
            );
        }

        // Store duration if present
        if let Some(duration_ms) = result.duration_ms {
            self.set_node_output(
                node_id,
                "duration_ms",
                serde_json::json!(duration_ms),
            );
        }

        // Store cost if present
        if let Some(cost) = result.cost {
            self.set_node_output(
                node_id,
                "cost",
                serde_json::json!(cost),
            );
        }
    }
}

// ─── Sequence Execution ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SequenceExecution {
    pub id: String,
    pub sequence_id: String,
    pub sequence_name: String,
    #[serde(default)]
    pub sequence_version: Option<String>,
    pub started_at: DateTime<Utc>,
    #[serde(default)]
    pub completed_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub paused_at: Option<DateTime<Utc>>,
    pub status: ExecutionStatus,
    #[serde(default)]
    pub current_node_id: Option<String>,
    #[serde(default)]
    pub context: ExecutionContext,
    #[serde(default)]
    pub node_results: HashMap<String, NodeResult>,
    #[serde(default)]
    pub session_ids: Vec<String>,
    #[serde(default)]
    pub inputs: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub total_tokens: TokenUsage,
    #[serde(default)]
    pub total_cost: f64,
    #[serde(default)]
    pub log: Vec<LogEntry>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub completed_node_ids: Vec<String>,
    #[serde(default)]
    pub total_nodes: usize,
}

impl SequenceExecution {
    pub fn new(
        id: String,
        sequence_id: String,
        sequence_name: String,
        sequence_version: Option<String>,
        total_nodes: usize,
        inputs: HashMap<String, serde_json::Value>,
    ) -> Self {
        let mut context = ExecutionContext::new();

        // Initialize inputs namespace
        for (key, value) in &inputs {
            context.set_input(key, value.clone());
        }

        // Initialize execution namespace
        context.set_execution("id", serde_json::Value::String(id.clone()));
        context.set_execution(
            "started_at",
            serde_json::Value::String(Utc::now().to_rfc3339()),
        );

        Self {
            id,
            sequence_id,
            sequence_name,
            sequence_version,
            started_at: Utc::now(),
            completed_at: None,
            paused_at: None,
            status: ExecutionStatus::Initializing,
            current_node_id: None,
            context,
            node_results: HashMap::new(),
            session_ids: Vec::new(),
            inputs,
            total_tokens: TokenUsage::default(),
            total_cost: 0.0,
            log: Vec::new(),
            error: None,
            completed_node_ids: Vec::new(),
            total_nodes,
        }
    }

    /// Create a lightweight summary for listing
    pub fn to_summary(&self) -> ExecutionSummary {
        ExecutionSummary {
            id: self.id.clone(),
            sequence_id: self.sequence_id.clone(),
            sequence_name: self.sequence_name.clone(),
            status: self.status.clone(),
            started_at: self.started_at,
            completed_at: self.completed_at,
            total_cost: self.total_cost,
            completed_nodes: self.completed_node_ids.len(),
            total_nodes: self.total_nodes,
            error: self.error.clone(),
        }
    }

    /// Add a log entry
    pub fn add_log(&mut self, node_id: Option<&str>, level: LogLevel, message: &str) {
        self.log.push(LogEntry {
            timestamp: Utc::now(),
            node_id: node_id.map(|s| s.to_string()),
            level,
            message: message.to_string(),
        });
    }

    /// Update the execution status
    pub fn update_status(&mut self, status: ExecutionStatus) {
        match &status {
            ExecutionStatus::Completed | ExecutionStatus::Failed | ExecutionStatus::Cancelled => {
                self.completed_at = Some(Utc::now());
            }
            ExecutionStatus::Paused => {
                self.paused_at = Some(Utc::now());
            }
            _ => {}
        }
        self.status = status;
    }

    /// Record that a node has started executing
    pub fn record_node_start(&mut self, node_id: &str) {
        self.current_node_id = Some(node_id.to_string());

        let result = self
            .node_results
            .entry(node_id.to_string())
            .or_insert_with(NodeResult::default);

        result.status = NodeStatus::Running;
        result.started_at = Some(Utc::now());

        self.add_log(
            Some(node_id),
            LogLevel::Info,
            &format!("Node '{}' started", node_id),
        );
    }

    /// Record successful node completion with optional output, tokens, and cost
    pub fn record_node_complete(
        &mut self,
        node_id: &str,
        output: Option<serde_json::Value>,
        tokens: Option<TokenUsage>,
        cost: Option<f64>,
    ) {
        let now = Utc::now();

        let result = self
            .node_results
            .entry(node_id.to_string())
            .or_insert_with(NodeResult::default);

        result.status = NodeStatus::Completed;
        result.finished_at = Some(now);
        result.output = output;

        // Calculate duration
        if let Some(started) = result.started_at {
            result.duration_ms = Some((now - started).num_milliseconds().max(0) as u64);
        }

        // Record tokens and cost
        if let Some(ref tok) = tokens {
            self.total_tokens.add(tok);
            result.tokens = Some(tok.clone());
        }
        if let Some(c) = cost {
            self.total_cost += c;
            result.cost = Some(c);
        }

        // Merge result into context
        let result_clone = result.clone();
        self.context.merge_node_result(node_id, &result_clone);

        // Track completion
        if !self.completed_node_ids.contains(&node_id.to_string()) {
            self.completed_node_ids.push(node_id.to_string());
        }

        self.add_log(
            Some(node_id),
            LogLevel::Info,
            &format!("Node '{}' completed", node_id),
        );
    }

    /// Record a node error
    pub fn record_node_error(&mut self, node_id: &str, error: &str) {
        let now = Utc::now();

        let result = self
            .node_results
            .entry(node_id.to_string())
            .or_insert_with(NodeResult::default);

        result.status = NodeStatus::Failed;
        result.finished_at = Some(now);
        result.error = Some(error.to_string());

        // Calculate duration
        if let Some(started) = result.started_at {
            result.duration_ms = Some((now - started).num_milliseconds().max(0) as u64);
        }

        // Merge error into context
        let result_clone = result.clone();
        self.context.merge_node_result(node_id, &result_clone);

        self.add_log(
            Some(node_id),
            LogLevel::Error,
            &format!("Node '{}' failed: {}", node_id, error),
        );
    }

    /// Record a node as skipped (e.g., condition evaluated to false)
    pub fn record_node_skipped(&mut self, node_id: &str) {
        let result = self
            .node_results
            .entry(node_id.to_string())
            .or_insert_with(NodeResult::default);

        result.status = NodeStatus::Skipped;
        result.finished_at = Some(Utc::now());

        // Merge into context
        let result_clone = result.clone();
        self.context.merge_node_result(node_id, &result_clone);

        // Track in completed list (skipped counts as processed)
        if !self.completed_node_ids.contains(&node_id.to_string()) {
            self.completed_node_ids.push(node_id.to_string());
        }

        self.add_log(
            Some(node_id),
            LogLevel::Info,
            &format!("Node '{}' skipped", node_id),
        );
    }
}

// ─── Execution Summary ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionSummary {
    pub id: String,
    pub sequence_id: String,
    pub sequence_name: String,
    pub status: ExecutionStatus,
    pub started_at: DateTime<Utc>,
    #[serde(default)]
    pub completed_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub total_cost: f64,
    #[serde(default)]
    pub completed_nodes: usize,
    #[serde(default)]
    pub total_nodes: usize,
    #[serde(default)]
    pub error: Option<String>,
}
