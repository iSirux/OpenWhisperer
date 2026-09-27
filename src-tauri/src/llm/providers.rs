//! Provider-specific API implementations (Gemini, OpenAI-compatible)

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::config::LlmProvider;

use super::api_types::*;
use super::types::ConnectionTestResult;
use super::utils::extract_json;
use super::LlmClient;

/// Result of a generation that includes usage data
pub struct GenerationResult<T> {
    pub data: T,
    pub usage: LlmUsage,
}

/// Groq fallback models: Groq rate limits are PER-MODEL, so when the configured
/// model's quota is exhausted a sibling model usually still has headroom.
/// Mirrors the model list offered in Settings → LLM.
const GROQ_FALLBACK_MODELS: &[&str] = &[
    "openai/gpt-oss-120b",
    "qwen/qwen3.6-27b",
    "openai/gpt-oss-20b",
];

/// Errors worth retrying on a different model: quota/rate-limit hits, server-side
/// failures, and models that no longer exist. Auth/parse errors are NOT retriable —
/// they'd fail identically on every model.
fn is_retriable_on_other_model(error: &str) -> bool {
    let lower = error.to_lowercase();
    error.contains("(429")
        || lower.contains("rate limit")
        || lower.contains("rate_limit")
        || error.contains("(500")
        || error.contains("(502")
        || error.contains("(503")
        || lower.contains("model_decommissioned")
        || lower.contains("model_not_found")
}

/// Error text for an HTTP-200 response whose message content is empty/null.
/// Under `json_schema` this is treated as a format failure (LM Studio's Qwen
/// json_schema bug returns empty content), so the next format is tried.
pub(crate) const EMPTY_CONTENT_ERROR: &str = "Empty response content from API";

/// The `response_format` sent to an OpenAI-compatible provider, in fallback
/// order: real schema enforcement first, then plain JSON mode, then nothing
/// (the prompt still demands JSON and the reply is always parsed/validated).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ResponseFormatLevel {
    JsonSchema,
    JsonObject,
    Plain,
}

impl ResponseFormatLevel {
    /// First level to try for a request.
    pub(crate) fn initial(has_schema: bool) -> Self {
        if has_schema {
            ResponseFormatLevel::JsonSchema
        } else {
            ResponseFormatLevel::JsonObject
        }
    }

    /// The level to retry with after `error`, or None when the error isn't a
    /// format rejection (or there's nothing left to fall back to).
    pub(crate) fn next_after(self, error: &str) -> Option<Self> {
        let empty_under_schema =
            self == ResponseFormatLevel::JsonSchema && error.contains(EMPTY_CONTENT_ERROR);
        if !is_format_rejection(error) && !empty_under_schema {
            return None;
        }
        self.next()
    }

    fn next(self) -> Option<Self> {
        match self {
            ResponseFormatLevel::JsonSchema => Some(ResponseFormatLevel::JsonObject),
            ResponseFormatLevel::JsonObject => Some(ResponseFormatLevel::Plain),
            ResponseFormatLevel::Plain => None,
        }
    }

    /// Cache key under which a genuine rejection of this level is remembered.
    /// `json_schema` rejections are keyed per schema (a strict-schema problem in
    /// one feature must not downgrade the others); `json_object` rejections are
    /// model-level. `Plain` is never rejected.
    fn rejection_key(self, model_key: &str, schema_name: &str) -> Option<String> {
        match self {
            ResponseFormatLevel::JsonSchema => Some(format!("{}|json_schema|{}", model_key, schema_name)),
            ResponseFormatLevel::JsonObject => Some(format!("{}|json_object", model_key)),
            ResponseFormatLevel::Plain => None,
        }
    }

    /// Advance past every level already known (cached) to be rejected.
    fn skip_rejected(mut self, is_rejected: impl Fn(Self) -> bool) -> Self {
        while is_rejected(self) {
            match self.next() {
                Some(n) => self = n,
                None => break,
            }
        }
        self
    }
}

/// HTTP 400/422 — the server rejected the request shape (for any reason).
pub(crate) fn is_bad_request(error: &str) -> bool {
    error.contains("API error (400") || error.contains("API error (422")
}

