//! Batch (Whisper-style) transcription client.
//!
//! One request path serves every provider:
//! - **Local / OpenAI / Groq / Custom** speak the OpenAI-compatible
//!   `multipart/form-data` `/v1/audio/transcriptions` API.
//! - **OpenRouter** uses its documented JSON body with base64 audio
//!   (`input_audio: { data, format }`) — see
//!   <https://openrouter.ai/docs/guides/overview/multimodal/stt> and
//!   <https://openrouter.ai/blog/tutorials/transcription-on-openrouter/>.
//!
//! `transcribe_audio` (dictation) and `transcribe_detailed` (meeting segments,
//! with timestamps/speakers where the provider returns them) both go through
//! [`transcribe_with`].

use crate::config::{WhisperConfig, WhisperProvider};
use base64::Engine as _;
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionTestResult {
    pub health_ok: bool,
    pub health_error: Option<String>,
    pub transcription_ok: bool,
    pub transcription_error: Option<String>,
}

/// One timestamped piece of a transcript (seconds relative to the audio start).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TranscribeSegment {
    pub start: f64,
    pub end: f64,
    pub text: String,
    /// Diarization label as returned by the provider (e.g. `"0"`, `"1"`), if any.
    pub speaker: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TranscribeOutput {
    pub text: String,
    /// Empty when the provider doesn't return segments.
    pub segments: Vec<TranscribeSegment>,
}

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Floor for the per-request total timeout (see [`request_timeout`]).
const MIN_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
/// Retries (after the first attempt) for remote API providers.
const MAX_RETRIES: usize = 2;
/// A read-timeout means the full clip was already uploaded and processed for
/// that long — re-upload it at most this many times.
const MAX_TIMEOUT_RETRIES: usize = 1;
/// Whisper's prompt window is ~224 tokens; keep the tail of long context.
const MAX_PROMPT_CHARS: usize = 800;
/// Conservative (low) bitrate for compressed audio when estimating duration:
/// 16 kbps. Underestimating the bitrate overestimates the duration, which only
/// makes the timeout more generous.
const COMPRESSED_BYTES_PER_SEC: f64 = 2000.0;

/// Shared client: connect timeout only. The total timeout is set per request
/// from the clip length ([`request_timeout`]) — a fixed cap cut off long local
/// dictations on CPU faster-whisper.
fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// Estimated audio duration in seconds: exact for PCM WAV (header byte rate),
/// a deliberately generous guess for compressed formats.
fn estimate_audio_secs(audio: &[u8], format: AudioFormat) -> f64 {
    if format == AudioFormat::Wav && audio.len() >= 44 {
        let byte_rate = u32::from_le_bytes([audio[28], audio[29], audio[30], audio[31]]) as f64;
        if byte_rate > 0.0 {
            return (audio.len() - 44) as f64 / byte_rate;
        }
    }
    audio.len() as f64 / COMPRESSED_BYTES_PER_SEC
}

/// Total timeout for one transcription request, scaled with the clip length.
/// Local servers (often CPU faster-whisper, slower than real time on large
/// models) get 4× the audio duration; hosted APIs 1× (they're fast, the
/// headroom covers upload). Always at least [`MIN_REQUEST_TIMEOUT`].
fn request_timeout(local: bool, audio_secs: f64) -> Duration {
    let factor = if local { 4.0 } else { 1.0 };
    let secs = 60.0 + audio_secs.max(0.0) * factor;
    Duration::from_secs_f64(secs).max(MIN_REQUEST_TIMEOUT)
}

