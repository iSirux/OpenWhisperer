//! Provider-specific API implementations (Gemini, OpenAI-compatible)

use serde::de::DeserializeOwned;

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

impl LlmClient {
    /// Test connection to the LLM API
    pub async fn test_connection(&self) -> Result<ConnectionTestResult, String> {
        let prompt = "Say 'Hello' in one word.";

        if self.is_openai_compatible() {
            self.test_connection_openai(prompt).await
        } else {
            self.test_connection_gemini(prompt).await
        }
    }

    async fn test_connection_gemini(&self, prompt: &str) -> Result<ConnectionTestResult, String> {
        let request = GeminiRequest {
            contents: vec![GeminiContent {
                parts: vec![GeminiPart {
                    text: prompt.to_string(),
                }],
            }],
            generation_config: None,
        };

        match self
            .client
            .post(&self.api_url())
            .json(&request)
            .send()
            .await
        {
            Ok(response) => {
                if response.status().is_success() {
                    match response.json::<GeminiResponse>().await {
                        Ok(resp) => {
                            if let Some(error) = resp.error {
                                Ok(ConnectionTestResult {
                                    success: false,
                                    error: Some(error.message),
                                    model_info: None,
                                })
                            } else {
                                Ok(ConnectionTestResult {
                                    success: true,
                                    error: None,
                                    model_info: Some(self.model.clone()),
                                })
                            }
                        }
                        Err(e) => Ok(ConnectionTestResult {
                            success: false,
                            error: Some(format!("Failed to parse response: {}", e)),
                            model_info: None,
                        }),
                    }
                } else {
                    let error_text = response.text().await.unwrap_or_default();
                    Ok(ConnectionTestResult {
                        success: false,
                        error: Some(format!("API error: {}", error_text)),
                        model_info: None,
                    })
                }
            }
            Err(e) => Ok(ConnectionTestResult {
                success: false,
                error: Some(format!("Request failed: {}", e)),
                model_info: None,
            }),
        }
    }

    async fn test_connection_openai(&self, prompt: &str) -> Result<ConnectionTestResult, String> {
        let request = OpenAIRequest {
            model: self.model.clone(),
            messages: vec![OpenAIMessage {
                role: "user".to_string(),
                content: prompt.to_string(),
            }],
            response_format: None,
            temperature: Some(0.0),
        };

        let mut req = self.client.post(&self.api_url()).json(&request);

        // Add Authorization header for non-local providers
        if !matches!(self.provider, LlmProvider::Local) && !self.api_key.is_empty() {
            req = req.header("Authorization", format!("Bearer {}", self.api_key));
        }

        match req.send().await {
            Ok(response) => {
                if response.status().is_success() {
                    match response.json::<OpenAIResponse>().await {
                        Ok(resp) => {
                            if let Some(error) = resp.error {
                                Ok(ConnectionTestResult {
                                    success: false,
                                    error: Some(error.message),
                                    model_info: None,
                                })
                            } else {
                                Ok(ConnectionTestResult {
                                    success: true,
                                    error: None,
                                    model_info: Some(self.model.clone()),
                                })
                            }
                        }
                        Err(e) => Ok(ConnectionTestResult {
                            success: false,
                            error: Some(format!("Failed to parse response: {}", e)),
                            model_info: None,
                        }),
                    }
                } else {
                    let error_text = response.text().await.unwrap_or_default();
                    Ok(ConnectionTestResult {
                        success: false,
                        error: Some(format!("API error: {}", error_text)),
                        model_info: None,
                    })
                }
            }
            Err(e) => Ok(ConnectionTestResult {
                success: false,
                error: Some(format!("Request failed: {}", e)),
                model_info: None,
            }),
        }
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

        let response = self
            .client
            .post(&self.api_url_for_model(model))
            .json(&request)
            .send()
            .await
            .map_err(|e| format!("Request failed: {}", e))?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(format!("Gemini API error ({}): {}", model, error_text));
        }

        let gemini_response: GeminiResponse = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        if let Some(error) = gemini_response.error {
            return Err(format!("Gemini error ({}): {}", model, error.message));
        }

        // Extract usage data
        let usage = gemini_response
            .usage_metadata
            .map(|u| LlmUsage {
                input_tokens: u.prompt_token_count.unwrap_or(0),
                output_tokens: u.candidates_token_count.unwrap_or(0),
                total_tokens: u.total_token_count.unwrap_or(0),
            })
            .unwrap_or_default();

        let text = gemini_response
            .candidates
            .and_then(|c| c.into_iter().next())
            .and_then(|c| c.content.parts.into_iter().next())
            .map(|p| p.text)
            .ok_or_else(|| format!("No response from Gemini ({})", model))?;

        Ok((text, usage))
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
                        // Log which model succeeded (helpful for debugging)
                        log::error!("[gemini] Request succeeded with model: {}", model);
                        return Ok((text, usage));
                    }
                    Err(e) => {
                        log::error!("[gemini] Model {} failed, trying next: {}", model, e);
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

        let mut req = self.client.post(&self.api_url()).json(&request);

        // Add Authorization header for non-local providers
        if !matches!(self.provider, LlmProvider::Local) && !self.api_key.is_empty() {
            req = req.header("Authorization", format!("Bearer {}", self.api_key));
        }

        let response = req
            .send()
            .await
            .map_err(|e| format!("Request failed: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(format!("API error ({}): {}", status, error_text));
        }

        let openai_response: OpenAIResponse = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        if let Some(error) = openai_response.error {
            return Err(format!("API error: {}", error.message));
        }

        // Extract usage data
        let usage = openai_response
            .usage
            .map(|u| LlmUsage {
                input_tokens: u.prompt_tokens.unwrap_or(0),
                output_tokens: u.completion_tokens.unwrap_or(0),
                total_tokens: u.total_tokens.unwrap_or(0),
            })
            .unwrap_or_default();

        let text = openai_response
            .choices
            .and_then(|c| c.into_iter().next())
            .map(|c| c.message.content)
            .ok_or_else(|| "No response from API".to_string())?;

        Ok((text, usage))
    }
}