/// A 400/422 that is specifically about the `response_format` (e.g. LM Studio:
/// "'response_format.type' must be 'json_schema' or 'text'"), as opposed to
/// context-length overflows or a model that failed to produce valid JSON
/// (Groq `json_validate_failed`) — those fail identically without the format
/// and must not trigger (or be cached as) a downgrade.
pub(crate) fn is_format_rejection(error: &str) -> bool {
    if !is_bad_request(error) {
        return false;
    }
    let lower = error.to_lowercase();
    const NOT_FORMAT: &[&str] = &[
        "json_validate_failed",
        "failed to generate json",
        "failed_generation",
        "context_length",
        "context length",
        "context window",
        "maximum context",
        "too many tokens",
        "reduce the length",
        "max_tokens",
    ];
    if NOT_FORMAT.iter().any(|m| lower.contains(m)) {
        return false;
    }
    const FORMAT: &[&str] = &[
        "response_format",
        "json_schema",
        "json_object",
        "strict",
        "schema",
        "not supported",
        "unsupported",
    ];
    FORMAT.iter().any(|m| lower.contains(m))
}

/// Genuine format rejections seen this process (keys from
/// [`ResponseFormatLevel::rejection_key`]), so a server that rejects
/// `json_schema` doesn't pay a failed round trip on every call. One-off
/// failures (empty replies) are never recorded. Process-lifetime only.
fn format_cache() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn is_cached_rejection(model_key: &str, schema_name: &str, level: ResponseFormatLevel) -> bool {
    level
        .rejection_key(model_key, schema_name)
        .is_some_and(|k| format_cache().lock().map(|c| c.contains(&k)).unwrap_or(false))
}