/// Map a reqwest failure. A connect-phase failure (refused, DNS, connect
/// timeout) means the server is unreachable; any other timeout means it was
/// reached and is still working — never report that as unreachable, or the
/// Docker-autostart path re-sends the whole clip.
fn classify_send_error(e: reqwest::Error, timeout: Duration) -> AttemptError {
    if e.is_timeout() && !e.is_connect() {
        AttemptError::Timeout(format!(
            "Transcription timed out after {}s (the server is reachable but didn't finish in time): {}",
            timeout.as_secs(),
            e
        ))
    } else {
        AttemptError::Network(e.to_string())
    }
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/// Transcribe one audio clip, asking for segment timestamps (and speaker labels
/// on OpenRouter's MAI-Transcribe) where the provider supports it.
///
/// Used by the meeting pipeline. `file_name`/`mime` describe the actual audio
/// format (e.g. `"seg-0003.wav"`, `"audio/wav"`); `prompt` is optional context
/// (previous segment tail + vocabulary).
pub async fn transcribe_detailed(
    config: &WhisperConfig,
    audio: Vec<u8>,
    file_name: &str,
    mime: &str,
    prompt: Option<&str>,
) -> Result<TranscribeOutput, String> {
    transcribe_with(config, audio, file_name, mime, prompt, true).await
}

/// Plain-text transcription with the format sniffed from the bytes (dictation:
/// MediaRecorder WebM/Opus). Same request path as [`transcribe_detailed`].
pub async fn transcribe_text(
    config: &WhisperConfig,
    audio: Vec<u8>,
    prompt: Option<&str>,
) -> Result<String, String> {
    let fmt = AudioFormat::sniff(&audio).unwrap_or(AudioFormat::Webm);
    let name = format!("audio.{}", fmt.extension());
    transcribe_with(config, audio, &name, fmt.mime(), prompt, false)
        .await
        .map(|o| o.text)
}

/// Build the effective config for a provider override (meeting mode's
/// `transcription_provider`/`_model`/`_api_key`/`_endpoint`).
///
/// With an override provider:
/// - **key**: the override key if set; else the base key only when the
///   provider is unchanged (a key saved for another provider is never sent);
///   else `None` — OpenRouter then falls back to an LLM profile key in
///   `commands::audio_cmds::resolve_whisper_api_key`.
/// - **endpoint**: the override endpoint if set; else unchanged when the
///   provider is unchanged; else the provider preset (Local: the default local
///   server). Custom has no preset → empty, which [`transcribe_with`] rejects
///   with a clear error instead of posting to the dictation endpoint.
/// - **model**: the override model if set; else the provider default when the
///   provider changed.
///
/// Without an override provider only the model override applies (the
/// key/endpoint fields belong to the override provider).
pub fn config_with_override(
    base: &WhisperConfig,
    provider: Option<WhisperProvider>,
    model: Option<String>,
    api_key: Option<String>,
    endpoint: Option<String>,
) -> WhisperConfig {
    let nonempty = |s: Option<String>| s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let mut cfg = base.clone();
    if let Some(p) = provider {
        let api_key = nonempty(api_key);
        let endpoint = nonempty(endpoint);
        if p != base.provider {
            cfg.endpoint = endpoint
                .or_else(|| p.preset_endpoint().map(str::to_string))
                .unwrap_or_else(|| match p {
                    WhisperProvider::Local => crate::config::DEFAULT_LOCAL_WHISPER_ENDPOINT.to_string(),
                    _ => String::new(),
                });
            if let Some(m) = p.default_model() {
                cfg.model = m.to_string();
            }
            cfg.api_key = api_key;
            cfg.provider = p;
        } else {
            if let Some(ep) = endpoint {
                cfg.endpoint = ep;
            }
            if let Some(k) = api_key {
                cfg.api_key = Some(k);
            }
        }
    }
    if let Some(m) = nonempty(model) {
        cfg.model = m;
    }
    cfg
}

/// Test endpoint health + a tiny transcription request.
pub async fn test_connection(config: &WhisperConfig) -> ConnectionTestResult {
    let mut result = ConnectionTestResult {
        health_ok: false,
        health_error: None,
        transcription_ok: false,
        transcription_error: None,
    };

    let mut health = http_client().get(health_url(&config.provider, &config.endpoint));
    if config.provider == WhisperProvider::OpenRouter {
        // GET /api/v1/key validates the key (the only "health" OpenRouter has).
        health = health.bearer_auth(config.api_key.clone().unwrap_or_default());
    }
    match health.timeout(Duration::from_secs(15)).send().await {
        Ok(r) if r.status().is_success() => result.health_ok = true,
        Ok(r) => {
            result.health_error = Some(format!("Health check returned status {}", r.status()))
        }
        Err(e) => result.health_error = Some(format!("Health check failed: {}", e)),
    }

    // Minimal WAV (silence) — also wakes a sleeping local container.
    match transcribe_with(config, generate_minimal_wav(), "test.wav", "audio/wav", None, false)
        .await
    {
        Ok(_) => result.transcription_ok = true,
        Err(e) => result.transcription_error = Some(e),
    }
    result
}

// ---------------------------------------------------------------------------
// Shared request path
// ---------------------------------------------------------------------------

#[derive(Debug)]
enum AttemptError {
    /// reqwest-level failure (refused / timeout / DNS). Formatted with the
    /// `"Request failed"` prefix that `audio_cmds::is_connection_error` keys on.
    Network(String),
    /// The server was reached but the request exceeded its total timeout.
    /// Deliberately NOT `"Request failed"`-prefixed: it isn't "unreachable".
    Timeout(String),
    Status { code: u16, body: String, retry_after: Option<u64> },
    Parse(String),
}

impl AttemptError {
    fn retryable(&self) -> bool {
        match self {
            AttemptError::Network(_) | AttemptError::Timeout(_) => true,
            AttemptError::Status { code, .. } => *code == 429 || *code >= 500,
            AttemptError::Parse(_) => false,
        }
    }

    fn into_message(self) -> String {
        match self {
            AttemptError::Network(e) => format!("Request failed: {}", e),
            AttemptError::Timeout(e) => e,
            AttemptError::Status { code, body, .. } => {
                format!("Whisper API error ({}): {}", code, body)
            }
            AttemptError::Parse(e) => format!("Failed to parse response: {}", e),
        }
    }
}

pub(crate) async fn transcribe_with(
    config: &WhisperConfig,
    audio: Vec<u8>,
    file_name: &str,
    mime: &str,
    prompt: Option<&str>,
    detailed: bool,
) -> Result<TranscribeOutput, String> {
    // Dictation uses exactly the configured endpoint; provider presets are only
    // substituted in the override path (`config_with_override`).
    let endpoint = config.endpoint.trim();
    if endpoint.is_empty() {
        return Err(format!(
            "No transcription endpoint configured for the {:?} provider",
            config.provider
        ));
    }
    let format = AudioFormat::from_hint(file_name, mime)
        .or_else(|| AudioFormat::sniff(&audio))
        .unwrap_or(AudioFormat::Wav);
    let prompt = prompt.map(clamp_prompt).filter(|p| !p.is_empty());
    let mut verbose = detailed && wants_verbose(&config.provider, &config.model);
    let remote = config.provider.is_remote_api(endpoint);
    let retries = if remote { MAX_RETRIES } else { 0 };
    let timeout = request_timeout(!remote, estimate_audio_secs(&audio, format));

    let mut attempt = 0usize;
    let mut timeouts = 0usize;
    loop {
        let res = send_once(
            config,
            endpoint,
            &audio,
            file_name,
            format,
            prompt.as_deref(),
            verbose,
            timeout,
        )
        .await;
        if matches!(res, Err(AttemptError::Timeout(_))) {
            timeouts += 1;
        }
        match res {
            Ok(out) => return Ok(out),
            // Some models/servers reject verbose_json with a 400/422 — drop it
            // once and retry immediately with plain JSON (doesn't count as a retry).
            Err(AttemptError::Status { code: 400 | 422, .. }) if verbose => {
                log::warn!(
                    "Transcription: {} rejected verbose_json, retrying with plain json",
                    config.model
                );
                verbose = false;
            }
            Err(e) if should_retry(&e, attempt, retries, timeouts) => {
                let delay = backoff_delay(attempt, &e);
                log::warn!(
                    "Transcription attempt {} failed ({:?}), retrying in {:?}",
                    attempt + 1,
                    e,
                    delay
                );
                tokio::time::sleep(delay).await;
                attempt += 1;
            }
            Err(e) => return Err(e.into_message()),
        }
    }
}

/// Whether to retry after `err`. `timeouts` counts read-timeouts so far
/// (including this one): a timed-out clip is re-uploaded at most
/// [`MAX_TIMEOUT_RETRIES`] times even when the general budget allows more.
fn should_retry(err: &AttemptError, attempt: usize, retries: usize, timeouts: usize) -> bool {
    err.retryable()
        && attempt < retries
        && (!matches!(err, AttemptError::Timeout(_)) || timeouts <= MAX_TIMEOUT_RETRIES)
}

fn backoff_delay(attempt: usize, err: &AttemptError) -> Duration {
    if let AttemptError::Status { retry_after: Some(secs), .. } = err {
        return Duration::from_secs((*secs).clamp(1, 10));
    }
    // 1 s, 3 s
    Duration::from_millis(1000 * (2 * attempt as u64 + 1))
}

async fn send_once(
    config: &WhisperConfig,
    endpoint: &str,
    audio: &[u8],
    file_name: &str,
    format: AudioFormat,
    prompt: Option<&str>,
    verbose: bool,
    timeout: Duration,
) -> Result<TranscribeOutput, AttemptError> {
    let api_key = config.api_key.as_deref().filter(|k| !k.is_empty());

    let mut request = if config.provider == WhisperProvider::OpenRouter {
        let body = openrouter_body(&config.model, &config.language, audio, format, prompt, verbose);
        http_client()
            .post(endpoint)
            .header("HTTP-Referer", "https://github.com/iSirux/OpenWhisperer")
            .header("X-Title", "OpenWhisperer")
            .json(&body)
    } else {
        let part = Part::bytes(audio.to_vec())
            .file_name(file_name.to_string())
            .mime_str(format.mime())
            .map_err(|e| AttemptError::Parse(format!("Failed to create part: {}", e)))?;
        let mut form = Form::new().part("file", part).text("model", config.model.clone());
        if let Some(lang) = language_param(&config.language) {
            form = form.text("language", lang.to_string());
        }
        if let Some(p) = prompt {
            form = form.text("prompt", p.to_string());
        }
        if verbose {
            // Segments are the verbose_json default; no timestamp_granularities needed.
            form = form.text("response_format", "verbose_json");
        }
        http_client().post(endpoint).multipart(form)
    };

    if let Some(key) = api_key {
        request = request.bearer_auth(key);
    }

    let response = request
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| classify_send_error(e, timeout))?;

    let status = response.status();
    if !status.is_success() {
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok());
        let body = response.text().await.unwrap_or_default();
        return Err(AttemptError::Status { code: status.as_u16(), body, retry_after });
    }

    let body = response
        .text()
        .await
        .map_err(|e| classify_send_error(e, timeout))?;
    parse_transcription_response(&body).map_err(AttemptError::Parse)
}

