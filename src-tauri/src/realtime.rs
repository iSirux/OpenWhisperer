use crate::config::{
    MoonshineConfig, RealtimeProvider, SherpaOnnxConfig, SpeachesConfig, VoiceStreamAIConfig,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio::time::{timeout, Duration};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use url::Url;

// ── Common types ──────────────────────────────────────────────────────────────

/// Concrete WebSocket stream type shared by every provider session.
type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

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

/// Uniform interface implemented by every provider session (I4). Dispatched by
/// hand through [`RealtimeSessionType`] (no `dyn`, since these are `async fn`s).
#[allow(async_fn_in_trait)]
trait RealtimeSession {
    async fn send_audio(&mut self, samples: &[i16]) -> Result<(), String>;
    async fn try_recv(&mut self) -> Result<Option<RealtimeResponse>, String>;
    async fn finalize(&mut self) -> Result<String, String>;
    async fn close(&mut self) -> Result<(), String>;
}

// ── Shared helpers ────────────────────────────────────────────────────────────

/// Encode PCM samples as little-endian i16 bytes (the wire format for Vosk and
/// VoiceStreamAI, and — before base64 — for Speaches).
fn pcm_i16_le(samples: &[i16]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for s in samples {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    bytes
}

/// Non-blocking receive: wait up to 10ms for the next text frame and hand it to
/// `parse`. Non-text frames, timeouts and stream-end all map to `Ok(None)`.
async fn ws_try_recv<F>(
    socket: &mut WsStream,
    mut parse: F,
) -> Result<Option<RealtimeResponse>, String>
where
    F: FnMut(&str) -> Result<Option<RealtimeResponse>, String>,
{
    match timeout(Duration::from_millis(10), socket.next()).await {
        Ok(Some(Ok(Message::Text(text)))) => parse(&text),
        Ok(Some(Ok(Message::Close(_)))) => Ok(None),
        Ok(Some(Ok(_))) => Ok(None),
        Ok(Some(Err(e))) => Err(format!("WebSocket error: {}", e)),
        Ok(None) => Ok(None),
        Err(_) => Ok(None),
    }
}

/// Close a WebSocket, mapping errors to a uniform string.
async fn close_ws(socket: &mut WsStream) -> Result<(), String> {
    socket
        .close(None)
        .await
        .map_err(|e| format!("Failed to close WebSocket: {}", e))
}

/// Truncate a string for logging, replacing newlines so a frame stays on one
/// log line (I5). Wraps [`crate::util::truncate_chars`].
fn truncate_for_log(s: &str, max_chars: usize) -> String {
    let flattened = s.replace('\n', "\\n").replace('\r', "\\r");
    crate::util::truncate_chars(&flattened, max_chars)
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
    socket: WsStream,
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

    /// Blocking receive (used by [`finalize`] to drain to the final result).
    async fn recv(&mut self) -> Result<Option<RealtimeResponse>, String> {
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
}

impl RealtimeSession for VoskSession {
    async fn send_audio(&mut self, samples: &[i16]) -> Result<(), String> {
        self.ensure_configured().await?;
        self.socket
            .send(Message::Binary(pcm_i16_le(samples).into()))
            .await
            .map_err(|e| format!("Failed to send audio: {}", e))
    }

    async fn try_recv(&mut self) -> Result<Option<RealtimeResponse>, String> {
        ws_try_recv(&mut self.socket, |text| {
            serde_json::from_str::<RealtimeResponse>(text)
                .map(Some)
                .map_err(|e| format!("Failed to parse Vosk response: {}", e))
        })
        .await
    }

    async fn finalize(&mut self) -> Result<String, String> {
        let eof_msg = serde_json::to_string(&VoskEofMessage { eof: 1 })
            .map_err(|e| format!("Failed to serialize EOF: {}", e))?;

        self.socket
            .send(Message::Text(eof_msg.into()))
            .await
            .map_err(|e| format!("Failed to send EOF: {}", e))?;

        // The server must answer eof with a final result (Vosk and the
        // Moonshine shim both do). Bound the wait so a misbehaving server
        // can't hang the stop path — realtime-first resolves the transcript
        // from this, and an empty tail falls back to batch Whisper.
        let drained = timeout(Duration::from_secs(10), async {
            loop {
                match self.recv().await? {
                    Some(RealtimeResponse::Final { text }) => break Ok::<_, String>(text),
                    Some(RealtimeResponse::Partial { .. }) => continue,
                    None => break Ok(String::new()),
                }
            }
        })
        .await;

        let text = match drained {
            Ok(Ok(text)) => text,
            Ok(Err(e)) => {
                let _ = self.socket.close(None).await;
                return Err(e);
            }
            Err(_) => {
                log::warn!("Realtime finalize timed out waiting for the final result; returning empty tail");
                String::new()
            }
        };

        let _ = self.socket.close(None).await;
        Ok(text)
    }

    async fn close(&mut self) -> Result<(), String> {
        close_ws(&mut self.socket).await
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
    socket: WsStream,
    configured: bool,
    sample_rate: u32,
    chunk_length_seconds: f32,
    chunk_offset_seconds: f32,
    language: String,
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
}

impl RealtimeSession for VoiceStreamAISession {
    /// Send audio samples (PCM i16 LE) to VoiceStreamAI — same wire format as Vosk.
    async fn send_audio(&mut self, samples: &[i16]) -> Result<(), String> {
        self.ensure_configured().await?;
        self.socket
            .send(Message::Binary(pcm_i16_le(samples).into()))
            .await
            .map_err(|e| format!("Failed to send audio: {}", e))
    }

    /// VSAI doesn't distinguish partial vs final — every chunk result is `Final`.
    async fn try_recv(&mut self) -> Result<Option<RealtimeResponse>, String> {
        ws_try_recv(&mut self.socket, |text| {
            match serde_json::from_str::<VsaiResponse>(text) {
                Ok(response) => {
                    let transcription = response.text.unwrap_or_default();
                    if transcription.is_empty() {
                        Ok(None)
                    } else {
                        Ok(Some(RealtimeResponse::Final {
                            text: transcription,
                        }))
                    }
                }
                Err(e) => Err(format!(
                    "Failed to parse VoiceStreamAI response: {} (raw: {})",
                    e, text
                )),
            }
        })
        .await
    }

    /// VoiceStreamAI has no EOF protocol — just close the socket.
    async fn finalize(&mut self) -> Result<String, String> {
        let _ = self.socket.close(None).await;
        Ok(String::new())
    }

    async fn close(&mut self) -> Result<(), String> {
        close_ws(&mut self.socket).await
    }
}

// ── sherpa-onnx internals ────────────────────────────────────────────────────

/// Message from the sherpa-onnx websocket server. Fields are optional so unknown
/// or partial frames don't hard-fail parsing.
#[derive(Debug, Deserialize)]
struct SherpaResponse {
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    is_final: Option<bool>,
    #[serde(default, rename = "final")]
    final_flag: Option<bool>,
}

pub struct SherpaOnnxSession {
    socket: WsStream,
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
}

impl RealtimeSession for SherpaOnnxSession {
    async fn send_audio(&mut self, samples: &[i16]) -> Result<(), String> {
        // sherpa-onnx expects float32 PCM samples normalized to [-1, 1).
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

    async fn try_recv(&mut self) -> Result<Option<RealtimeResponse>, String> {
        let last = &mut self.last_text;
        ws_try_recv(&mut self.socket, |text| parse_sherpa_response(text, last)).await
    }

    async fn finalize(&mut self) -> Result<String, String> {
        if !self.finalized {
            self.finalized = true;
            // sherpa-onnx protocol uses "Done" to flush the final result.
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

    async fn close(&mut self) -> Result<(), String> {
        close_ws(&mut self.socket).await
    }
}

fn parse_sherpa_response(
    raw: &str,
    last_text: &mut String,
) -> Result<Option<RealtimeResponse>, String> {
    // Expected messages include at least: { "text": "...", "segment": N }
    let value: SherpaResponse = serde_json::from_str(raw)
        .map_err(|e| format!("Failed to parse sherpa-onnx response: {} (raw: {})", e, raw))?;

    let text = value.text.unwrap_or_default().trim().to_string();
    if text.is_empty() {
        return Ok(None);
    }

    *last_text = text.clone();

    let is_final = value.is_final.or(value.final_flag).unwrap_or(false);
    if is_final {
        Ok(Some(RealtimeResponse::Final { text }))
    } else {
        Ok(Some(RealtimeResponse::Partial { partial: text }))
    }
}

// ── Speaches internals ───────────────────────────────────────────────────────

pub struct SpeachesSession {
    socket: WsStream,
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

        // In transcription-only mode all config is passed in the WebSocket URL;
        // some Speaches builds break if a session.update is sent afterwards.
        Ok(Self {
            socket,
            partial_by_item: HashMap::new(),
            last_text: String::new(),
            audio_chunks_sent: 0,
        })
    }
}

impl RealtimeSession for SpeachesSession {
    async fn send_audio(&mut self, samples: &[i16]) -> Result<(), String> {
        let pcm = pcm_i16_le(samples);
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

    async fn try_recv(&mut self) -> Result<Option<RealtimeResponse>, String> {
        let partial = &mut self.partial_by_item;
        let last = &mut self.last_text;
        ws_try_recv(&mut self.socket, |text| {
            parse_speaches_event(text, partial, last)
        })
        .await
    }

    async fn finalize(&mut self) -> Result<String, String> {
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
                    let _ =
                        parse_speaches_event(&text, &mut self.partial_by_item, &mut self.last_text);
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

    async fn close(&mut self) -> Result<(), String> {
        close_ws(&mut self.socket).await
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

/// Typed Speaches event (I5). Unknown event types fall through to `Other` so a
/// new server event never hard-fails parsing.
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum SpeachesEvent {
    #[serde(rename = "error")]
    Error { error: Option<SpeachesErrorBody> },
    #[serde(rename = "conversation.item.input_audio_transcription.failed")]
    TranscriptionFailed { error: Option<SpeachesErrorBody> },
    #[serde(rename = "conversation.item.input_audio_transcription.delta")]
    TranscriptionDelta {
        #[serde(default)]
        item_id: Option<String>,
        #[serde(default)]
        delta: Option<String>,
    },
    #[serde(rename = "conversation.item.input_audio_transcription.completed")]
    TranscriptionCompleted {
        #[serde(default)]
        item_id: Option<String>,
        #[serde(default)]
        transcript: Option<String>,
    },
    #[serde(rename = "conversation.item.created")]
    ItemCreated {
        #[serde(default)]
        item: Option<SpeachesItem>,
    },
    #[serde(rename = "response.audio_transcript.delta")]
    ResponseTranscriptDelta {
        #[serde(default)]
        delta: Option<String>,
    },
    #[serde(rename = "response.output_text.delta")]
    ResponseOutputTextDelta {
        #[serde(default)]
        delta: Option<String>,
    },
    #[serde(rename = "response.audio_transcript.done")]
    ResponseTranscriptDone {
        #[serde(default)]
        transcript: Option<String>,
        #[serde(default)]
        text: Option<String>,
    },
    #[serde(rename = "response.output_text.done")]
    ResponseOutputTextDone {
        #[serde(default)]
        transcript: Option<String>,
        #[serde(default)]
        text: Option<String>,
    },
    #[serde(other)]
    Other,
}

#[derive(Debug, Deserialize)]
struct SpeachesErrorBody {
    #[serde(default)]
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SpeachesItem {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    content: Option<Vec<SpeachesContentPart>>,
}

#[derive(Debug, Deserialize)]
struct SpeachesContentPart {
    #[serde(default)]
    transcript: Option<String>,
    #[serde(default)]
    text: Option<String>,
}

fn parse_speaches_event(
    raw: &str,
    partial_by_item: &mut HashMap<String, String>,
    last_text: &mut String,
) -> Result<Option<RealtimeResponse>, String> {
    log::info!("[realtime][speaches] recv: {}", truncate_for_log(raw, 280));

    // Tolerate malformed / unexpected frames instead of surfacing a hard error.
    let event: SpeachesEvent = match serde_json::from_str(raw) {
        Ok(ev) => ev,
        Err(e) => {
            log::warn!(
                "[realtime][speaches] could not parse event: {} (raw: {})",
                e,
                truncate_for_log(raw, 280)
            );
            return Ok(None);
        }
    };

    match event {
        SpeachesEvent::Error { error } => {
            let message = error
                .and_then(|e| e.message)
                .unwrap_or_else(|| "Unknown Speaches error".to_string());
            Err(format!(
                "Speaches error: {} (raw: {})",
                message,
                truncate_for_log(raw, 280)
            ))
        }
        SpeachesEvent::TranscriptionFailed { error } => {
            let message = error
                .and_then(|e| e.message)
                .unwrap_or_else(|| "Speaches transcription failed".to_string());
            Err(format!(
                "Speaches error: {} (raw: {})",
                message,
                truncate_for_log(raw, 280)
            ))
        }
        SpeachesEvent::TranscriptionDelta { item_id, delta } => {
            let item_id = item_id.unwrap_or_else(|| "default".to_string());
            let delta = delta.unwrap_or_default();
            let entry = partial_by_item.entry(item_id.clone()).or_default();
            entry.push_str(&delta);
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
        SpeachesEvent::TranscriptionCompleted { item_id, transcript } => {
            let item_id = item_id.unwrap_or_else(|| "default".to_string());
            let mut text = transcript.unwrap_or_default().trim().to_string();

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
        // Some servers emit the transcript on the created conversation item
        // instead of input_audio_transcription.completed.
        SpeachesEvent::ItemCreated { item } => {
            let item = item.unwrap_or(SpeachesItem {
                id: None,
                content: None,
            });
            let item_id = item.id.unwrap_or_else(|| "default".to_string());

            let mut transcript = String::new();
            if let Some(content) = item.content {
                for part in content {
                    if let Some(t) = part.transcript {
                        transcript.push_str(&t);
                    } else if let Some(t) = part.text {
                        transcript.push_str(&t);
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
        // OpenAI-style transcript deltas (mostly conversation mode).
        SpeachesEvent::ResponseTranscriptDelta { delta }
        | SpeachesEvent::ResponseOutputTextDelta { delta } => {
            let delta = delta.unwrap_or_default().trim().to_string();
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
        SpeachesEvent::ResponseTranscriptDone { transcript, text }
        | SpeachesEvent::ResponseOutputTextDone { transcript, text } => {
            let text = transcript
                .or(text)
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
        SpeachesEvent::Other => {
            log::info!("[realtime][speaches] ignored unrecognized event");
            Ok(None)
        }
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

/// Connect to `url`, send any pre-serialized `messages`, then close (I4). Any
/// send failure reports "Failed to send config"; connect failure reports
/// "Connection failed".
async fn connect_and_check(url: &str, messages: &[String]) -> RealtimeConnectionTestResult {
    match connect_async(url).await {
        Ok((mut ws, _)) => {
            for msg in messages {
                if let Err(e) = ws.send(Message::Text(msg.clone().into())).await {
                    return RealtimeConnectionTestResult {
                        connected: false,
                        error: Some(format!("Failed to send config: {}", e)),
                    };
                }
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

/// Serialize a config value for a connection test, turning a serialization
/// failure into a test result instead of a panic (I4 — removes `.unwrap()`).
fn serialize_or_test_error<T: Serialize>(value: &T) -> Result<String, RealtimeConnectionTestResult> {
    serde_json::to_string(value).map_err(|e| RealtimeConnectionTestResult {
        connected: false,
        error: Some(format!("Failed to serialize config: {}", e)),
    })
}

pub async fn test_vosk_connection(
    endpoint: &str,
    sample_rate: u32,
) -> RealtimeConnectionTestResult {
    let config_msg = VoskConfigMessage {
        config: VoskConfigInner { sample_rate },
    };
    let config_json = match serialize_or_test_error(&config_msg) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let eof_json = match serialize_or_test_error(&VoskEofMessage { eof: 1 }) {
        Ok(s) => s,
        Err(r) => return r,
    };
    connect_and_check(endpoint, &[config_json, eof_json]).await
}

pub async fn test_vsai_connection(endpoint: &str) -> RealtimeConnectionTestResult {
    // Send a minimal config to verify the server accepts connections.
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
    let config_json = match serialize_or_test_error(&config_msg) {
        Ok(s) => s,
        Err(r) => return r,
    };
    connect_and_check(endpoint, &[config_json]).await
}

pub async fn test_sherpa_connection(endpoint: &str) -> RealtimeConnectionTestResult {
    connect_and_check(endpoint, &[]).await
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
    connect_and_check(&ws_url, &[]).await
}

// ── Session manager ───────────────────────────────────────────────────────────

/// A live session plus its polling-loop lifecycle handles (I6).
struct RealtimeEntry {
    session: Arc<Mutex<RealtimeSessionType>>,
    /// Set to stop the polling loop cooperatively.
    cancel: Arc<AtomicBool>,
    /// The polling task, so `stop_polling` can await its exit before finalizing.
    poll: Option<JoinHandle<()>>,
}

/// Manages active real-time transcription sessions
pub struct RealtimeSessionManager {
    sessions: Arc<Mutex<HashMap<String, RealtimeEntry>>>,
}

impl RealtimeSessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    async fn insert_session(&self, session_id: String, session: RealtimeSessionType) {
        let mut sessions = self.sessions.lock().await;
        sessions.insert(
            session_id,
            RealtimeEntry {
                session: Arc::new(Mutex::new(session)),
                cancel: Arc::new(AtomicBool::new(false)),
                poll: None,
            },
        );
    }

    pub async fn create_vosk_session(
        &self,
        session_id: String,
        endpoint: &str,
        sample_rate: u32,
    ) -> Result<(), String> {
        let session = VoskSession::new(endpoint, sample_rate).await?;
        self.insert_session(session_id, RealtimeSessionType::Vosk(session))
            .await;
        Ok(())
    }

    pub async fn create_vsai_session(
        &self,
        session_id: String,
        endpoint: &str,
        config: &VoiceStreamAIConfig,
    ) -> Result<(), String> {
        let session = VoiceStreamAISession::new(endpoint, config).await?;
        self.insert_session(session_id, RealtimeSessionType::VoiceStreamAI(session))
            .await;
        Ok(())
    }

    pub async fn create_sherpa_session(
        &self,
        session_id: String,
        endpoint: &str,
        config: &SherpaOnnxConfig,
    ) -> Result<(), String> {
        let session = SherpaOnnxSession::new(endpoint, config).await?;
        self.insert_session(session_id, RealtimeSessionType::SherpaOnnx(session))
            .await;
        Ok(())
    }

    pub async fn create_speaches_session(
        &self,
        session_id: String,
        config: &SpeachesConfig,
    ) -> Result<(), String> {
        let session = SpeachesSession::new(&config.endpoint, config).await?;
        self.insert_session(session_id, RealtimeSessionType::Speaches(session))
            .await;
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
        moonshine_config: &MoonshineConfig,
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
            // The Moonshine shim server speaks the Vosk protocol, so the
            // session type is a plain VoskSession pointed at its endpoint.
            RealtimeProvider::Moonshine => {
                self.create_vosk_session(
                    session_id,
                    &moonshine_config.endpoint,
                    moonshine_config.sample_rate,
                )
                .await
            }
        }
    }

    pub async fn get_session(&self, session_id: &str) -> Option<Arc<Mutex<RealtimeSessionType>>> {
        let sessions = self.sessions.lock().await;
        sessions.get(session_id).map(|e| e.session.clone())
    }

    /// Cancellation flag for `session_id`'s polling loop, if the session exists.
    pub async fn get_cancel(&self, session_id: &str) -> Option<Arc<AtomicBool>> {
        let sessions = self.sessions.lock().await;
        sessions.get(session_id).map(|e| e.cancel.clone())
    }

    /// Attach the polling-loop join handle so it can be awaited on stop (I6).
    pub async fn set_poll_handle(&self, session_id: &str, handle: JoinHandle<()>) {
        let mut sessions = self.sessions.lock().await;
        if let Some(entry) = sessions.get_mut(session_id) {
            entry.poll = Some(handle);
        }
    }

    /// Signal the polling loop to stop and await its exit (I6). Called before
    /// finalize/close to eliminate the recv-vs-finalize race.
    pub async fn stop_polling(&self, session_id: &str) {
        let (cancel, poll) = {
            let mut sessions = self.sessions.lock().await;
            match sessions.get_mut(session_id) {
                Some(entry) => (Some(entry.cancel.clone()), entry.poll.take()),
                None => (None, None),
            }
        };
        if let Some(cancel) = cancel {
            cancel.store(true, Ordering::Relaxed);
        }
        if let Some(handle) = poll {
            let _ = handle.await;
        }
    }

    pub async fn remove_session(
        &self,
        session_id: &str,
    ) -> Option<Arc<Mutex<RealtimeSessionType>>> {
        let mut sessions = self.sessions.lock().await;
        sessions.remove(session_id).map(|e| {
            e.cancel.store(true, Ordering::Relaxed);
            e.session
        })
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
