use crate::config::{RealtimeProvider, SherpaOnnxConfig, SpeachesConfig, VoiceStreamAIConfig};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use url::Url;

// ── Common types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RealtimeConnectionTestResult {
    pub connected: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RealtimeResponse {
    Partial { partial: String },
    Final { text: String },
}

// ── Vosk internals ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
struct VoskConfigMessage {
    config: VoskConfigInner,
}

#[derive(Debug, Serialize)]
struct VoskConfigInner {
    sample_rate: u32,
}

#[derive(Debug, Serialize)]
struct VoskEofMessage {
    eof: u8,
}

pub struct VoskSession {
    socket: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    configured: bool,
    sample_rate: u32,
}

impl VoskSession {
    pub async fn new(endpoint: &str, sample_rate: u32) -> Result<Self, String> {
        let (socket, _) = connect_async(endpoint)
            .await
            .map_err(|e| format!("Failed to connect to Vosk server: {}", e))?;

        Ok(Self {
            socket,
            configured: false,
            sample_rate,
        })
    }

    async fn ensure_configured(&mut self) -> Result<(), String> {
        if !self.configured {
            let config_msg = VoskConfigMessage {
                config: VoskConfigInner {
                    sample_rate: self.sample_rate,
                },
            };
            let config_json = serde_json::to_string(&config_msg)
                .map_err(|e| format!("Failed to serialize config: {}", e))?;

            self.socket
                .send(Message::Text(config_json.into()))
                .await
                .map_err(|e| format!("Failed to send config: {}", e))?;

            self.configured = true;
        }
        Ok(())
    }

    pub async fn send_audio(&mut self, samples: &[i16]) -> Result<(), String> {
        self.ensure_configured().await?;

        let bytes: Vec<u8> = samples
            .iter()
            .flat_map(|s| s.to_le_bytes())
            .collect();

        self.socket
            .send(Message::Binary(bytes.into()))
            .await
            .map_err(|e| format!("Failed to send audio: {}", e))
    }

    pub async fn recv(&mut self) -> Result<Option<RealtimeResponse>, String> {
        match self.socket.next().await {
            Some(Ok(Message::Text(text))) => {
                let response: RealtimeResponse = serde_json::from_str(&text)
                    .map_err(|e| format!("Failed to parse Vosk response: {}", e))?;
                Ok(Some(response))
            }
            Some(Ok(Message::Close(_))) => Ok(None),
            Some(Ok(_)) => Ok(None),
            Some(Err(e)) => Err(format!("WebSocket error: {}", e)),
            None => Ok(None),
        }
    }

    pub async fn try_recv(&mut self) -> Result<Option<RealtimeResponse>, String> {
        use tokio::time::{timeout, Duration};

        match timeout(Duration::from_millis(10), self.socket.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                let response: RealtimeResponse = serde_json::from_str(&text)
                    .map_err(|e| format!("Failed to parse Vosk response: {}", e))?;
                Ok(Some(response))
            }
            Ok(Some(Ok(Message::Close(_)))) => Ok(None),
            Ok(Some(Ok(_))) => Ok(None),
            Ok(Some(Err(e))) => Err(format!("WebSocket error: {}", e)),
            Ok(None) => Ok(None),
            Err(_) => Ok(None),
        }
    }

    pub async fn finalize(&mut self) -> Result<String, String> {
        let eof_msg = serde_json::to_string(&VoskEofMessage { eof: 1 })
            .map_err(|e| format!("Failed to serialize EOF: {}", e))?;

        self.socket
            .send(Message::Text(eof_msg.into()))
            .await
            .map_err(|e| format!("Failed to send EOF: {}", e))?;

        loop {
            match self.recv().await? {
                Some(RealtimeResponse::Final { text }) => {
                    let _ = self.socket.close(None).await;
                    return Ok(text);
                }
                Some(RealtimeResponse::Partial { .. }) => continue,
                None => {
                    let _ = self.socket.close(None).await;
                    return Ok(String::new());
                }
            }
        }
    }

    pub async fn close(&mut self) -> Result<(), String> {
        self.socket
            .close(None)
            .await
            .map_err(|e| format!("Failed to close WebSocket: {}", e))
    }
}

