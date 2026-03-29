use crate::config::{NotificationChannelConfig, NotificationChannelType};
use std::collections::HashMap;

/// Extra payload options for notification delivery
pub struct NotifyExtra {
    /// Slack Block Kit blocks
    pub blocks: Option<serde_json::Value>,
    /// Discord embed object
    pub embed: Option<serde_json::Value>,
    /// Custom webhook body template (already rendered)
    pub body: Option<String>,
    /// HTTP method override (default POST)
    pub method: Option<String>,
    /// Additional headers (merged with channel-level headers)
    pub headers: Option<HashMap<String, String>>,
}

pub struct NotificationSender {
    client: reqwest::Client,
}

impl NotificationSender {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
        }
    }

    /// Send a notification to the given channel (external integrations only).
    /// System notifications and sounds are handled by the frontend via Tauri events.
    pub async fn send(
        &self,
        channel: &NotificationChannelConfig,
        title: &str,
        message: &str,
        extra: Option<&NotifyExtra>,
    ) -> Result<(), String> {
        match channel.channel_type {
            NotificationChannelType::Slack => self.send_slack(channel, title, message, extra).await,
            NotificationChannelType::Discord => {
                self.send_discord(channel, title, message, extra).await
            }
            NotificationChannelType::Webhook => {
                self.send_webhook(channel, title, message, extra).await
            }
        }
    }

    /// Send a Slack notification via incoming webhook.
    async fn send_slack(
        &self,
        channel: &NotificationChannelConfig,
        title: &str,
        message: &str,
        extra: Option<&NotifyExtra>,
    ) -> Result<(), String> {
        let webhook_url = channel
            .webhook_url
            .as_deref()
            .ok_or("Slack channel has no webhook_url configured")?;

        let body = if let Some(extra) = extra {
            if let Some(ref blocks) = extra.blocks {
                serde_json::json!({
                    "text": format!("*{}*\n{}", title, message),
                    "blocks": blocks,
                })
            } else {
                serde_json::json!({
                    "text": format!("*{}*\n{}", title, message),
                })
            }
        } else {
            serde_json::json!({
                "text": format!("*{}*\n{}", title, message),
            })
        };

        let resp = self
            .client
            .post(webhook_url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Slack webhook request failed: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body_text = resp
                .text()
                .await
                .unwrap_or_else(|_| "<failed to read body>".to_string());
            return Err(format!("Slack webhook returned {} — {}", status, body_text));
        }

        log::info!("[notifications] Slack notification sent to {}", webhook_url);
        Ok(())
    }

    /// Send a Discord notification via webhook.
    async fn send_discord(
        &self,
        channel: &NotificationChannelConfig,
        title: &str,
        message: &str,
        extra: Option<&NotifyExtra>,
    ) -> Result<(), String> {
        let webhook_url = channel
            .webhook_url
            .as_deref()
            .ok_or("Discord channel has no webhook_url configured")?;

        let body = if let Some(extra) = extra {
            if let Some(ref embed) = extra.embed {
                serde_json::json!({
                    "embeds": [embed],
                })
            } else {
                serde_json::json!({
                    "embeds": [{
                        "title": title,
                        "description": message,
                        "color": 5814783,
                    }],
                })
            }
        } else {
            serde_json::json!({
                "embeds": [{
                    "title": title,
                    "description": message,
                    "color": 5814783,
                }],
            })
        };

        let resp = self
            .client
            .post(webhook_url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Discord webhook request failed: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body_text = resp
                .text()
                .await
                .unwrap_or_else(|_| "<failed to read body>".to_string());
            return Err(format!(
                "Discord webhook returned {} — {}",
                status, body_text
            ));
        }

        log::info!(
            "[notifications] Discord notification sent to {}",
            webhook_url
        );
        Ok(())
    }

    /// Send a notification to a generic webhook endpoint.
    async fn send_webhook(
        &self,
        channel: &NotificationChannelConfig,
        title: &str,
        message: &str,
        extra: Option<&NotifyExtra>,
    ) -> Result<(), String> {
        let webhook_url = channel
            .webhook_url
            .as_deref()
            .ok_or("Webhook channel has no webhook_url configured")?;

        // Determine HTTP method (default POST)
        let method_str = extra.and_then(|e| e.method.as_deref()).unwrap_or("POST");

        let method = match method_str.to_uppercase().as_str() {
            "GET" => reqwest::Method::GET,
            "POST" => reqwest::Method::POST,
            "PUT" => reqwest::Method::PUT,
            "PATCH" => reqwest::Method::PATCH,
            "DELETE" => reqwest::Method::DELETE,
            other => return Err(format!("Unsupported HTTP method: {}", other)),
        };

        // Build request
        let mut request = self.client.request(method, webhook_url);

        // Merge headers: channel-level first, then extra headers (extra wins)
        let mut merged_headers = HashMap::new();
        if let Some(ref channel_headers) = channel.headers {
            for (k, v) in channel_headers {
                merged_headers.insert(k.clone(), v.clone());
            }
        }
        if let Some(extra) = extra {
            if let Some(ref extra_headers) = extra.headers {
                for (k, v) in extra_headers {
                    merged_headers.insert(k.clone(), v.clone());
                }
            }
        }

        // Apply merged headers
        for (key, value) in &merged_headers {
            request = request.header(key.as_str(), value.as_str());
        }

        // Build body
        let body_string = if let Some(extra) = extra {
            if let Some(ref body) = extra.body {
                body.clone()
            } else {
                serde_json::to_string(&serde_json::json!({
                    "title": title,
                    "message": message,
                }))
                .map_err(|e| format!("Failed to serialize webhook body: {}", e))?
            }
        } else {
            serde_json::to_string(&serde_json::json!({
                "title": title,
                "message": message,
            }))
            .map_err(|e| format!("Failed to serialize webhook body: {}", e))?
        };

        // Set Content-Type if not already in merged headers
        if !merged_headers
            .keys()
            .any(|k| k.to_lowercase() == "content-type")
        {
            request = request.header("Content-Type", "application/json");
        }

        let resp = request
            .body(body_string)
            .send()
            .await
            .map_err(|e| format!("Webhook request failed: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body_text = resp
                .text()
                .await
                .unwrap_or_else(|_| "<failed to read body>".to_string());
            return Err(format!("Webhook returned {} — {}", status, body_text));
        }

        log::info!(
            "[notifications] Webhook notification sent to {}",
            webhook_url
        );
        Ok(())
    }
}