/// JSON body for OpenRouter's `/api/v1/audio/transcriptions`.
///
/// Verified against the STT guide: `model`, `input_audio.{data (raw base64, no
/// data: URI), format}`, `language`, `response_format: json|verbose_json`,
/// `timestamp_granularities`, and `provider.options.<slug>` passthrough (only
/// the serving provider's options are forwarded). The documented examples are
/// `groq.prompt` and, for `microsoft/mai-transcribe-2`,
/// `azure.diarization.enabled`.
/// UNVERIFIED: `openai.prompt` (by analogy with groq); whether MAI-Transcribe
/// accepts `webm` input (the guide lists webm as a general format).
fn openrouter_body(
    model: &str,
    language: &str,
    audio: &[u8],
    format: AudioFormat,
    prompt: Option<&str>,
    verbose: bool,
) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": model,
        "input_audio": {
            "data": base64::engine::general_purpose::STANDARD.encode(audio),
            "format": format.openrouter_format(),
        },
    });
    if let Some(lang) = language_param(language) {
        body["language"] = lang.into();
    }
    let mut options = serde_json::Map::new();
    if let Some(p) = prompt {
        // Top-level `prompt` is ignored by OpenRouter; pass it per provider.
        options.insert("groq".into(), serde_json::json!({ "prompt": p }));
        options.insert("openai".into(), serde_json::json!({ "prompt": p }));
    }
    if verbose {
        body["response_format"] = "verbose_json".into();
        body["timestamp_granularities"] = serde_json::json!(["segment", "word"]);
        if is_mai_model(model) {
            options.insert(
                "azure".into(),
                serde_json::json!({ "diarization": { "enabled": true } }),
            );
        }
    }
    if !options.is_empty() {
        body["provider"] = serde_json::json!({ "options": options });
    }
    body
}