// ── VoiceStreamAI internals ───────────────────────────────────────────────────

/// Config message sent to VoiceStreamAI server on connection
#[derive(Debug, Serialize)]
struct VsaiConfigMessage {
    #[serde(rename = "type")]
    msg_type: String,
    data: VsaiConfigData,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VsaiConfigData {
    sample_rate: u32,
    channels: u8,
    language: Option<String>,
    processing_strategy: String,
    processing_args: VsaiProcessingArgs,
}

#[derive(Debug, Serialize)]
struct VsaiProcessingArgs {
    chunk_length_seconds: f32,
    chunk_offset_seconds: f32,
}

/// Response from VoiceStreamAI server
#[derive(Debug, Deserialize)]
struct VsaiResponse {
    text: Option<String>,
    #[allow(dead_code)]
    language: Option<String>,
    #[allow(dead_code)]
    processing_time: Option<f64>,
}

pub struct VoiceStreamAISession {
    socket: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    configured: bool,
    sample_rate: u32,
    chunk_length_seconds: f32,
    chunk_offset_seconds: f32,
    language: String,
}

// ── sherpa-onnx internals ────────────────────────────────────────────────────

pub struct SherpaOnnxSession {
    socket: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    finalized: bool,
    last_text: String,
}

impl SherpaOnnxSession {
    pub async fn new(endpoint: &str, _config: &SherpaOnnxConfig) -> Result<Self, String> {
        let (socket, _) = connect_async(endpoint)
            .await
            .map_err(|e| format!("Failed to connect to sherpa-onnx server: {}", e))?;

        Ok(Self {
            socket,
            finalized: false,
            last_text: String::new(),
        })
    }

    pub async fn send_audio(&mut self, samples: &[i16]) -> Result<(), String> {
        // sherpa-onnx websocket server expects float32 PCM samples.
        let mut bytes = Vec::with_capacity(samples.len() * 4);
        for sample in samples {
            let normalized = (*sample as f32) / 32768.0;
            bytes.extend_from_slice(&normalized.to_le_bytes());
        }

        self.socket
            .send(Message::Binary(bytes.into()))
            .await
            .map_err(|e| format!("Failed to send audio: {}", e))
    }

    pub async fn try_recv(&mut self) -> Result<Option<RealtimeResponse>, String> {
        use tokio::time::{timeout, Duration};

        match timeout(Duration::from_millis(10), self.socket.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => parse_sherpa_response(&text, &mut self.last_text),
            Ok(Some(Ok(Message::Close(_)))) => Ok(None),
            Ok(Some(Ok(_))) => Ok(None),
            Ok(Some(Err(e))) => Err(format!("WebSocket error: {}", e)),
            Ok(None) => Ok(None),
            Err(_) => Ok(None),
        }
    }

    pub async fn finalize(&mut self) -> Result<String, String> {
        use tokio::time::{timeout, Duration};

        if !self.finalized {
            self.finalized = true;
            // sherpa-onnx websocket protocol uses "Done" to flush final result.
            let _ = self.socket.send(Message::Text("Done".into())).await;
        }

        // Drain remaining messages briefly to capture final text, then close.
        for _ in 0..50 {
            match timeout(Duration::from_millis(20), self.socket.next()).await {
                Ok(Some(Ok(Message::Text(text)))) => {
                    let _ = parse_sherpa_response(&text, &mut self.last_text);
                }
                Ok(Some(Ok(Message::Close(_)))) => break,
                Ok(Some(Ok(_))) => {}
                Ok(Some(Err(_))) => break,
                Ok(None) => break,
                Err(_) => break,
            }
        }

        let _ = self.socket.close(None).await;
        Ok(self.last_text.clone())
    }

