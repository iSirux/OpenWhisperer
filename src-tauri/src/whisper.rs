use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptionResponse {
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionTestResult {
    pub health_ok: bool,
    pub health_error: Option<String>,
    pub transcription_ok: bool,
    pub transcription_error: Option<String>,
}

pub struct WhisperClient {
    client: reqwest::Client,
    endpoint: String,
    model: String,
    language: String,
    api_key: Option<String>,
}

impl WhisperClient {
    pub fn new(endpoint: String, model: String, language: String, api_key: Option<String>) -> Self {
        Self {
            client: reqwest::Client::new(),
            endpoint,
            model,
            language,
            api_key,
        }
    }

    pub async fn transcribe(&self, audio_data: Vec<u8>) -> Result<String, String> {
        let part = Part::bytes(audio_data)
            .file_name("audio.wav")
            .mime_str("audio/wav")
            .map_err(|e| format!("Failed to create part: {}", e))?;

        let form = Form::new()
            .part("file", part)
            .text("model", self.model.clone())
            .text("language", self.language.clone());

        let mut request = self.client.post(&self.endpoint).multipart(form);

        // Add Authorization header if API key is provided
        if let Some(ref api_key) = self.api_key {
            if !api_key.is_empty() {
                request = request.header("Authorization", format!("Bearer {}", api_key));
            }
        }

        let response = request
            .send()
            .await
            .map_err(|e| format!("Request failed: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(format!("Whisper API error ({}): {}", status, error_text));
        }

        let result: TranscriptionResponse = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        Ok(result.text)
    }

    pub async fn test_connection(&self) -> Result<ConnectionTestResult, String> {
        let mut result = ConnectionTestResult {
            health_ok: false,
            health_error: None,
            transcription_ok: false,
            transcription_error: None,
        };

        // Step 1: Check health endpoint
        let health_url = self.endpoint.replace("/v1/audio/transcriptions", "/health");
        match self.client.get(&health_url).send().await {
            Ok(r) => {
                if r.status().is_success() {
                    result.health_ok = true;
                } else {
                    result.health_error =
                        Some(format!("Health check returned status {}", r.status()));
                }
            }
            Err(e) => {
                result.health_error = Some(format!("Health check failed: {}", e));
            }
        }

        // Step 2: Send a minimal WAV file to trigger actual transcription (wakes up container)
        let minimal_wav = Self::generate_minimal_wav();

        let part = match Part::bytes(minimal_wav)
            .file_name("test.wav")
            .mime_str("audio/wav")
        {
            Ok(p) => p,
            Err(e) => {
                result.transcription_error = Some(format!("Failed to create audio part: {}", e));
                return Ok(result);
            }
        };

        let form = Form::new()
            .part("file", part)
            .text("model", self.model.clone())
            .text("language", self.language.clone());

        let mut request = self.client.post(&self.endpoint).multipart(form);

        // Add Authorization header if API key is provided
        if let Some(ref api_key) = self.api_key {
            if !api_key.is_empty() {
                request = request.header("Authorization", format!("Bearer {}", api_key));
            }
        }

        match request.send().await {
            Ok(r) => {
                if r.status().is_success() {
                    result.transcription_ok = true;
                } else {
                    let status = r.status();
                    let error_text = r.text().await.unwrap_or_default();
                    result.transcription_error =
                        Some(format!("Transcription error ({}): {}", status, error_text));
                }
            }
            Err(e) => {
                result.transcription_error = Some(format!("Transcription request failed: {}", e));
            }
        }

        Ok(result)
    }

    /// Generate a minimal valid WAV file (silence, ~0.1 seconds at 16kHz mono)
    fn generate_minimal_wav() -> Vec<u8> {
        let sample_rate: u32 = 16000;
        let num_samples: u32 = 1600; // 0.1 seconds
        let bits_per_sample: u16 = 16;
        let num_channels: u16 = 1;
        let byte_rate = sample_rate * (bits_per_sample as u32 / 8) * num_channels as u32;
        let block_align = num_channels * (bits_per_sample / 8);
        let data_size = num_samples * (bits_per_sample as u32 / 8) * num_channels as u32;

        let mut wav = Vec::with_capacity(44 + data_size as usize);

        // RIFF header
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_size).to_le_bytes());
        wav.extend_from_slice(b"WAVE");

        // fmt chunk
        wav.extend_from_slice(b"fmt ");
        wav.extend_from_slice(&16u32.to_le_bytes()); // chunk size
        wav.extend_from_slice(&1u16.to_le_bytes()); // PCM format
        wav.extend_from_slice(&num_channels.to_le_bytes());
        wav.extend_from_slice(&sample_rate.to_le_bytes());
        wav.extend_from_slice(&byte_rate.to_le_bytes());
        wav.extend_from_slice(&block_align.to_le_bytes());
        wav.extend_from_slice(&bits_per_sample.to_le_bytes());

        // data chunk
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_size.to_le_bytes());

        // Silent samples (zeros)
        wav.resize(44 + data_size as usize, 0);

        wav
    }
}