fn is_mai_model(model: &str) -> bool {
    model.starts_with("microsoft/mai-transcribe")
}

/// Whether to request `verbose_json` (segment timestamps) for this provider/model.
fn wants_verbose(provider: &WhisperProvider, model: &str) -> bool {
    match provider {
        // faster-whisper-server / speaches support verbose_json.
        WhisperProvider::Local | WhisperProvider::Groq | WhisperProvider::OpenRouter => true,
        // gpt-4o-*-transcribe only support json/text; whisper-1 supports verbose_json.
        WhisperProvider::OpenAI => model.starts_with("whisper"),
        // Unknown server: stick to the plain contract.
        WhisperProvider::Custom => false,
    }
}

fn health_url(provider: &WhisperProvider, endpoint: &str) -> String {
    match provider {
        WhisperProvider::OpenRouter => "https://openrouter.ai/api/v1/key".to_string(),
        _ => endpoint.replace("/v1/audio/transcriptions", "/health"),
    }
}

fn language_param(language: &str) -> Option<&str> {
    let l = language.trim();
    if l.is_empty() || l.eq_ignore_ascii_case("auto") {
        None
    } else {
        Some(l)
    }
}

fn clamp_prompt(prompt: &str) -> String {
    let p = prompt.trim();
    let count = p.chars().count();
    if count <= MAX_PROMPT_CHARS {
        return p.to_string();
    }
    p.chars().skip(count - MAX_PROMPT_CHARS).collect()
}

/// Parse an OpenAI-style `json` / `verbose_json` transcription response.
/// `speaker` may be a number (OpenRouter's documented example: `"speaker": 0`)
/// or a string; both are normalized to a string label.
pub(crate) fn parse_transcription_response(body: &str) -> Result<TranscribeOutput, String> {
    let v: serde_json::Value = serde_json::from_str(body.trim())
        .map_err(|e| format!("{} (body: {})", e, truncate(body, 200)))?;

    let segments: Vec<TranscribeSegment> = v
        .get("segments")
        .and_then(|s| s.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|seg| {
                    let text = seg.get("text")?.as_str()?.trim().to_string();
                    let start = seg.get("start").and_then(|x| x.as_f64()).unwrap_or(0.0);
                    let end = seg.get("end").and_then(|x| x.as_f64()).unwrap_or(start);
                    let speaker = match seg.get("speaker") {
                        Some(serde_json::Value::String(s)) if !s.is_empty() => Some(s.clone()),
                        Some(serde_json::Value::Number(n)) => Some(n.to_string()),
                        _ => None,
                    };
                    Some(TranscribeSegment { start, end, text, speaker })
                })
                .collect()
        })
        .unwrap_or_default();

    let text = match v.get("text").and_then(|t| t.as_str()) {
        Some(t) => t.trim().to_string(),
        None if !segments.is_empty() => segments
            .iter()
            .map(|s| s.text.as_str())
            .collect::<Vec<_>>()
            .join(" "),
        None => return Err(format!("missing \"text\" (body: {})", truncate(body, 200))),
    };

    Ok(TranscribeOutput { text, segments })
}