    pub async fn close(&mut self) -> Result<(), String> {
        self.socket
            .close(None)
            .await
            .map_err(|e| format!("Failed to close WebSocket: {}", e))
    }
}

fn parse_sherpa_response(
    raw: &str,
    last_text: &mut String,
) -> Result<Option<RealtimeResponse>, String> {
    // Expected messages from sherpa-onnx websocket server include at least:
    // { "text": "...", "segment": N }
    let value: Value = serde_json::from_str(raw)
        .map_err(|e| format!("Failed to parse sherpa-onnx response: {} (raw: {})", e, raw))?;

    let text = value
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();

    if text.is_empty() {
        return Ok(None);
    }

    *last_text = text.clone();

    let is_final = value
        .get("is_final")
        .and_then(|v| v.as_bool())
        .or_else(|| value.get("final").and_then(|v| v.as_bool()))
        .unwrap_or(false);

    if is_final {
        Ok(Some(RealtimeResponse::Final { text }))
    } else {
        Ok(Some(RealtimeResponse::Partial { partial: text }))
    }
}

// ── Speaches internals ───────────────────────────────────────────────────────

pub struct SpeachesSession {
    socket: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    configured: bool,
    partial_by_item: HashMap<String, String>,
    last_text: String,
    audio_chunks_sent: u64,
}

impl SpeachesSession {
    pub async fn new(endpoint: &str, config: &SpeachesConfig) -> Result<Self, String> {
        let ws_url = build_speaches_ws_url(endpoint, config)?;
        let (socket, _) = connect_async(&ws_url)
            .await
            .map_err(|e| format!("Failed to connect to Speaches server: {}", e))?;

        Ok(Self {
            socket,
            // In transcription-only mode we pass all config in the WebSocket URL.
            // Some Speaches builds have issues when a session.update is sent here.
            configured: true,
            partial_by_item: HashMap::new(),
            last_text: String::new(),
            audio_chunks_sent: 0,
        })
    }

    async fn ensure_configured(&mut self) -> Result<(), String> {
        if self.configured {
            return Ok(());
        }

        self.configured = true;
        Ok(())
    }

    pub async fn send_audio(&mut self, samples: &[i16]) -> Result<(), String> {
        self.ensure_configured().await?;

        let pcm: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        let audio_b64 = BASE64.encode(&pcm);

        let append_msg = serde_json::json!({
            "type": "input_audio_buffer.append",
            "audio": audio_b64
        });

        self.socket
            .send(Message::Text(append_msg.to_string().into()))
            .await
            .map_err(|e| format!("Failed to send Speaches audio: {}", e))?;

        self.audio_chunks_sent += 1;
        if self.audio_chunks_sent % 25 == 0 {
            log::info!(
                "[realtime][speaches] sent {} audio chunks (last chunk samples: {}, bytes: {})",
                self.audio_chunks_sent,
                samples.len(),
                pcm.len()
            );
        }

        Ok(())
    }

    pub async fn try_recv(&mut self) -> Result<Option<RealtimeResponse>, String> {
        use tokio::time::{timeout, Duration};

        match timeout(Duration::from_millis(10), self.socket.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                parse_speaches_event(&text, &mut self.partial_by_item, &mut self.last_text)
            }
            Ok(Some(Ok(Message::Close(_)))) => Ok(None),
            Ok(Some(Ok(_))) => Ok(None),
            Ok(Some(Err(e))) => Err(format!("WebSocket error: {}", e)),
            Ok(None) => Ok(None),
            Err(_) => Ok(None),
        }
    }

