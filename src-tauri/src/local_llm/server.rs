//! `llama-server` process helpers: argument building, port picking, the
//! stderr log (rotating file + in-memory tail + VRAM accounting), health
//! polling, the Windows kill-on-close job, and the speed benchmark.

use parking_lot::Mutex;
use serde::Serialize;
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Log lines kept in memory for error messages.
const TAIL_LINES: usize = 60;
/// Rotate the server log when it grows past this at start.
const LOG_ROTATE_BYTES: u64 = 5 * 1024 * 1024;

/// Build the `llama-server` argument list.
pub fn server_args(model: &Path, port: u16, ctx: u32, full_gpu: bool) -> Vec<String> {
    let mut args: Vec<String> = [
        "-m",
        &model.to_string_lossy(),
        "--host",
        "127.0.0.1",
        "--port",
        &port.to_string(),
        "-c",
        &ctx.to_string(),
        "-fa",
        "on",
        "-ctk",
        "q8_0",
        "-ctv",
        "q8_0",
        "--jinja",
        "-np",
        "1",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if full_gpu {
        args.extend(["-ngl".to_string(), "99".to_string()]);
    } else {
        // Let llama.cpp split layers between GPU and CPU to fit free memory.
        args.extend(["--fit".to_string(), "on".to_string()]);
    }
    args
}

/// VRAM the model needs to sit fully on the GPU: weights plus KV cache and
/// compute buffers. Qwen3.x hybrid models keep a small KV cache (q8_0), so
/// ~0.5 GB at 32k context matches measured usage (9B Q5: 6.6 GB total).
pub fn vram_needed_mib(model_bytes: u64, ctx: u32) -> u64 {
    model_bytes / (1024 * 1024) + 256 + (ctx as u64 * 8 / 1024)
}

fn port_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// The preferred port if free, else the next free one within 20, else any.
pub fn pick_port(preferred: u16) -> u16 {
    for p in preferred..preferred.saturating_add(20) {
        if port_free(p) {
            return p;
        }
    }
    TcpListener::bind(("127.0.0.1", 0))
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
        .unwrap_or(preferred)
}

pub fn endpoint_for(port: u16) -> String {
    format!("http://127.0.0.1:{}/v1/chat/completions", port)
}

pub fn log_path() -> PathBuf {
    let name = if cfg!(debug_assertions) {
        "llama-server-dev.log"
    } else {
        "llama-server.log"
    };
    crate::commands::log_cmds::logs_dir().join(name)
}

/// Shared sink for the server's stdout/stderr.
pub struct ServerLog {
    file: Mutex<Option<std::fs::File>>,
    tail: Mutex<VecDeque<String>>,
    /// Sum of the GPU buffers llama.cpp reported while loading (MiB).
    vram_mib: Mutex<f64>,
}

impl ServerLog {
    pub fn open() -> Arc<Self> {
        let path = log_path();
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > LOG_ROTATE_BYTES {
            let _ = std::fs::rename(&path, path.with_extension("1.log"));
        }
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok();
        Arc::new(Self {
            file: Mutex::new(file),
            tail: Mutex::new(VecDeque::with_capacity(TAIL_LINES)),
            vram_mib: Mutex::new(0.0),
        })
    }

    pub fn line(&self, line: &str) {
        if let Some(f) = self.file.lock().as_mut() {
            let _ = writeln!(f, "{}", line);
        }
        if let Some(mib) = parse_gpu_buffer_mib(line) {
            *self.vram_mib.lock() += mib;
        }
        let mut tail = self.tail.lock();
        if tail.len() == TAIL_LINES {
            tail.pop_front();
        }
        tail.push_back(line.to_string());
    }

    pub fn marker(&self, text: &str) {
        self.line(&format!(
            "===== {} {} =====",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
            text
        ));
    }

    pub fn vram_mib(&self) -> Option<u64> {
        let v = *self.vram_mib.lock();
        (v > 0.0).then_some(v.round() as u64)
    }

    /// The last few meaningful lines (errors first), for status messages.
    pub fn summary(&self) -> String {
        let tail = self.tail.lock();
        let errors: Vec<&String> = tail
            .iter()
            .filter(|l| {
                let l = l.to_lowercase();
                l.contains("error") || l.contains("failed") || l.contains("out of memory")
            })
            .collect();
        let pick: Vec<&String> = if errors.is_empty() {
            tail.iter().rev().take(3).collect::<Vec<_>>().into_iter().rev().collect()
        } else {
            errors.into_iter().rev().take(3).collect::<Vec<_>>().into_iter().rev().collect()
        };
        pick.iter().map(|s| s.trim()).collect::<Vec<_>>().join(" | ")
    }
}

/// Parse lines like `load_tensors:   CUDA0 model buffer size =  6000.00 MiB`
/// (also KV / compute / RS buffers; Vulkan and Metal names). Host-side buffers
/// are ignored.
pub fn parse_gpu_buffer_mib(line: &str) -> Option<f64> {
    if !line.contains("buffer size") || line.contains("Host") || line.contains("CPU") {
        return None;
    }
    let lower = line.to_lowercase();
    let on_gpu = ["cuda", "vulkan", "metal", "mtl", "rocm"]
        .iter()
        .any(|k| lower.contains(k));
    let kind = [" model ", " kv ", " compute ", " rs "]
        .iter()
        .any(|k| lower.contains(k));
    if !on_gpu || !kind {
        return None;
    }
    let after = line.split('=').nth(1)?.trim();
    let num = after.split_whitespace().next()?;
    let value: f64 = num.parse().ok()?;
    if after.contains("GiB") {
        Some(value * 1024.0)
    } else if after.contains("MiB") {
        Some(value)
    } else {
        None
    }
}

/// Pump a child pipe into the log on a background thread.
pub fn pump<R: std::io::Read + Send + 'static>(reader: R, log: Arc<ServerLog>) {
    std::thread::spawn(move || {
        let mut r = BufReader::new(reader);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match r.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buf);
                    log.line(line.trim_end());
                }
            }
        }
    });
}