fn truncate(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

// ---------------------------------------------------------------------------
// Audio format detection
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioFormat {
    Wav,
    Webm,
    Ogg,
    Mp3,
    Flac,
    M4a,
    Aac,
}

impl AudioFormat {
    pub fn extension(self) -> &'static str {
        match self {
            AudioFormat::Wav => "wav",
            AudioFormat::Webm => "webm",
            AudioFormat::Ogg => "ogg",
            AudioFormat::Mp3 => "mp3",
            AudioFormat::Flac => "flac",
            AudioFormat::M4a => "m4a",
            AudioFormat::Aac => "aac",
        }
    }

    pub fn mime(self) -> &'static str {
        match self {
            AudioFormat::Wav => "audio/wav",
            AudioFormat::Webm => "audio/webm",
            AudioFormat::Ogg => "audio/ogg",
            AudioFormat::Mp3 => "audio/mpeg",
            AudioFormat::Flac => "audio/flac",
            AudioFormat::M4a => "audio/mp4",
            AudioFormat::Aac => "audio/aac",
        }
    }

    /// `input_audio.format` value (OpenRouter: wav, mp3, flac, m4a, ogg, webm, aac).
    pub fn openrouter_format(self) -> &'static str {
        self.extension()
    }

    /// Detect from magic bytes.
    pub fn sniff(bytes: &[u8]) -> Option<Self> {
        if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE" {
            Some(AudioFormat::Wav)
        } else if bytes.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
            // EBML header: WebM (MediaRecorder) / Matroska.
            Some(AudioFormat::Webm)
        } else if bytes.starts_with(b"OggS") {
            Some(AudioFormat::Ogg)
        } else if bytes.starts_with(b"fLaC") {
            Some(AudioFormat::Flac)
        } else if bytes.len() >= 8 && &bytes[4..8] == b"ftyp" {
            Some(AudioFormat::M4a)
        } else if bytes.starts_with(b"ID3")
            || (bytes.len() >= 2 && bytes[0] == 0xFF && (bytes[1] & 0xE0) == 0xE0)
        {
            // MPEG frame sync; ADTS AAC shares 0xFFF but has layer bits 00.
            if bytes[0] == 0xFF && (bytes[1] & 0x06) == 0 {
                Some(AudioFormat::Aac)
            } else {
                Some(AudioFormat::Mp3)
            }
        } else {
            None
        }
    }

    /// Detect from a MIME type (parameters like `;codecs=opus` ignored), then
    /// the file extension.
    pub fn from_hint(file_name: &str, mime: &str) -> Option<Self> {
        let base = mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
        let by_mime = match base.as_str() {
            "audio/wav" | "audio/x-wav" | "audio/wave" | "audio/vnd.wave" => Some(AudioFormat::Wav),
            "audio/webm" | "video/webm" => Some(AudioFormat::Webm),
            "audio/ogg" | "audio/opus" => Some(AudioFormat::Ogg),
            "audio/mpeg" | "audio/mp3" => Some(AudioFormat::Mp3),
            "audio/flac" | "audio/x-flac" => Some(AudioFormat::Flac),
            "audio/mp4" | "audio/m4a" | "audio/x-m4a" => Some(AudioFormat::M4a),
            "audio/aac" => Some(AudioFormat::Aac),
            _ => None,
        };
        by_mime.or_else(|| {
            let ext = file_name.rsplit('.').next()?.to_ascii_lowercase();
            match ext.as_str() {
                "wav" => Some(AudioFormat::Wav),
                "webm" => Some(AudioFormat::Webm),
                "ogg" | "opus" => Some(AudioFormat::Ogg),
                "mp3" => Some(AudioFormat::Mp3),
                "flac" => Some(AudioFormat::Flac),
                "m4a" | "mp4" => Some(AudioFormat::M4a),
                "aac" => Some(AudioFormat::Aac),
                _ => None,
            }
        })
    }
}