    pub async fn finalize(&mut self) -> Result<String, String> {
        use tokio::time::{timeout, Duration};

        let _ = self.ensure_configured().await;
        let commit_msg = serde_json::json!({ "type": "input_audio_buffer.commit" });
        let _ = self
            .socket
            .send(Message::Text(commit_msg.to_string().into()))
            .await;
        log::info!(
            "[realtime][speaches] sent input_audio_buffer.commit after {} chunks",
            self.audio_chunks_sent
        );

        for _ in 0..50 {
            match timeout(Duration::from_millis(20), self.socket.next()).await {
                Ok(Some(Ok(Message::Text(text)))) => {
                    log::info!(
                        "[realtime][speaches] recv(finalize): {}",
                        truncate_for_log(&text, 280)
                    );
                    let _ = parse_speaches_event(
                        &text,
                        &mut self.partial_by_item,
                        &mut self.last_text,
                    );
                }
                Ok(Some(Ok(Message::Close(_)))) => break,
                Ok(Some(Ok(_))) => {}
                Ok(Some(Err(_))) => break,
                Ok(None) => break,
                Err(_) => break,
            }
        }

        let _ = self.socket.close(None).await;
        Ok(self.last_text.clone())
    }

    pub async fn close(&mut self) -> Result<(), String> {
        self.socket
            .close(None)
            .await
            .map_err(|e| format!("Failed to close WebSocket: {}", e))
    }
}

fn build_speaches_ws_url(endpoint: &str, config: &SpeachesConfig) -> Result<String, String> {
    let mut url = Url::parse(endpoint)
        .map_err(|e| format!("Invalid Speaches endpoint URL '{}': {}", endpoint, e))?;

    let existing_keys: Vec<String> = url.query_pairs().map(|(k, _)| k.to_string()).collect();
    {
        let mut pairs = url.query_pairs_mut();
        if !existing_keys.iter().any(|k| k == "intent") {
            pairs.append_pair("intent", "transcription");
        }
        if !existing_keys.iter().any(|k| k == "model") {
            pairs.append_pair("model", &config.model);
        }
        if !existing_keys.iter().any(|k| k == "transcription_model") {
            pairs.append_pair("transcription_model", &config.model);
        }
        if !existing_keys.iter().any(|k| k == "language") {
            pairs.append_pair("language", "en");
        }
        if !existing_keys.iter().any(|k| k == "api_key") {
            if let Some(api_key) = &config.api_key {
                if !api_key.trim().is_empty() {
                    pairs.append_pair("api_key", api_key);
                }
            }
        }
    }

    Ok(url.to_string())
}