/// Rewrite a (loose, Gemini-style) JSON schema into an OpenAI strict
/// structured-output schema: every object gets `additionalProperties: false`
/// and lists ALL its properties as required; properties that were optional
/// become nullable (`["<type>", "null"]`, plus `null` in any `enum`).
pub(crate) fn strict_schema(schema: &serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    let mut out = schema.clone();
    if let Value::Object(map) = &mut out {
        if let Some(Value::Object(props)) = map.get("properties").cloned() {
            let originally_required: std::collections::HashSet<String> = map
                .get("required")
                .and_then(|r| r.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            let mut new_props = serde_json::Map::new();
            for (key, prop) in props {
                let mut prop = strict_schema(&prop);
                if !originally_required.contains(&key) {
                    make_nullable(&mut prop);
                }
                new_props.insert(key, prop);
            }
            let required: Vec<Value> = new_props.keys().map(|k| Value::String(k.clone())).collect();
            map.insert("properties".into(), Value::Object(new_props));
            map.insert("required".into(), Value::Array(required));
            map.insert("additionalProperties".into(), Value::Bool(false));
        }
        if let Some(items) = map.get("items").cloned() {
            map.insert("items".into(), strict_schema(&items));
        }
    }
    out
}

fn make_nullable(prop: &mut serde_json::Value) {
    use serde_json::Value;
    let Value::Object(map) = prop else { return };
    match map.get("type").cloned() {
        Some(Value::String(t)) if t != "null" => {
            map.insert(
                "type".into(),
                Value::Array(vec![Value::String(t), Value::String("null".into())]),
            );
        }
        Some(Value::Array(mut types)) => {
            if !types.iter().any(|t| t == "null") {
                types.push(Value::String("null".into()));
                map.insert("type".into(), Value::Array(types));
            }
        }
        _ => {}
    }
    if let Some(Value::Array(values)) = map.get_mut("enum") {
        if !values.iter().any(Value::is_null) {
            values.push(Value::Null);
        }
    }
}

/// Common shape of a provider's JSON response body, so a single generic request
/// pipeline can drive both Gemini and OpenAI-compatible providers.
trait ProviderResponse {
    /// An in-body error message (HTTP 200 with an `error` object), if present.
    fn error_message(&self) -> Option<String>;
    /// Extract the generated text and token usage from a successful response.
    fn into_text_and_usage(self) -> Result<(String, LlmUsage), String>;
}

impl ProviderResponse for GeminiResponse {
    fn error_message(&self) -> Option<String> {
        self.error.as_ref().map(|e| e.message.clone())
    }

    fn into_text_and_usage(self) -> Result<(String, LlmUsage), String> {
        let usage = self
            .usage_metadata
            .map(|u| LlmUsage {
                input_tokens: u.prompt_token_count.unwrap_or(0),
                output_tokens: u.candidates_token_count.unwrap_or(0),
                total_tokens: u.total_token_count.unwrap_or(0),
            })
            .unwrap_or_default();

        let text = self
            .candidates
            .and_then(|c| c.into_iter().next())
            .and_then(|c| c.content.parts.into_iter().next())
            .map(|p| p.text)
            .ok_or_else(|| "No response from Gemini".to_string())?;

        Ok((text, usage))
    }
}

impl ProviderResponse for OpenAIResponse {
    fn error_message(&self) -> Option<String> {
        self.error.as_ref().map(|e| e.message.clone())
    }

    fn into_text_and_usage(self) -> Result<(String, LlmUsage), String> {
        let usage = self
            .usage
            .map(|u| LlmUsage {
                input_tokens: u.prompt_tokens.unwrap_or(0),
                output_tokens: u.completion_tokens.unwrap_or(0),
                total_tokens: u.total_tokens.unwrap_or(0),
            })
            .unwrap_or_default();

        let text = self
            .choices
            .and_then(|c| c.into_iter().next())
            .map(|c| c.message.content.unwrap_or_default())
            .ok_or_else(|| "No response from API".to_string())?;

        if text.trim().is_empty() {
            return Err(EMPTY_CONTENT_ERROR.to_string());
        }

        Ok((text, usage))
    }
}

impl LlmClient {
    pub(super) fn provider_name(&self) -> &'static str {
        match self.provider {
            LlmProvider::Groq => "Groq",
            LlmProvider::Gemini => "Gemini",
            LlmProvider::OpenAI => "OpenAI",
            LlmProvider::Xai => "xAI",
            LlmProvider::OpenRouter => "OpenRouter",
            LlmProvider::Local => "Local",
            LlmProvider::Custom => "Custom",
        }
    }

    pub(super) fn model_name(&self) -> &str {
        &self.model
    }

    /// Attach the Authorization header for OpenAI-compatible, non-local providers
    /// that have a key. Gemini authenticates via the URL query string, so it is
    /// intentionally excluded here.
    fn add_auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let req = if matches!(self.provider, LlmProvider::OpenRouter) {
            // Optional OpenRouter app attribution headers.
            req.header("HTTP-Referer", "https://github.com/iSirux/OpenWhisperer")
                .header("X-Title", "OpenWhisperer")
        } else {
            req
        };
        if self.is_openai_compatible()
            && !matches!(self.provider, LlmProvider::Local)
            && !self.api_key.is_empty()
        {
            req.header("Authorization", format!("Bearer {}", self.api_key))
        } else {
            req
        }
    }

    /// Whether to send `chat_template_kwargs: {"enable_thinking": false}`:
    /// only for self-hosted servers (Local/Custom) with the profile toggle on.
    pub(super) fn sends_thinking_kwargs(&self) -> bool {
        self.disable_thinking && matches!(self.provider, LlmProvider::Local | LlmProvider::Custom)
    }

    fn thinking_kwargs(&self, enabled: bool) -> Option<serde_json::Value> {
        enabled.then(|| serde_json::json!({ "enable_thinking": false }))
    }

    /// Generic send → status-check → parse → extract-error pipeline shared by all
    /// providers. Returns the generated text and token usage.
    async fn send_and_parse<Req, Resp>(
        &self,
        url: &str,
        request: &Req,
    ) -> Result<(String, LlmUsage), String>
    where
        Req: Serialize,
        Resp: DeserializeOwned + ProviderResponse,
    {
        let req = self.add_auth(self.client.post(url).json(request));

        let response = req
            .send()
            .await
            .map_err(|e| format!("Request failed: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(format!("API error ({}): {}", status, error_text));
        }

        let parsed: Resp = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        if let Some(err) = parsed.error_message() {
            return Err(err);
        }

        parsed.into_text_and_usage()
    }

    /// Test connection to the LLM API (provider-agnostic).
    pub async fn test_connection(&self) -> Result<ConnectionTestResult, String> {
        let prompt = "Say 'Hello' in one word.";

        let result = if self.is_openai_compatible() {
            let request = OpenAIRequest {
                model: self.model.clone(),
                messages: vec![OpenAIMessage {
                    role: "user".to_string(),
                    content: prompt.to_string(),
                }],
                response_format: None,
                temperature: Some(0.0),
                chat_template_kwargs: self.thinking_kwargs(self.sends_thinking_kwargs()),
            };
            match self
                .send_and_parse::<_, OpenAIResponse>(&self.api_url(), &request)
                .await
            {
                // A server that doesn't know chat_template_kwargs: retry without.
                Err(e) if request.chat_template_kwargs.is_some() && is_bad_request(&e) => {
                    let request = OpenAIRequest {
                        chat_template_kwargs: None,
                        ..request
                    };
                    self.send_and_parse::<_, OpenAIResponse>(&self.api_url(), &request)
                        .await
                }
                other => other,
            }
        } else {
            let request = GeminiRequest {
                contents: vec![GeminiContent {
                    parts: vec![GeminiPart {
                        text: prompt.to_string(),
                    }],
                }],
                generation_config: None,
            };
            self.send_and_parse::<_, GeminiResponse>(&self.api_url(), &request)
                .await
        };

        Ok(match result {
            Ok(_) => ConnectionTestResult {
                success: true,
                error: None,
                model_info: Some(self.model.clone()),
            },
            Err(e) => ConnectionTestResult {
                success: false,
                error: Some(e),
                model_info: None,
            },
        })
    }

    /// Internal method for structured generation with usage tracking
    pub(super) async fn generate_structured_with_usage<T: DeserializeOwned>(
        &self,
        prompt: &str,
        schema: Option<serde_json::Value>,
        schema_name: &str,
    ) -> Result<GenerationResult<T>, String> {
        let (text, usage) = if self.is_openai_compatible() {
            self.generate_openai_with_usage(prompt, schema.as_ref(), schema_name)
                .await?
        } else {
            self.generate_gemini_with_usage(prompt, schema).await?
        };

        // Try to extract JSON from the response (handle markdown code blocks)
        let json_text = extract_json(&text);

        let data: T = serde_json::from_str(&json_text)
            .map_err(|e| format!("Failed to parse JSON response: {}. Raw text: {}", e, text))?;

        Ok(GenerationResult { data, usage })
    }

    /// Try a single Gemini model request, returns (text, usage)
    async fn try_gemini_model(
        &self,
        model: &str,
        prompt: &str,
        schema: &Option<serde_json::Value>,
    ) -> Result<(String, LlmUsage), String> {
        let started = std::time::Instant::now();
        let request = GeminiRequest {
            contents: vec![GeminiContent {
                parts: vec![GeminiPart {
                    text: prompt.to_string(),
                }],
            }],
            generation_config: schema.clone().map(|s| GeminiGenerationConfig {
                response_mime_type: "application/json".to_string(),
                response_schema: Some(s),
            }),
        };

        let result = self
            .send_and_parse::<_, GeminiResponse>(&self.api_url_for_model(model), &request)
            .await;
        match &result {
            Ok(_) => log::info!(
                "[llm][provider] provider='Gemini' model='{}' completed duration_ms={}",
                model,
                started.elapsed().as_millis(),
            ),
            Err(error) => log::warn!(
                "[llm][provider] provider='Gemini' model='{}' failed duration_ms={}: {}",
                model,
                started.elapsed().as_millis(),
                error,
            ),
        }
        result
    }

    async fn generate_gemini_with_usage(
        &self,
        prompt: &str,
        schema: Option<serde_json::Value>,
    ) -> Result<(String, LlmUsage), String> {
        let fallback_chain = self.get_model_fallback_chain();

        // If auto_model is enabled and we have a fallback chain, try each model
        if !fallback_chain.is_empty() {
            let mut last_error = String::new();

            for model in fallback_chain {
                match self.try_gemini_model(model, prompt, &schema).await {
                    Ok((text, usage)) => {
                        log::debug!("[gemini] Request succeeded with model: {}", model);
                        return Ok((text, usage));
                    }
                    Err(e) => {
                        log::warn!("[gemini] Model {} failed, trying next: {}", model, e);
                        last_error = e;
                    }
                }
            }

            // All models failed
            return Err(format!(
                "All Gemini models failed. Last error: {}",
                last_error
            ));
        }

        // No fallback - use the configured model directly
        self.try_gemini_model(&self.model, prompt, &schema).await
    }

    /// Build the `response_format` for a level (None = omit the field).
    fn response_format_for(
        level: ResponseFormatLevel,
        schema: Option<&serde_json::Value>,
        schema_name: &str,
    ) -> Option<OpenAIResponseFormat> {
        match (level, schema) {
            (ResponseFormatLevel::JsonSchema, Some(schema)) => Some(OpenAIResponseFormat {
                format_type: "json_schema".to_string(),
                json_schema: Some(OpenAIJsonSchema {
                    name: sanitize_schema_name(schema_name),
                    strict: true,
                    schema: strict_schema(schema),
                }),
            }),
            (ResponseFormatLevel::Plain, _) => None,
            _ => Some(OpenAIResponseFormat {
                format_type: "json_object".to_string(),
                json_schema: None,
            }),
        }
    }

    /// Try a single OpenAI-compatible model request, returns (text, usage).
    ///
    /// Structured-output ladder: `json_schema` (strict, the feature's real
    /// schema) → on a format rejection (a 400/422 about the response_format,
    /// see [`is_format_rejection`]) `json_object` → no `response_format`.
    /// Genuine rejections are cached ([`format_cache`]). The caller always
    /// parses/validates the reply. A
    /// server that rejects `chat_template_kwargs` gets one retry without it.
    async fn try_openai_model(
        &self,
        model: &str,
        prompt: &str,
        schema: Option<&serde_json::Value>,
        schema_name: &str,
    ) -> Result<(String, LlmUsage), String> {
        let model_key = format!("{}|{}|{}", self.provider_name(), self.api_url(), model);
        let known_rejected = |l: ResponseFormatLevel| is_cached_rejection(&model_key, schema_name, l);
        let mut level = ResponseFormatLevel::initial(schema.is_some()).skip_rejected(&known_rejected);
        let mut thinking_kwargs = self.sends_thinking_kwargs();

        loop {
            let started = std::time::Instant::now();
            let request = OpenAIRequest {
                model: model.to_string(),
                messages: vec![
                    OpenAIMessage {
                        role: "system".to_string(),
                        content: "You are a helpful assistant that responds only with valid JSON. Do not include any markdown formatting or code blocks, just the raw JSON object.".to_string(),
                    },
                    OpenAIMessage {
                        role: "user".to_string(),
                        content: prompt.to_string(),
                    },
                ],
                response_format: Self::response_format_for(level, schema, schema_name),
                temperature: Some(0.0),
                chat_template_kwargs: self.thinking_kwargs(thinking_kwargs),
            };

            let result = self
                .send_and_parse::<_, OpenAIResponse>(&self.api_url(), &request)
                .await;
            match result {
                Ok(ok) => {
                    log::info!(
                        "[llm][provider] provider='{}' model='{}' format={:?} completed duration_ms={}",
                        self.provider_name(),
                        model,
                        level,
                        started.elapsed().as_millis(),
                    );
                    return Ok(ok);
                }
                Err(error) => {
                    log::warn!(
                        "[llm][provider] provider='{}' model='{}' format={:?} failed duration_ms={}: {}",
                        self.provider_name(),
                        model,
                        level,
                        started.elapsed().as_millis(),
                        error,
                    );
                    if thinking_kwargs
                        && is_bad_request(&error)
                        && error.contains("chat_template_kwargs")
                    {
                        thinking_kwargs = false;
                        continue;
                    }
                    // Only a genuine rejection is remembered (it's a property of
                    // the server/model); an empty reply is a one-off.
                    if is_format_rejection(&error) {
                        if let Some(key) = level.rejection_key(&model_key, schema_name) {
                            if let Ok(mut cache) = format_cache().lock() {
                                cache.insert(key);
                            }
                        }
                    }
                    match level.next_after(&error).map(|n| n.skip_rejected(&known_rejected)) {
                        Some(next) => {
                            log::info!(
                                "[llm][provider] provider='{}' model='{}' retrying with format={:?}",
                                self.provider_name(),
                                model,
                                next
                            );
                            level = next;
                        }
                        None => return Err(error),
                    }
                }
            }
        }
    }

    async fn generate_openai_with_usage(
        &self,
        prompt: &str,
        schema: Option<&serde_json::Value>,
        schema_name: &str,
    ) -> Result<(String, LlmUsage), String> {
        let first_error = match self
            .try_openai_model(&self.model, prompt, schema, schema_name)
            .await
        {
            Ok(result) => return Ok(result),
            Err(e) => e,
        };

        // Model fallback (Groq only): quotas are per-model, so siblings from the
        // settings list are tried before giving up. Other OpenAI-compatible
        // providers keep single-model behavior — their model catalogs (and costs)
        // aren't ours to pick from.
        if !matches!(self.provider, LlmProvider::Groq) || !is_retriable_on_other_model(&first_error)
        {
            return Err(first_error);
        }

        let mut last_error = first_error;
        for model in GROQ_FALLBACK_MODELS.iter().filter(|m| **m != self.model) {
            log::warn!(
                "[llm] Groq model failed ({}), falling back to {}",
                last_error,
                model
            );
            match self
                .try_openai_model(model, prompt, schema, schema_name)
                .await
            {
                Ok(result) => {
                    log::info!("[llm] Groq fallback succeeded with model: {}", model);
                    return Ok(result);
                }
                Err(e) => last_error = e,
            }
        }

        Err(format!(
            "All Groq models failed. Last error: {}",
            last_error
        ))
    }
}