/// Health probe result.
pub enum Health {
    Ready,
    Loading,
    Down,
}

pub async fn health(client: &reqwest::Client, port: u16) -> Health {
    match client
        .get(format!("http://127.0.0.1:{}/health", port))
        .timeout(Duration::from_secs(3))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => Health::Ready,
        // 503 while the model is loading.
        Ok(_) => Health::Loading,
        Err(_) => Health::Down,
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct BenchmarkResult {
    /// Wall-clock time for the whole request (ms).
    pub latency_ms: u64,
    /// Generation speed reported by llama-server (tokens/s).
    pub tokens_per_second: Option<f64>,
    /// Prompt ingest speed (tokens/s).
    pub prompt_tokens_per_second: Option<f64>,
    pub completion_tokens: Option<u64>,
    pub prompt_tokens: Option<u64>,
    /// The response parsed as JSON matching the schema.
    pub valid_json: bool,
    pub output: String,
}

/// One short schema-constrained chat call (thinking off), mirroring how the
/// app's LLM features call a Local profile.
pub async fn benchmark(port: u16, model_name: &str) -> Result<BenchmarkResult, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;
    let schema = serde_json::json!({
        "type": "object",
        "properties": {
            "title": { "type": "string" },
            "summary": { "type": "string" },
            "tags": { "type": "array", "items": { "type": "string" } }
        },
        "required": ["title", "summary", "tags"],
        "additionalProperties": false
    });
    let body = serde_json::json!({
        "model": model_name,
        "messages": [
            { "role": "system", "content": "You name coding sessions. Reply with JSON only." },
            { "role": "user", "content": "Session transcript: the user asked to add a dark-mode toggle to the settings page, the agent added a Theme store, wired a toggle in SettingsView.svelte, persisted the choice to config.json and fixed a flash of unstyled content on startup. Give a short title, a two-sentence summary and 3 tags." }
        ],
        "temperature": 0.2,
        "max_tokens": 256,
        "response_format": {
            "type": "json_schema",
            "json_schema": { "name": "session_name", "strict": true, "schema": schema }
        },
        "chat_template_kwargs": { "enable_thinking": false }
    });
    let started = Instant::now();
    let resp = client
        .post(endpoint_for(port))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Benchmark request failed: {}", e))?;
    let status = resp.status();
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Benchmark response was not JSON: {}", e))?;
    let latency_ms = started.elapsed().as_millis() as u64;
    if !status.is_success() {
        return Err(format!("Benchmark failed: HTTP {}: {}", status, json));
    }
    let output = json["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let valid_json = serde_json::from_str::<serde_json::Value>(&output)
        .map(|v| v.get("title").is_some() && v.get("summary").is_some())
        .unwrap_or(false);
    let timings = &json["timings"];
    Ok(BenchmarkResult {
        latency_ms,
        tokens_per_second: timings["predicted_per_second"].as_f64(),
        prompt_tokens_per_second: timings["prompt_per_second"].as_f64(),
        completion_tokens: json["usage"]["completion_tokens"].as_u64(),
        prompt_tokens: json["usage"]["prompt_tokens"].as_u64(),
        valid_json,
        output,
    })
}

/// Windows: put the server in a job object that kills it when the app's last
/// handle closes, so a crashed/killed app never leaves the model in VRAM.
#[cfg(windows)]
pub fn attach_kill_on_close(child: &std::process::Child) {
    use std::os::windows::io::AsRawHandle;
    use std::sync::OnceLock;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    static JOB: OnceLock<isize> = OnceLock::new();
    let job = *JOB.get_or_init(|| unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return 0;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        job as isize
    });
    if job == 0 {
        return;
    }
    let ok = unsafe { AssignProcessToJobObject(job as _, child.as_raw_handle() as _) };
    if ok == 0 {
        log::warn!("[local-llm] could not attach llama-server to the kill-on-close job");
    }
}