fn parse_speaches_event(
    raw: &str,
    partial_by_item: &mut HashMap<String, String>,
    last_text: &mut String,
) -> Result<Option<RealtimeResponse>, String> {
    log::info!(
        "[realtime][speaches] recv: {}",
        truncate_for_log(raw, 280)
    );

    let value: Value = serde_json::from_str(raw)
        .map_err(|e| format!("Failed to parse Speaches response: {} (raw: {})", e, raw))?;

    let event_type = value
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or_default();

    match event_type {
        "error" => {
            let message = value
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("Unknown Speaches error");
            Err(format!(
                "Speaches error: {} (raw: {})",
                message,
                truncate_for_log(raw, 280)
            ))
        }
        "conversation.item.input_audio_transcription.failed" => {
            let message = value
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("Speaches transcription failed");
            Err(format!(
                "Speaches error: {} (raw: {})",
                message,
                truncate_for_log(raw, 280)
            ))
        }
        "conversation.item.input_audio_transcription.delta" => {
            let item_id = value
                .get("item_id")
                .and_then(|v| v.as_str())
                .unwrap_or("default")
                .to_string();
            let delta = value
                .get("delta")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let entry = partial_by_item.entry(item_id.clone()).or_default();
            entry.push_str(delta);
            let partial = entry.trim().to_string();
            if partial.is_empty() {
                Ok(None)
            } else {
                log::info!(
                    "[realtime][speaches] parsed delta item_id={} len={} text={}",
                    item_id,
                    partial.len(),
                    truncate_for_log(&partial, 160)
                );
                Ok(Some(RealtimeResponse::Partial { partial }))
            }
        }
        "conversation.item.input_audio_transcription.completed" => {
            let item_id = value
                .get("item_id")
                .and_then(|v| v.as_str())
                .unwrap_or("default")
                .to_string();
            let mut text = value
                .get("transcript")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .trim()
                .to_string();

            if text.is_empty() {
                if let Some(accumulated) = partial_by_item.get(&item_id) {
                    text = accumulated.trim().to_string();
                }
            }

            partial_by_item.remove(&item_id);

            if text.is_empty() {
                Ok(None)
            } else {
                *last_text = text.clone();
                log::info!(
                    "[realtime][speaches] parsed completed item_id={} len={} text={}",
                    item_id,
                    text.len(),
                    truncate_for_log(&text, 160)
                );
                Ok(Some(RealtimeResponse::Final { text }))
            }
        }
        // Some servers emit transcript on the created conversation item instead of
        // emitting input_audio_transcription.completed.
        "conversation.item.created" => {
            let item_id = value
                .get("item")
                .and_then(|item| item.get("id"))
                .and_then(|v| v.as_str())
                .unwrap_or("default")
                .to_string();

            let mut transcript = String::new();
            if let Some(content) = value
                .get("item")
                .and_then(|item| item.get("content"))
                .and_then(|v| v.as_array())
            {
                for part in content {
                    if let Some(t) = part.get("transcript").and_then(|v| v.as_str()) {
                        transcript.push_str(t);
                    } else if let Some(t) = part.get("text").and_then(|v| v.as_str()) {
                        transcript.push_str(t);
                    }
                }
            }

            let transcript = transcript.trim().to_string();
            if transcript.is_empty() {
                Ok(None)
            } else {
                partial_by_item.remove(&item_id);
                *last_text = transcript.clone();
                log::info!(
                    "[realtime][speaches] parsed conversation.item.created item_id={} len={} text={}",
                    item_id,
                    transcript.len(),
                    truncate_for_log(&transcript, 160)
                );
                Ok(Some(RealtimeResponse::Final { text: transcript }))
            }
        }
        // OpenAI-style transcript events (mostly conversation mode).
        "response.audio_transcript.delta" | "response.output_text.delta" => {
            let delta = value
                .get("delta")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .trim()
                .to_string();
            if delta.is_empty() {
                Ok(None)
            } else {
                let mut partial = last_text.clone();
                partial.push_str(&delta);
                log::info!(
                    "[realtime][speaches] parsed response delta len={} text={}",
                    partial.len(),
                    truncate_for_log(&partial, 160)
                );
                Ok(Some(RealtimeResponse::Partial { partial }))
            }
        }
        "response.audio_transcript.done" | "response.output_text.done" => {
            let text = value
                .get("transcript")
                .and_then(|v| v.as_str())
                .or_else(|| value.get("text").and_then(|v| v.as_str()))
                .unwrap_or_default()
                .trim()
                .to_string();
            if text.is_empty() {
                Ok(None)
            } else {
                *last_text = text.clone();
                log::info!(
                    "[realtime][speaches] parsed response done len={} text={}",
                    text.len(),
                    truncate_for_log(&text, 160)
                );
                Ok(Some(RealtimeResponse::Final { text }))
            }
        }
        _ => {
            if !event_type.is_empty() {
                log::info!("[realtime][speaches] ignored event type: {}", event_type);
            }
            Ok(None)
        }
    }
}

fn truncate_for_log(s: &str, max_chars: usize) -> String {
    let mut out = s.replace('\n', "\\n").replace('\r', "\\r");
    if out.chars().count() > max_chars {
        out = out.chars().take(max_chars).collect::<String>() + "...";
    }
    out
}

impl VoiceStreamAISession {
    pub async fn new(endpoint: &str, config: &VoiceStreamAIConfig) -> Result<Self, String> {
        let (socket, _) = connect_async(endpoint)
            .await
            .map_err(|e| format!("Failed to connect to VoiceStreamAI server: {}", e))?;

        Ok(Self {
            socket,
            configured: false,
            sample_rate: config.sample_rate,
            chunk_length_seconds: config.chunk_length_seconds,
            chunk_offset_seconds: config.chunk_offset_seconds,
            language: config.language.clone(),
        })
    }