/// Minimal valid WAV (silence, 0.5 s at 16 kHz mono) for connection tests —
/// long enough for APIs that reject sub-0.1 s clips.
fn generate_minimal_wav() -> Vec<u8> {
    let sample_rate: u32 = 16000;
    let num_samples: u32 = 8000;
    let bits_per_sample: u16 = 16;
    let num_channels: u16 = 1;
    let byte_rate = sample_rate * (bits_per_sample as u32 / 8) * num_channels as u32;
    let block_align = num_channels * (bits_per_sample / 8);
    let data_size = num_samples * (bits_per_sample as u32 / 8) * num_channels as u32;

    let mut wav = Vec::with_capacity(44 + data_size as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_size).to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&num_channels.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&block_align.to_le_bytes());
    wav.extend_from_slice(&bits_per_sample.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_size.to_le_bytes());
    wav.resize(44 + data_size as usize, 0);
    wav
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_json() {
        let out = parse_transcription_response(r#"{"text":" Hello world. "}"#).unwrap();
        assert_eq!(out.text, "Hello world.");
        assert!(out.segments.is_empty());
    }

    #[test]
    fn parses_openrouter_verbose_with_numeric_speakers() {
        // Verbatim shape from the OpenRouter STT guide.
        let body = r#"{
          "language": "en", "duration": 6.4,
          "text": "Hello there. Hi, how are you?",
          "segments": [
            { "id": 0, "start": 0.0, "end": 1.2, "text": "Hello there.", "speaker": 0 },
            { "id": 1, "start": 1.5, "end": 3.1, "text": "Hi, how are you?", "speaker": 1 }
          ],
          "words": [{ "word": "Hello", "start": 0.0, "end": 0.4, "speaker": 0 }],
          "usage": { "seconds": 6.4, "cost": 0.000178 }
        }"#;
        let out = parse_transcription_response(body).unwrap();
        assert_eq!(out.text, "Hello there. Hi, how are you?");
        assert_eq!(
            out.segments,
            vec![
                TranscribeSegment { start: 0.0, end: 1.2, text: "Hello there.".into(), speaker: Some("0".into()) },
                TranscribeSegment { start: 1.5, end: 3.1, text: "Hi, how are you?".into(), speaker: Some("1".into()) },
            ]
        );
    }

    #[test]
    fn parses_openai_verbose_without_speakers() {
        let body = r#"{"task":"transcribe","text":"a b","segments":[{"id":0,"seek":0,"start":0.0,"end":2.5,"text":" a b","tokens":[1],"avg_logprob":-0.2}]}"#;
        let out = parse_transcription_response(body).unwrap();
        assert_eq!(out.segments.len(), 1);
        assert_eq!(out.segments[0].text, "a b");
        assert_eq!(out.segments[0].speaker, None);
        assert_eq!(out.segments[0].end, 2.5);
    }

    #[test]
    fn string_speaker_and_missing_text_fallback() {
        let body = r#"{"segments":[{"start":1,"end":2,"text":"x","speaker":"A"},{"start":2,"end":3,"text":"y"}]}"#;
        let out = parse_transcription_response(body).unwrap();
        assert_eq!(out.text, "x y");
        assert_eq!(out.segments[0].speaker.as_deref(), Some("A"));
    }

    #[test]
    fn rejects_non_json_and_missing_text() {
        assert!(parse_transcription_response("hello").is_err());
        assert!(parse_transcription_response(r#"{"foo":1}"#).is_err());
    }

    #[test]
    fn sniffs_formats() {
        assert_eq!(AudioFormat::sniff(&generate_minimal_wav()), Some(AudioFormat::Wav));
        assert_eq!(AudioFormat::sniff(&[0x1A, 0x45, 0xDF, 0xA3, 0x9F]), Some(AudioFormat::Webm));
        assert_eq!(AudioFormat::sniff(b"OggS\0\x02"), Some(AudioFormat::Ogg));
        assert_eq!(AudioFormat::sniff(b"fLaC\0\0"), Some(AudioFormat::Flac));
        assert_eq!(AudioFormat::sniff(b"ID3\x04\0"), Some(AudioFormat::Mp3));
        assert_eq!(AudioFormat::sniff(&[0xFF, 0xFB, 0x90]), Some(AudioFormat::Mp3));
        assert_eq!(AudioFormat::sniff(&[0xFF, 0xF1, 0x50]), Some(AudioFormat::Aac));
        assert_eq!(AudioFormat::sniff(b"\0\0\0\x20ftypM4A "), Some(AudioFormat::M4a));
        assert_eq!(AudioFormat::sniff(b"garbage!"), None);
    }

    #[test]
    fn format_from_mime_and_extension() {
        assert_eq!(AudioFormat::from_hint("x", "audio/webm;codecs=opus"), Some(AudioFormat::Webm));
        assert_eq!(AudioFormat::from_hint("seg-0003.wav", "audio/wav"), Some(AudioFormat::Wav));
        assert_eq!(AudioFormat::from_hint("clip.MP3", "application/octet-stream"), Some(AudioFormat::Mp3));
        assert_eq!(AudioFormat::from_hint("noext", ""), None);
        assert_eq!(AudioFormat::Webm.mime(), "audio/webm");
    }

    #[test]
    fn verbose_selection() {
        assert!(wants_verbose(&WhisperProvider::Groq, "whisper-large-v3-turbo"));
        assert!(wants_verbose(&WhisperProvider::OpenAI, "whisper-1"));
        assert!(!wants_verbose(&WhisperProvider::OpenAI, "gpt-4o-mini-transcribe"));
        assert!(!wants_verbose(&WhisperProvider::Custom, "whisper-1"));
        assert!(wants_verbose(&WhisperProvider::OpenRouter, "microsoft/mai-transcribe-2"));
    }

    #[test]
    fn openrouter_body_shape() {
        let b = openrouter_body("microsoft/mai-transcribe-2", "sv", b"abc", AudioFormat::Wav, Some("vocab"), true);
        assert_eq!(b["input_audio"]["data"], "YWJj");
        assert_eq!(b["input_audio"]["format"], "wav");
        assert_eq!(b["language"], "sv");
        assert_eq!(b["response_format"], "verbose_json");
        assert_eq!(b["provider"]["options"]["azure"]["diarization"]["enabled"], true);
        assert_eq!(b["provider"]["options"]["groq"]["prompt"], "vocab");

        let plain = openrouter_body("openai/whisper-1", "auto", b"abc", AudioFormat::Webm, None, false);
        assert!(plain.get("language").is_none());
        assert!(plain.get("response_format").is_none());
        assert!(plain.get("provider").is_none());
        assert_eq!(plain["input_audio"]["format"], "webm");
    }

    fn openai_base() -> WhisperConfig {
        WhisperConfig {
            provider: WhisperProvider::OpenAI,
            endpoint: "https://my-proxy.example.com/v1/audio/transcriptions".into(),
            model: "gpt-4o-mini-transcribe".into(),
            api_key: Some("sk-openai".into()),
            ..WhisperConfig::default()
        }
    }

    #[test]
    fn override_to_hosted_provider_uses_preset_and_never_the_base_key() {
        let base = openai_base();
        let cfg = config_with_override(&base, Some(WhisperProvider::OpenRouter), None, None, None);
        assert_eq!(cfg.provider, WhisperProvider::OpenRouter);
        assert_eq!(cfg.model, "microsoft/mai-transcribe-2");
        assert_eq!(cfg.endpoint, "https://openrouter.ai/api/v1/audio/transcriptions");
        assert_eq!(cfg.api_key, None, "OpenAI key must not be sent to OpenRouter");

        let groq = config_with_override(
            &base,
            Some(WhisperProvider::Groq),
            Some("whisper-large-v3".into()),
            Some(" gsk_meeting ".into()),
            None,
        );
        assert_eq!(groq.endpoint, "https://api.groq.com/openai/v1/audio/transcriptions");
        assert_eq!(groq.api_key.as_deref(), Some("gsk_meeting"));
        assert_eq!(groq.model, "whisper-large-v3");
    }

    #[test]
    fn override_to_local_or_custom_never_keeps_a_hosted_dictation_endpoint() {
        let base = openai_base();
        let local = config_with_override(&base, Some(WhisperProvider::Local), None, None, None);
        assert_eq!(local.endpoint, crate::config::DEFAULT_LOCAL_WHISPER_ENDPOINT);
        assert_eq!(local.api_key, None);

        let custom = config_with_override(&base, Some(WhisperProvider::Custom), None, None, None);
        assert_eq!(custom.endpoint, "", "no endpoint → rejected, not posted to OpenAI");
        let custom = config_with_override(
            &base,
            Some(WhisperProvider::Custom),
            None,
            Some("k".into()),
            Some("http://box:9000/v1/audio/transcriptions".into()),
        );
        assert_eq!(custom.endpoint, "http://box:9000/v1/audio/transcriptions");
        assert_eq!(custom.api_key.as_deref(), Some("k"));
    }

    #[test]
    fn override_with_same_provider_keeps_base_key_and_endpoint_unless_set() {
        let base = openai_base();
        let same = config_with_override(&base, Some(WhisperProvider::OpenAI), Some("m".into()), None, Some("  ".into()));
        assert_eq!(same.endpoint, base.endpoint);
        assert_eq!(same.api_key, base.api_key);
        assert_eq!(same.model, "m");

        let own = config_with_override(
            &base,
            Some(WhisperProvider::OpenAI),
            None,
            Some("sk-meeting".into()),
            Some("https://api.openai.com/v1/audio/transcriptions".into()),
        );
        assert_eq!(own.api_key.as_deref(), Some("sk-meeting"));
        assert_eq!(own.endpoint, "https://api.openai.com/v1/audio/transcriptions");
        assert_eq!(own.model, base.model);

        // No provider override: key/endpoint fields are ignored, model applies.
        let none = config_with_override(&base, None, Some("x".into()), Some("k".into()), Some("e".into()));
        assert_eq!(none.endpoint, base.endpoint);
        assert_eq!(none.api_key, base.api_key);
        assert_eq!(none.model, "x");
    }

    #[tokio::test]
    async fn empty_endpoint_is_a_clear_error() {
        let cfg = WhisperConfig { endpoint: String::new(), ..WhisperConfig::default() };
        let err = transcribe_text(&cfg, generate_minimal_wav(), None).await.unwrap_err();
        assert!(err.contains("No transcription endpoint"), "{err}");
    }

    #[test]
    fn timeout_scales_with_audio_length() {
        // Exact duration for WAV: 0.5 s of 16 kHz mono 16-bit.
        let secs = estimate_audio_secs(&generate_minimal_wav(), AudioFormat::Wav);
        assert!((secs - 0.5).abs() < 1e-6, "{secs}");
        // Compressed: 2000 B/s guess → 1.2 MB ≈ 600 s.
        assert_eq!(estimate_audio_secs(&vec![0u8; 1_200_000], AudioFormat::Webm), 600.0);

        assert_eq!(request_timeout(true, 0.5), MIN_REQUEST_TIMEOUT);
        assert_eq!(request_timeout(false, 0.5), MIN_REQUEST_TIMEOUT);
        // 10 min of local audio: 60 + 4×600 s — far past the old fixed 120 s.
        assert_eq!(request_timeout(true, 600.0), Duration::from_secs(2460));
        assert_eq!(request_timeout(false, 600.0), Duration::from_secs(660));
    }

    #[tokio::test]
    async fn read_timeout_is_not_a_connection_error() {
        // A server that accepts the connection but never answers.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let hold = tokio::spawn(async move {
            let (_sock, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(10)).await;
        });
        let t = Duration::from_millis(300);
        let err = http_client()
            .post(format!("http://{}/v1/audio/transcriptions", addr))
            .body("x")
            .timeout(t)
            .send()
            .await
            .unwrap_err();
        let classified = classify_send_error(err, t);
        assert!(matches!(classified, AttemptError::Timeout(_)), "{classified:?}");
        let msg = classified.into_message();
        assert!(!msg.starts_with("Request failed"), "{msg}");
        hold.abort();

        // Nothing listening → a real connection error. (Generous total timeout:
        // Windows takes ~2 s to report a refused localhost connect; in real use
        // the total is always ≥ MIN_REQUEST_TIMEOUT, far above CONNECT_TIMEOUT.)
        let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = closed.local_addr().unwrap();
        drop(closed);
        let t = Duration::from_secs(30);
        let err = http_client()
            .post(format!("http://{}/", addr))
            .timeout(t)
            .send()
            .await
            .unwrap_err();
        let classified = classify_send_error(err, t);
        assert!(matches!(classified, AttemptError::Network(_)), "{classified:?}");
        assert!(classified.into_message().starts_with("Request failed"));
    }

    #[test]
    fn read_timeouts_reupload_at_most_once() {
        let t = AttemptError::Timeout("t".into());
        let net = AttemptError::Network("refused".into());
        // Remote API (2 retries): first timeout retried, second is final.
        assert!(should_retry(&t, 0, MAX_RETRIES, 1));
        assert!(!should_retry(&t, 1, MAX_RETRIES, 2));
        // Other retryable errors still use the full budget.
        assert!(should_retry(&net, 1, MAX_RETRIES, 1));
        assert!(!should_retry(&net, 2, MAX_RETRIES, 0));
        // Local (0 retries): never re-sent from here.
        assert!(!should_retry(&t, 0, 0, 1));
        assert!(!should_retry(&AttemptError::Parse("x".into()), 0, MAX_RETRIES, 0));
    }

    #[test]
    fn prompt_clamped_to_tail() {
        let long = "a".repeat(1000) + "END";
        let c = clamp_prompt(&long);
        assert_eq!(c.chars().count(), MAX_PROMPT_CHARS);
        assert!(c.ends_with("END"));
    }

    /// Live smoke test against a local OpenAI-compatible server:
    /// `cargo test whisper::tests::live_local -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn live_local() {
        let cfg = WhisperConfig {
            endpoint: "http://127.0.0.1:8000/v1/audio/transcriptions".into(),
            model: "Systran/faster-whisper-large-v3".into(),
            ..WhisperConfig::default()
        };
        let out = transcribe_detailed(&cfg, generate_minimal_wav(), "t.wav", "audio/wav", Some("OpenWhisperer"))
            .await;
        println!("{:?}", out);
        assert!(out.is_ok());
    }
}
