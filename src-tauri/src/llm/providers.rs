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
            .map(|c| c.message.content)
            .ok_or_else(|| "No response from API".to_string())?;

        Ok((text, usage))
    }
}

impl LlmClient {
    /// Attach the Authorization header for OpenAI-compatible, non-local providers
    /// that have a key. Gemini authenticates via the URL query string, so it is
    /// intentionally excluded here.
    fn add_auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if self.is_openai_compatible()
            && !matches!(self.provider, LlmProvider::Local)
            && !self.api_key.is_empty()
        {
            req.header("Authorization", format!("Bearer {}", self.api_key))
        } else {
            req
        }
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
            };
            self.send_and_parse::<_, OpenAIResponse>(&self.api_url(), &request)
                .await
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
    ) -> Result<GenerationResult<T>, String> {
        let (text, usage) = if self.is_openai_compatible() {
            self.generate_openai_with_usage(prompt).await?
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

        self.send_and_parse::<_, GeminiResponse>(&self.api_url_for_model(model), &request)
            .await
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

    async fn generate_openai_with_usage(&self, prompt: &str) -> Result<(String, LlmUsage), String> {
        let request = OpenAIRequest {
            model: self.model.clone(),
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
            response_format: Some(OpenAIResponseFormat {
                format_type: "json_object".to_string(),
            }),
            temperature: Some(0.0),
        };

        self.send_and_parse::<_, OpenAIResponse>(&self.api_url(), &request)
            .await
    }
}