    async fn ensure_configured(&mut self) -> Result<(), String> {
        if !self.configured {
            let lang = if self.language == "multilanguage" {
                None
            } else {
                Some(self.language.clone())
            };

            let config_msg = VsaiConfigMessage {
                msg_type: "config".to_string(),
                data: VsaiConfigData {
                    sample_rate: self.sample_rate,
                    channels: 1,
                    language: lang,
                    processing_strategy: "silence_at_end_of_chunk".to_string(),
                    processing_args: VsaiProcessingArgs {
                        chunk_length_seconds: self.chunk_length_seconds,
                        chunk_offset_seconds: self.chunk_offset_seconds,
                    },
                },
            };

            let config_json = serde_json::to_string(&config_msg)
                .map_err(|e| format!("Failed to serialize VoiceStreamAI config: {}", e))?;

            self.socket
                .send(Message::Text(config_json.into()))
                .await
                .map_err(|e| format!("Failed to send VoiceStreamAI config: {}", e))?;

            self.configured = true;
        }
        Ok(())
    }

    /// Send audio samples (PCM i16) to VoiceStreamAI
    /// Same binary format as Vosk: i16 little-endian PCM
    pub async fn send_audio(&mut self, samples: &[i16]) -> Result<(), String> {
        self.ensure_configured().await?;

        let bytes: Vec<u8> = samples
            .iter()
            .flat_map(|s| s.to_le_bytes())
            .collect();

        self.socket
            .send(Message::Binary(bytes.into()))
            .await
            .map_err(|e| format!("Failed to send audio: {}", e))
    }

    /// Try to receive without blocking (returns immediately if no message)
    /// Maps VoiceStreamAI responses to RealtimeResponse::Final since VSAI
    /// doesn't distinguish partial vs final — all results are chunk transcriptions
    pub async fn try_recv(&mut self) -> Result<Option<RealtimeResponse>, String> {
        use tokio::time::{timeout, Duration};

        match timeout(Duration::from_millis(10), self.socket.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                match serde_json::from_str::<VsaiResponse>(&text) {
                    Ok(response) => {
                        let transcription = response.text.unwrap_or_default();
                        if transcription.is_empty() {
                            Ok(None)
                        } else {
                            Ok(Some(RealtimeResponse::Final { text: transcription }))
                        }
                    }
                    Err(e) => Err(format!("Failed to parse VoiceStreamAI response: {} (raw: {})", e, text)),
                }
            }
            Ok(Some(Ok(Message::Close(_)))) => Ok(None),
            Ok(Some(Ok(_))) => Ok(None),
            Ok(Some(Err(e))) => Err(format!("WebSocket error: {}", e)),
            Ok(None) => Ok(None),
            Err(_) => Ok(None),
        }
    }

    /// VoiceStreamAI doesn't have an EOF protocol — just close the socket
    pub async fn finalize(&mut self) -> Result<String, String> {
        let _ = self.socket.close(None).await;
        Ok(String::new())
    }

    pub async fn close(&mut self) -> Result<(), String> {
        self.socket
            .close(None)
            .await
            .map_err(|e| format!("Failed to close WebSocket: {}", e))
    }
}

// ── Provider-neutral session enum ─────────────────────────────────────────────

pub enum RealtimeSessionType {
    Vosk(VoskSession),
    VoiceStreamAI(VoiceStreamAISession),
    SherpaOnnx(SherpaOnnxSession),
    Speaches(SpeachesSession),
}

impl RealtimeSessionType {
    pub async fn send_audio(&mut self, samples: &[i16]) -> Result<(), String> {
        match self {
            Self::Vosk(s) => s.send_audio(samples).await,
            Self::VoiceStreamAI(s) => s.send_audio(samples).await,
            Self::SherpaOnnx(s) => s.send_audio(samples).await,
            Self::Speaches(s) => s.send_audio(samples).await,
        }
    }

    pub async fn try_recv(&mut self) -> Result<Option<RealtimeResponse>, String> {
        match self {
            Self::Vosk(s) => s.try_recv().await,
            Self::VoiceStreamAI(s) => s.try_recv().await,
            Self::SherpaOnnx(s) => s.try_recv().await,
            Self::Speaches(s) => s.try_recv().await,
        }
    }

