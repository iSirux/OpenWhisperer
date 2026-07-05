//! Notify node executor.

use tauri::Manager;

use crate::config::AppConfig;
use crate::sequences::error::SequenceError;
use crate::sequences::executor::{render, SequenceExecutor};
use crate::sequences::notifications::{NotificationSender, NotifyExtra};
use crate::sequences::types::*;

impl SequenceExecutor {
    pub(crate) async fn execute_notify(
        &self,
        _node: &NodeDefinition,
        notify: &NotifyNode,
        context: &serde_json::Value,
        execution_id: &str,
    ) -> Result<Option<serde_json::Value>, SequenceError> {
        let rendered_message = render(&notify.message, context)?;
        let rendered_title = match &notify.title {
            Some(t) => Some(render(t, context)?),
            None => None,
        };
        let title_str = rendered_title.unwrap_or_else(|| "Sequence Notification".to_string());

        log::info!(
            "[sequence][{}] emit notification: title={:?}, play_sound={}, system_notification={}, sound={}",
            crate::util::short_id(execution_id),
            title_str,
            notify.play_sound,
            notify.system_notification,
            notify.sound.unwrap_or(1),
        );

        let payload = serde_json::json!({
            "title": title_str,
            "message": rendered_message,
            "channel": notify.channel,
            "preset": notify.preset,
            "system_notification": notify.system_notification,
            "play_sound": notify.play_sound,
            "sound": notify.sound.unwrap_or(1),
        });
        crate::util::emit_or_log(&self.app, &format!("sequence-notification-{}", execution_id), payload);

        // Also emit a global notification event so the frontend doesn't depend on
        // per-execution listener registration timing.
        let global = serde_json::json!({
            "execution_id": execution_id,
            "title": title_str,
            "message": rendered_message,
            "channel": notify.channel,
            "preset": notify.preset,
            "system_notification": notify.system_notification,
            "play_sound": notify.play_sound,
            "sound": notify.sound.unwrap_or(1),
        });
        crate::util::emit_or_log(&self.app, "sequence-notification", global);

        // Resolve the channel config for external delivery
        let channel_config: Option<crate::config::NotificationChannelConfig> =
            if let Some(ref channel_id) = notify.channel {
                let config: tauri::State<parking_lot::Mutex<AppConfig>> = self.app.state();
                let cfg = config.lock();
                cfg.sequences
                    .notification_channels
                    .iter()
                    .find(|c| c.id == *channel_id)
                    .cloned()
            } else if let Some(ref url) = notify.url {
                Some(crate::config::NotificationChannelConfig {
                    id: "inline".to_string(),
                    name: "Inline Webhook".to_string(),
                    channel_type: crate::config::NotificationChannelType::Webhook,
                    webhook_url: Some(url.clone()),
                    headers: None,
                    enabled: true,
                })
            } else if let Some(ref webhook) = notify.webhook {
                Some(crate::config::NotificationChannelConfig {
                    id: "inline-legacy".to_string(),
                    name: "Inline Webhook (legacy)".to_string(),
                    channel_type: crate::config::NotificationChannelType::Webhook,
                    webhook_url: Some(webhook.clone()),
                    headers: None,
                    enabled: true,
                })
            } else {
                None
            };

        if let Some(ref channel) = channel_config {
            let body = match &notify.body {
                Some(b) => match render(b, context) {
                    Ok(r) => Some(r),
                    Err(e) => {
                        log::warn!(
                            "[sequence] notify body template failed to render ({}); using raw value",
                            e
                        );
                        Some(b.clone())
                    }
                },
                None => None,
            };
            let extra = NotifyExtra {
                blocks: notify.blocks.clone(),
                embed: notify.embed.clone(),
                body,
                method: notify.method.clone(),
                headers: notify.headers.clone(),
            };

            let sender = NotificationSender::new();
            if let Err(err) = sender
                .send(channel, &title_str, &rendered_message, Some(&extra))
                .await
            {
                let on_error = notify.on_notify_error.as_deref().unwrap_or("stop");
                match on_error {
                    "warn" => {
                        log::error!("[notifications] Warning: notification delivery failed: {}", err);
                    }
                    _ => {
                        return Err(SequenceError::command(format!(
                            "Notification delivery failed: {}",
                            err
                        )));
                    }
                }
            }
        }

        Ok(Some(serde_json::json!({ "notified": true, "message": rendered_message })))
    }
}