/// `json_schema.name` must match `^[a-zA-Z0-9_-]{1,64}$`.
fn sanitize_schema_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .take(64)
        .collect();
    if cleaned.is_empty() {
        "response".to_string()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod response_format_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn schema_requests_start_with_json_schema_and_plain_ones_with_json_object() {
        assert_eq!(ResponseFormatLevel::initial(true), ResponseFormatLevel::JsonSchema);
        assert_eq!(ResponseFormatLevel::initial(false), ResponseFormatLevel::JsonObject);
    }

    #[test]
    fn http_400_walks_the_fallback_ladder() {
        let lm_studio = "API error (400 Bad Request): 'response_format.type' must be 'json_schema' or 'text'";
        assert_eq!(
            ResponseFormatLevel::JsonSchema.next_after(lm_studio),
            Some(ResponseFormatLevel::JsonObject)
        );
        assert_eq!(
            ResponseFormatLevel::JsonObject.next_after(lm_studio),
            Some(ResponseFormatLevel::Plain)
        );
        assert_eq!(ResponseFormatLevel::Plain.next_after(lm_studio), None);
        assert_eq!(
            ResponseFormatLevel::JsonSchema
                .next_after("API error (422 Unprocessable Entity): response_format json_schema is not supported"),
            Some(ResponseFormatLevel::JsonObject)
        );
    }

    #[test]
    fn only_format_related_bad_requests_count_as_rejections() {
        for e in [
            "API error (400 Bad Request): 'response_format.type' must be 'json_schema' or 'text'",
            "API error (400 Bad Request): {\"error\":{\"message\":\"Invalid schema for response_format 'x'\"}}",
            "API error (400 Bad Request): json_object is not supported by this model",
            "API error (422 Unprocessable Entity): strict mode unsupported",
        ] {
            assert!(is_format_rejection(e), "{e}");
        }
        for e in [
            // Generic 400s: no format mention.
            "API error (422 Unprocessable Entity): bad",
            "API error (400 Bad Request): invalid model id",
            // Groq: model produced invalid JSON (would fail the same way unformatted).
            "API error (400 Bad Request): {\"error\":{\"message\":\"Failed to generate JSON. Please adjust your prompt.\",\"code\":\"json_validate_failed\",\"failed_generation\":\"{ schema\"}}",
            // Context overflow mentioning the response_format field name.
            "API error (400 Bad Request): This model's maximum context length is 8192 tokens (response_format included)",
            "API error (400 Bad Request): {\"code\":\"context_length_exceeded\"}",
            // Not a 400 at all.
            "API error (500 Internal Server Error): json_schema crashed",
        ] {
            assert!(!is_format_rejection(e), "{e}");
            assert_eq!(ResponseFormatLevel::JsonSchema.next_after(e), None, "{e}");
        }
        assert!(is_bad_request("API error (400 Bad Request): unknown field chat_template_kwargs"));
    }

    #[test]
    fn rejection_keys_scope_schema_rejections_per_feature() {
        let m = "OpenAI|u|gpt";
        assert_eq!(
            ResponseFormatLevel::JsonSchema.rejection_key(m, "triage"),
            Some("OpenAI|u|gpt|json_schema|triage".into())
        );
        assert_eq!(
            ResponseFormatLevel::JsonObject.rejection_key(m, "triage"),
            ResponseFormatLevel::JsonObject.rejection_key(m, "naming"),
        );
        assert_eq!(ResponseFormatLevel::Plain.rejection_key(m, "x"), None);

        // json_schema rejected for this schema only → json_object.
        let rejected = |l: ResponseFormatLevel| l == ResponseFormatLevel::JsonSchema;
        assert_eq!(
            ResponseFormatLevel::JsonSchema.skip_rejected(rejected),
            ResponseFormatLevel::JsonObject
        );
        // LM Studio: json_object rejected, json_schema fine → schema requests
        // keep json_schema, plain requests go straight to Plain.
        let rejected = |l: ResponseFormatLevel| l == ResponseFormatLevel::JsonObject;
        assert_eq!(
            ResponseFormatLevel::JsonSchema.skip_rejected(rejected),
            ResponseFormatLevel::JsonSchema
        );
        assert_eq!(
            ResponseFormatLevel::JsonObject.skip_rejected(rejected),
            ResponseFormatLevel::Plain
        );
    }

    #[test]
    fn non_format_errors_do_not_fall_back() {
        for e in [
            "API error (401 Unauthorized): bad key",
            "API error (429 Too Many Requests): rate limit",
            "API error (500 Internal Server Error): boom",
            "Request failed: connection refused",
        ] {
            assert_eq!(ResponseFormatLevel::JsonSchema.next_after(e), None, "{e}");
        }
    }

    #[test]
    fn empty_content_only_falls_back_from_json_schema() {
        assert_eq!(
            ResponseFormatLevel::JsonSchema.next_after(EMPTY_CONTENT_ERROR),
            Some(ResponseFormatLevel::JsonObject)
        );
        assert_eq!(ResponseFormatLevel::JsonObject.next_after(EMPTY_CONTENT_ERROR), None);
    }

    #[test]
    fn strict_schema_requires_everything_and_nulls_optionals() {
        let loose = json!({
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "waiting_for": {"type": "string", "enum": ["approval", "input"]},
                "ops": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "op": {"type": "string"},
                            "score": {"type": "integer"}
                        },
                        "required": ["op"]
                    }
                }
            },
            "required": ["name", "ops"]
        });
        let strict = strict_schema(&loose);
        assert_eq!(strict["additionalProperties"], json!(false));
        let mut required: Vec<String> = strict["required"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        required.sort();
        assert_eq!(required, vec!["name", "ops", "waiting_for"]);
        assert_eq!(strict["properties"]["name"]["type"], json!("string"));
        assert_eq!(strict["properties"]["waiting_for"]["type"], json!(["string", "null"]));
        assert_eq!(
            strict["properties"]["waiting_for"]["enum"],
            json!(["approval", "input", null])
        );
        let item = &strict["properties"]["ops"]["items"];
        assert_eq!(item["additionalProperties"], json!(false));
        assert_eq!(item["required"].as_array().unwrap().len(), 2);
        assert_eq!(item["properties"]["score"]["type"], json!(["integer", "null"]));
    }

    #[test]
    fn response_format_payloads() {
        let schema = json!({"type": "object", "properties": {"a": {"type": "string"}}, "required": ["a"]});
        let f = LlmClient::response_format_for(ResponseFormatLevel::JsonSchema, Some(&schema), "meeting triage!")
            .unwrap();
        let v = serde_json::to_value(&f).unwrap();
        assert_eq!(v["type"], "json_schema");
        assert_eq!(v["json_schema"]["name"], "meeting_triage_");
        assert_eq!(v["json_schema"]["strict"], true);
        assert_eq!(v["json_schema"]["schema"]["additionalProperties"], false);

        // Schema level without a schema degrades to json_object.
        let f = LlmClient::response_format_for(ResponseFormatLevel::JsonSchema, None, "x").unwrap();
        assert_eq!(serde_json::to_value(&f).unwrap(), json!({"type": "json_object"}));
        assert!(LlmClient::response_format_for(ResponseFormatLevel::Plain, Some(&schema), "x").is_none());
    }
}