    pub async fn finalize(&mut self) -> Result<String, String> {
        match self {
            Self::Vosk(s) => s.finalize().await,
            Self::VoiceStreamAI(s) => s.finalize().await,
            Self::SherpaOnnx(s) => s.finalize().await,
            Self::Speaches(s) => s.finalize().await,
        }
    }

    pub async fn close(&mut self) -> Result<(), String> {
        match self {
            Self::Vosk(s) => s.close().await,
            Self::VoiceStreamAI(s) => s.close().await,
            Self::SherpaOnnx(s) => s.close().await,
            Self::Speaches(s) => s.close().await,
        }
    }
}

// ── Connection testing ────────────────────────────────────────────────────────

pub async fn test_vosk_connection(endpoint: &str, sample_rate: u32) -> RealtimeConnectionTestResult {
    match connect_async(endpoint).await {
        Ok((mut ws, _)) => {
            let config_msg = VoskConfigMessage {
                config: VoskConfigInner { sample_rate },
            };
            let config_json = serde_json::to_string(&config_msg).unwrap();

            if let Err(e) = ws.send(Message::Text(config_json.into())).await {
                return RealtimeConnectionTestResult {
                    connected: false,
                    error: Some(format!("Failed to send config: {}", e)),
                };
            }

            let eof_msg = serde_json::to_string(&VoskEofMessage { eof: 1 }).unwrap();
            let _ = ws.send(Message::Text(eof_msg.into())).await;
            let _ = ws.close(None).await;

            RealtimeConnectionTestResult {
                connected: true,
                error: None,
            }
        }
        Err(e) => RealtimeConnectionTestResult {
            connected: false,
            error: Some(format!("Connection failed: {}", e)),
        },
    }
}

pub async fn test_vsai_connection(endpoint: &str) -> RealtimeConnectionTestResult {
    match connect_async(endpoint).await {
        Ok((mut ws, _)) => {
            // Send a minimal config to verify the server accepts connections
            let config_msg = VsaiConfigMessage {
                msg_type: "config".to_string(),
                data: VsaiConfigData {
                    sample_rate: 16000,
                    channels: 1,
                    language: Some("en".to_string()),
                    processing_strategy: "silence_at_end_of_chunk".to_string(),
                    processing_args: VsaiProcessingArgs {
                        chunk_length_seconds: 3.0,
                        chunk_offset_seconds: 0.1,
                    },
                },
            };
            let config_json = serde_json::to_string(&config_msg).unwrap();

            if let Err(e) = ws.send(Message::Text(config_json.into())).await {
                return RealtimeConnectionTestResult {
                    connected: false,
                    error: Some(format!("Failed to send config: {}", e)),
                };
            }

            let _ = ws.close(None).await;

            RealtimeConnectionTestResult {
                connected: true,
                error: None,
            }
        }
        Err(e) => RealtimeConnectionTestResult {
            connected: false,
            error: Some(format!("Connection failed: {}", e)),
        },
    }
}

pub async fn test_sherpa_connection(endpoint: &str) -> RealtimeConnectionTestResult {
    match connect_async(endpoint).await {
        Ok((mut ws, _)) => {
            let _ = ws.close(None).await;
            RealtimeConnectionTestResult {
                connected: true,
                error: None,
            }
        }
        Err(e) => RealtimeConnectionTestResult {
            connected: false,
            error: Some(format!("Connection failed: {}", e)),
        },
    }
}

pub async fn test_speaches_connection(config: &SpeachesConfig) -> RealtimeConnectionTestResult {
    let ws_url = match build_speaches_ws_url(&config.endpoint, config) {
        Ok(url) => url,
        Err(e) => {
            return RealtimeConnectionTestResult {
                connected: false,
                error: Some(e),
            };
        }
    };

    match connect_async(&ws_url).await {
        Ok((mut ws, _)) => {
            let _ = ws.close(None).await;
            RealtimeConnectionTestResult {
                connected: true,
                error: None,
            }
        }
        Err(e) => RealtimeConnectionTestResult {
            connected: false,
            error: Some(format!("Connection failed: {}", e)),
        },
    }
}