#[cfg(not(windows))]
pub fn attach_kill_on_close(_child: &std::process::Child) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_gpu_buffer_lines() {
        assert_eq!(
            parse_gpu_buffer_mib("load_tensors:        CUDA0 model buffer size =  6000.50 MiB"),
            Some(6000.5)
        );
        assert_eq!(
            parse_gpu_buffer_mib("llama_kv_cache:      CUDA0 KV buffer size =   544.00 MiB"),
            Some(544.0)
        );
        assert_eq!(
            parse_gpu_buffer_mib("sched_reserve:      CUDA0 compute buffer size =   300.00 MiB"),
            Some(300.0)
        );
        assert_eq!(
            parse_gpu_buffer_mib("load_tensors:   CPU_Mapped model buffer size =   500.00 MiB"),
            None
        );
        assert_eq!(
            parse_gpu_buffer_mib("sched_reserve:  CUDA_Host compute buffer size =    72.01 MiB"),
            None
        );
    }

    #[test]
    fn args_switch_between_full_offload_and_fit() {
        let a = server_args(Path::new("m.gguf"), 1234, 32768, true);
        assert!(a.windows(2).any(|w| w == ["-ngl", "99"]));
        assert!(!a.iter().any(|s| s == "--fit"));
        let b = server_args(Path::new("m.gguf"), 1234, 32768, false);
        assert!(b.windows(2).any(|w| w == ["--fit", "on"]));
        assert!(!b.iter().any(|s| s == "-ngl"));
        assert!(b.windows(2).any(|w| w == ["-c", "32768"]));
    }

    #[test]
    fn vram_estimate_matches_measured_9b() {
        // Qwen3.8-9B Q5_K_M measured at ~6.6 GB with 32k q8_0 KV.
        let need = vram_needed_mib(6_642_543_936, 32768);
        assert!((6600..7200).contains(&need), "{}", need);
    }
}