// ── Session manager ───────────────────────────────────────────────────────────

/// Manages active real-time transcription sessions
pub struct RealtimeSessionManager {
    sessions: Arc<Mutex<HashMap<String, Arc<Mutex<RealtimeSessionType>>>>>,
}

impl RealtimeSessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn create_vosk_session(
        &self,
        session_id: String,
        endpoint: &str,
        sample_rate: u32,
    ) -> Result<(), String> {
        let session = VoskSession::new(endpoint, sample_rate).await?;
        let mut sessions = self.sessions.lock().await;
        sessions.insert(
            session_id,
            Arc::new(Mutex::new(RealtimeSessionType::Vosk(session))),
        );
        Ok(())
    }

    pub async fn create_vsai_session(
        &self,
        session_id: String,
        endpoint: &str,
        config: &VoiceStreamAIConfig,
    ) -> Result<(), String> {
        let session = VoiceStreamAISession::new(endpoint, config).await?;
        let mut sessions = self.sessions.lock().await;
        sessions.insert(
            session_id,
            Arc::new(Mutex::new(RealtimeSessionType::VoiceStreamAI(session))),
        );
        Ok(())
    }

    pub async fn create_sherpa_session(
        &self,
        session_id: String,
        endpoint: &str,
        config: &SherpaOnnxConfig,
    ) -> Result<(), String> {
        let session = SherpaOnnxSession::new(endpoint, config).await?;
        let mut sessions = self.sessions.lock().await;
        sessions.insert(
            session_id,
            Arc::new(Mutex::new(RealtimeSessionType::SherpaOnnx(session))),
        );
        Ok(())
    }

    pub async fn create_speaches_session(
        &self,
        session_id: String,
        config: &SpeachesConfig,
    ) -> Result<(), String> {
        let session = SpeachesSession::new(&config.endpoint, config).await?;
        let mut sessions = self.sessions.lock().await;
        sessions.insert(
            session_id,
            Arc::new(Mutex::new(RealtimeSessionType::Speaches(session))),
        );
        Ok(())
    }

    pub async fn create_session(
        &self,
        session_id: String,
        provider: &RealtimeProvider,
        vosk_endpoint: &str,
        vosk_sample_rate: u32,
        vsai_config: &VoiceStreamAIConfig,
        sherpa_config: &SherpaOnnxConfig,
        speaches_config: &SpeachesConfig,
    ) -> Result<(), String> {
        match provider {
            RealtimeProvider::Vosk => {
                self.create_vosk_session(session_id, vosk_endpoint, vosk_sample_rate)
                    .await
            }
            RealtimeProvider::VoiceStreamAI => {
                self.create_vsai_session(session_id, &vsai_config.endpoint, vsai_config)
                    .await
            }
            RealtimeProvider::SherpaOnnx => {
                self.create_sherpa_session(session_id, &sherpa_config.endpoint, sherpa_config)
                    .await
            }
            RealtimeProvider::Speaches => {
                self.create_speaches_session(session_id, speaches_config)
                    .await
            }
        }
    }

    pub async fn get_session(
        &self,
        session_id: &str,
    ) -> Option<Arc<Mutex<RealtimeSessionType>>> {
        let sessions = self.sessions.lock().await;
        sessions.get(session_id).cloned()
    }

    pub async fn remove_session(&self, session_id: &str) -> Option<Arc<Mutex<RealtimeSessionType>>> {
        let mut sessions = self.sessions.lock().await;
        sessions.remove(session_id)
    }

    pub async fn close_session(&self, session_id: &str) -> Result<String, String> {
        if let Some(session) = self.remove_session(session_id).await {
            let mut session = session.lock().await;
            session.finalize().await
        } else {
            Err(format!("Session {} not found", session_id))
        }
    }
}

impl Default for RealtimeSessionManager {
    fn default() -> Self {
        Self::new()
    }
}
