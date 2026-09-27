//! In-app local LLM: one-click llama.cpp runtime + model install and a
//! managed `llama-server` process, surfaced to the LLM layer as a regular
//! `Local` profile ([`LOCAL_LLM_PROFILE_ID`]).
//!
//! Events:
//! - `local-llm-progress` `{ stage, file, downloaded, total, message }` —
//!   stages `runtime` | `model` | `verifying` | `starting` | `test` | `done` |
//!   `cancelled` | `error`
//! - `local-llm-status` — [`LocalLlmStatus`] on every state change
//! - `local-llm-config` `{ llm, local_llm }` — after the backend changed the
//!   config, so the frontend settings store (which saves the whole config)
//!   can merge it instead of overwriting it

pub mod download;
pub mod hardware;
pub mod presets;
pub mod runtime;
pub mod server;

use parking_lot::Mutex;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

use crate::config::{AppConfig, LlmProfile, LlmProvider, LocalLlmConfig, LOCAL_LLM_PROFILE_ID};
use download::CANCELLED;
use server::{Health, ServerLog};

/// Give up restarting after this many crashes within [`RESTART_WINDOW`].
const MAX_RESTARTS: usize = 3;
const RESTART_WINDOW: Duration = Duration::from_secs(600);
/// Loading a 13 GB model from a slow disk can take a while.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(300);

pub fn root_dir() -> PathBuf {
    AppConfig::config_dir().join("local-llm")
}

fn runtimes_dir() -> PathBuf {
    root_dir().join("llama.cpp")
}

fn downloads_dir() -> PathBuf {
    root_dir().join("downloads")
}

pub fn default_models_dir() -> PathBuf {
    root_dir().join("models")
}

pub fn models_dir(cfg: &LocalLlmConfig) -> PathBuf {
    cfg.models_dir
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(default_models_dir)
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ServerState {
    Stopped,
    Starting,
    Running,
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct LocalLlmStatus {
    pub state: ServerState,
    pub port: Option<u16>,
    pub model: Option<String>,
    pub vram_used_mib: Option<u64>,
    pub message: Option<String>,
    /// Whether the last start put every layer on the GPU (`-ngl 99`) or let
    /// llama.cpp split the model (`--fit on`).
    pub full_gpu: Option<bool>,
    /// How long the last start took until `/health` was ready (ms).
    pub startup_ms: Option<u64>,
    /// A setup (download/install) is in progress.
    pub installing: bool,
}

impl LocalLlmStatus {
    fn stopped() -> Self {
        Self {
            state: ServerState::Stopped,
            port: None,
            model: None,
            vram_used_mib: None,
            message: None,
            full_gpu: None,
            startup_ms: None,
            installing: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct Progress<'a> {
    stage: &'a str,
    file: Option<&'a str>,
    downloaded: u64,
    total: Option<u64>,
    message: Option<&'a str>,
}

struct Running {
    child: Child,
    port: u16,
    log: Arc<ServerLog>,
}

pub struct LocalLlmManager {
    status: Mutex<LocalLlmStatus>,
    running: Mutex<Option<Running>>,
    /// Bumped on every start/stop so a stale crash monitor exits quietly.
    generation: AtomicU64,
    cancel: AtomicBool,
    installing: AtomicBool,
    /// Serializes start/stop so two starts never race for the port.
    lifecycle: tokio::sync::Mutex<()>,
    crashes: Mutex<Vec<Instant>>,
    host: Mutex<Option<Arc<dyn Host>>>,
}

/// The manager's window to the app. Kept behind a trait so the manager (and
/// its tests) never link Tauri's webview runtime — calling `AppHandle`
/// methods from test-reachable code makes the Windows test exe fail to load
/// (STATUS_ENTRYPOINT_NOT_FOUND).
pub trait Host: Send + Sync {
    fn emit(&self, event: &str, payload: serde_json::Value);
    /// Current `local_llm` config (read when restarting after a crash).
    fn config(&self) -> LocalLlmConfig;
    /// A (re)start finished on `port`: keep the profile endpoint in sync.
    fn on_started(&self, port: Option<u16>);
}

/// [`Host`] backed by the running Tauri app.
pub struct TauriHost(pub AppHandle);

impl Host for TauriHost {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        let _ = self.0.emit(event, payload);
    }
    fn config(&self) -> LocalLlmConfig {
        self.0.state::<Mutex<AppConfig>>().lock().local_llm.clone()
    }
    fn on_started(&self, port: Option<u16>) {
        sync_profile_port(&self.0, port);
    }
}

impl Default for LocalLlmManager {
    fn default() -> Self {
        Self::new()
    }
}

impl LocalLlmManager {
    pub fn new() -> Self {
        Self {
            status: Mutex::new(LocalLlmStatus::stopped()),
            running: Mutex::new(None),
            generation: AtomicU64::new(0),
            cancel: AtomicBool::new(false),
            installing: AtomicBool::new(false),
            lifecycle: tokio::sync::Mutex::new(()),
            crashes: Mutex::new(Vec::new()),
            host: Mutex::new(None),
        }
    }

    pub fn status(&self) -> LocalLlmStatus {
        let mut s = self.status.lock().clone();
        s.installing = self.installing.load(Ordering::SeqCst);
        if let Some(r) = self.running.lock().as_ref() {
            if s.vram_used_mib.is_none() {
                s.vram_used_mib = r.log.vram_mib();
            }
        }
        s
    }

    /// Install the Tauri bridge (events, config, profile sync). Without one
    /// (tests) the manager runs silently.
    pub fn set_host(&self, host: Arc<dyn Host>) {
        *self.host.lock() = Some(host);
    }

    fn host(&self) -> Option<Arc<dyn Host>> {
        self.host.lock().clone()
    }

    fn emit_status(&self) {
        if let Some(h) = self.host() {
            h.emit("local-llm-status", serde_json::to_value(self.status()).unwrap_or_default());
        }
    }

    fn progress(&self, p: Progress<'_>) {
        if let Some(h) = self.host() {
            h.emit("local-llm-progress", serde_json::to_value(p).unwrap_or_default());
        }
    }

    fn set_status(&self, f: impl FnOnce(&mut LocalLlmStatus)) {
        {
            let mut s = self.status.lock();
            f(&mut s);
        }
        self.emit_status();
    }

    /// Reset a stale cancel request before a user-initiated start.
    pub fn clear_cancel(&self) {
        self.cancel.store(false, Ordering::SeqCst);
    }

    pub fn request_cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    /// Kill the server synchronously (app shutdown path).
    pub fn shutdown(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Some(mut r) = self.running.lock().take() {
            log::info!("[local-llm] stopping llama-server (pid {}) on shutdown", r.child.id());
            let _ = r.child.kill();
            let _ = r.child.wait();
        }
    }

    pub async fn stop(&self) {
        let _guard = self.lifecycle.lock().await;
        self.stop_locked();
    }

    fn stop_locked(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Some(mut r) = self.running.lock().take() {
            log::info!("[local-llm] stopping llama-server (pid {})", r.child.id());
            r.log.marker("stopped by OpenWhisperer");
            let _ = r.child.kill();
            let _ = r.child.wait();
        }
        self.set_status(|s| *s = LocalLlmStatus::stopped());
    }

    /// Start (or return the already-running) server for the configured model.
    pub async fn start(
        self: &Arc<Self>,
        cfg: &LocalLlmConfig,
    ) -> Result<LocalLlmStatus, String> {
        let _guard = self.lifecycle.lock().await;
        let alive = self
            .running
            .lock()
            .as_mut()
            .is_some_and(|r| matches!(r.child.try_wait(), Ok(None)));
        if alive {
            return Ok(self.status());
        }
        let runtime_dir = cfg
            .runtime_dir
            .as_deref()
            .ok_or("The llama.cpp runtime is not installed")?;
        let binary = runtime::find_server_binary(Path::new(runtime_dir))
            .ok_or_else(|| format!("llama-server not found in {}", runtime_dir))?;
        let model_path = PathBuf::from(cfg.model_path.as_deref().ok_or("No model configured")?);
        let model_bytes = std::fs::metadata(&model_path)
            .map_err(|_| format!("Model file not found: {}", model_path.display()))?
            .len();
        let model_name = cfg
            .model_name
            .clone()
            .unwrap_or_else(|| model_stem(&model_path));

        let full_gpu = fits_on_gpu(cfg.runtime_variant.as_deref(), model_bytes, cfg.context_size);
        // If the full-offload attempt runs out of memory, retry letting llama.cpp fit.
        let attempts: Vec<bool> = if full_gpu { vec![true, false] } else { vec![false] };

        let mut last_err = String::new();
        for full in attempts {
            if self.cancelled() {
                break;
            }
            match self
                .spawn_and_wait(&binary, &model_path, &model_name, cfg, full)
                .await
            {
                Ok(status) => return Ok(status),
                Err(e) => {
                    log::warn!("[local-llm] start attempt (full_gpu={}) failed: {}", full, e);
                    last_err = e;
                }
            }
        }
        if self.cancelled() {
            last_err = CANCELLED.to_string();
        }
        let msg = last_err.clone();
        self.set_status(|s| {
            *s = LocalLlmStatus::stopped();
            s.state = ServerState::Error;
            s.model = Some(model_name.clone());
            s.message = Some(msg);
        });
        Err(last_err)
    }

    async fn spawn_and_wait(
        self: &Arc<Self>,
        binary: &Path,
        model_path: &Path,
        model_name: &str,
        cfg: &LocalLlmConfig,
        full_gpu: bool,
    ) -> Result<LocalLlmStatus, String> {
        let port = server::pick_port(cfg.port);
        let args = server::server_args(model_path, port, cfg.context_size, full_gpu);
        self.set_status(|s| {
            *s = LocalLlmStatus::stopped();
            s.state = ServerState::Starting;
            s.port = Some(port);
            s.model = Some(model_name.to_string());
            s.full_gpu = Some(full_gpu);
            s.message = Some(if full_gpu {
                "Loading the model onto the GPU…".into()
            } else {
                "Loading the model (split between GPU and CPU)…".into()
            });
        });

        let log = ServerLog::open();
        log.marker(&format!("starting {} {}", binary.display(), args.join(" ")));
        let is_cuda = cfg
            .runtime_variant
            .as_deref()
            .is_some_and(|v| v.starts_with("cuda"));
        let free_before = if is_cuda { hardware::nvidia_free_vram_mib() } else { None };
        let started = Instant::now();
        let mut child = spawn_server(binary, &args)?;
        let pid = child.id();
        server::attach_kill_on_close(&child);
        if let Some(out) = child.stdout.take() {
            server::pump(out, log.clone());
        }
        if let Some(err) = child.stderr.take() {
            server::pump(err, log.clone());
        }
        log::info!(
            "[local-llm] llama-server pid {} on port {} (full_gpu={})",
            child.id(),
            port,
            full_gpu
        );
        *self.running.lock() = Some(Running {
            child,
            port,
            log: log.clone(),
        });

        let client = reqwest::Client::new();
        loop {
            tokio::time::sleep(Duration::from_millis(400)).await;
            let exited = {
                let mut guard = self.running.lock();
                match guard.as_mut() {
                    Some(r) => r.child.try_wait().ok().flatten(),
                    None => return Err("llama-server was stopped".into()),
                }
            };
            if let Some(code) = exited {
                self.running.lock().take();
                return Err(format!(
                    "llama-server exited during startup ({}): {}",
                    code,
                    log.summary()
                ));
            }
            if self.cancelled() || started.elapsed() > STARTUP_TIMEOUT {
                let timed_out = !self.cancelled();
                if let Some(mut r) = self.running.lock().take() {
                    let _ = r.child.kill();
                    let _ = r.child.wait();
                }
                return Err(if timed_out {
                    format!("llama-server did not become ready within {} s", STARTUP_TIMEOUT.as_secs())
                } else {
                    CANCELLED.to_string()
                });
            }
            if let Health::Ready = server::health(&client, port).await {
                break;
            }
        }

        let startup_ms = started.elapsed().as_millis() as u64;
        // VRAM: per-process figure when the driver reports one (Linux), else
        // the drop in free VRAM across the load (Windows WDDM), else whatever
        // llama.cpp logged.
        let vram = if is_cuda {
            hardware::nvidia_process_vram_mib(pid).or_else(|| {
                free_before
                    .zip(hardware::nvidia_free_vram_mib())
                    .map(|(before, after)| before.saturating_sub(after))
                    .filter(|d| *d > 0)
            })
        } else {
            None
        }
        .or_else(|| log.vram_mib());
        log::info!(
            "[local-llm] llama-server ready in {} ms (vram {:?} MiB)",
            startup_ms,
            vram
        );
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.set_status(|s| {
            s.state = ServerState::Running;
            s.message = None;
            s.startup_ms = Some(startup_ms);
            s.vram_used_mib = vram;
        });
        self.spawn_monitor(generation);
        Ok(self.status())
    }

    /// Watch for crashes; restart (bounded) unless a stop/start superseded us.
    fn spawn_monitor(self: &Arc<Self>, generation: u64) {
        let Some(host) = self.host() else { return };
        let mgr = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(2)).await;
                if mgr.generation.load(Ordering::SeqCst) != generation {
                    return;
                }
                let exit = {
                    let mut guard = mgr.running.lock();
                    match guard.as_mut() {
                        Some(r) => r.child.try_wait().ok().flatten().map(|c| (c, r.log.summary())),
                        None => return,
                    }
                };
                let Some((code, summary)) = exit else { continue };
                mgr.running.lock().take();
                log::error!("[local-llm] llama-server crashed ({}): {}", code, summary);
                let allow_restart = {
                    let mut crashes = mgr.crashes.lock();
                    crashes.retain(|t| t.elapsed() < RESTART_WINDOW);
                    crashes.push(Instant::now());
                    crashes.len() <= MAX_RESTARTS
                };
                mgr.set_status(|s| {
                    s.state = ServerState::Error;
                    s.message = Some(format!(
                        "llama-server exited unexpectedly ({}){}: {}",
                        code,
                        if allow_restart { ", restarting" } else { "" },
                        summary
                    ));
                });
                if allow_restart {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    if mgr.generation.load(Ordering::SeqCst) != generation {
                        return;
                    }
                    let cfg = host.config();
                    if let Ok(status) = mgr.start(&cfg).await {
                        host.on_started(status.port);
                    }
                }
                return;
            }
        });
    }

    pub fn port(&self) -> Option<u16> {
        self.running.lock().as_ref().map(|r| r.port)
    }
}

/// Spawn `llama-server` windowless with piped output.
fn spawn_server(binary: &Path, args: &[String]) -> Result<Child, String> {
    let mut cmd = Command::new(binary);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = binary.parent() {
        cmd.current_dir(dir);
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            // Tarball builds ship their .so files next to the binary.
            let mut ld = dir.to_string_lossy().to_string();
            if let Ok(existing) = std::env::var("LD_LIBRARY_PATH") {
                ld = format!("{}:{}", ld, existing);
            }
            cmd.env("LD_LIBRARY_PATH", ld);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::proc::CREATE_NO_WINDOW);
    }
    cmd.spawn()
        .map_err(|e| format!("Failed to start llama-server: {}", e))
}

fn model_stem(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "local-model".into())
}

/// Decide `-ngl 99` vs `--fit on` from the current free GPU memory.
fn fits_on_gpu(variant: Option<&str>, model_bytes: u64, ctx: u32) -> bool {
    let need = server::vram_needed_mib(model_bytes, ctx);
    let variant = variant.unwrap_or("");
    if variant.starts_with("cuda") {
        return hardware::nvidia_free_vram_mib().is_some_and(|free| free >= need);
    }
    if variant == "cpu" {
        return false;
    }
    // Metal / Vulkan: no cheap free-memory probe; compare against the total.
    let probe = hardware::probe(&default_models_dir());
    probe
        .gpu
        .and_then(|g| g.vram_free_mib.or(g.vram_total_mib))
        .is_some_and(|avail| avail >= need)
}


/// Tell the frontend the backend changed `llm` / `local_llm`.
pub fn emit_config(app: &AppHandle) {
    let cfg = app.state::<Mutex<AppConfig>>();
    let (llm, local_llm) = {
        let c = cfg.lock();
        (c.llm.clone(), c.local_llm.clone())
    };
    let _ = app.emit(
        "local-llm-config",
        serde_json::json!({ "llm": llm, "local_llm": local_llm }),
    );
}

/// Mutate the managed config under the lock, persist, and notify the frontend.
pub fn update_config(app: &AppHandle, f: impl FnOnce(&mut AppConfig)) -> Result<(), String> {
    let snapshot = {
        let state = app.state::<Mutex<AppConfig>>();
        let mut c = state.lock();
        f(&mut c);
        c.clone()
    };
    let res = snapshot.save();
    emit_config(app);
    res
}

/// Create/update the local profile and (re)apply the chain placement chosen
/// in `local_llm.use_for_quality/fast`. `create` = setup/routing change (also
/// enables LLM features); otherwise only an existing profile is updated.
pub fn apply_profile(cfg: &mut AppConfig, port: u16, create: bool) {
    let endpoint = server::endpoint_for(port);
    let model = cfg
        .local_llm
        .model_name
        .clone()
        .unwrap_or_else(|| "local-model".into());
    let llm = &mut cfg.llm;
    match llm.profiles.iter_mut().find(|p| p.id == LOCAL_LLM_PROFILE_ID) {
        Some(p) => {
            p.endpoint = Some(endpoint);
            p.model = model;
            p.provider = LlmProvider::Local;
        }
        None if create => llm.profiles.push(LlmProfile {
            id: LOCAL_LLM_PROFILE_ID.to_string(),
            label: "Local (llama.cpp)".to_string(),
            provider: LlmProvider::Local,
            model,
            endpoint: Some(endpoint),
            auto_model: false,
            model_priority: Default::default(),
            disable_thinking: true,
        }),
        None => return,
    }
    if !create {
        return;
    }
    let place = |chain: &mut Vec<String>, first: bool| {
        chain.retain(|id| id != LOCAL_LLM_PROFILE_ID);
        if first {
            chain.insert(0, LOCAL_LLM_PROFILE_ID.to_string());
        }
    };
    place(&mut llm.quality_chain, cfg.local_llm.use_for_quality);
    place(&mut llm.fast_chain, cfg.local_llm.use_for_fast);
    llm.enabled = true;
}

/// Drop the local profile from the profiles list and both chains.
pub fn remove_profile(cfg: &mut AppConfig) {
    let llm = &mut cfg.llm;
    llm.fast_chain.retain(|id| id != LOCAL_LLM_PROFILE_ID);
    llm.quality_chain.retain(|id| id != LOCAL_LLM_PROFILE_ID);
    // Never leave zero profiles (the UI and router assume at least one).
    if llm.profiles.len() > 1 {
        llm.profiles.retain(|p| p.id != LOCAL_LLM_PROFILE_ID);
    }
}

/// Keep an existing profile's endpoint on the port the server actually got.
pub fn sync_profile_port(app: &AppHandle, port: Option<u16>) {
    let Some(port) = port else { return };
    let state = app.state::<Mutex<AppConfig>>();
    let needs = {
        let c = state.lock();
        c.llm
            .profiles
            .iter()
            .find(|p| p.id == LOCAL_LLM_PROFILE_ID)
            .is_some_and(|p| p.endpoint.as_deref() != Some(server::endpoint_for(port).as_str()))
    };
    if needs {
        log::info!("[local-llm] server moved to port {}; updating the profile endpoint", port);
        let _ = update_config(app, |c| apply_profile(c, port, false));
    }
}

/// What to install as the model.
#[derive(Debug, Clone)]
pub enum ModelSource {
    Preset(String),
    Existing(PathBuf),
}

#[derive(Debug, Clone, Serialize)]
pub struct InstallOutcome {
    pub status: LocalLlmStatus,
    pub benchmark: Option<server::BenchmarkResult>,
    pub runtime_version: String,
    pub runtime_variant: String,
}

/// Download + extract the llama.cpp runtime if it isn't installed yet.
/// Returns `(dir, tag, variant)`.
pub async fn ensure_runtime(
    mgr: &LocalLlmManager,
    cfg: &LocalLlmConfig,
    probe: &hardware::HardwareProbe,
) -> Result<(PathBuf, String, String), String> {
    if let (Some(dir), Some(tag), Some(variant)) = (
        cfg.runtime_dir.as_deref(),
        cfg.runtime_version.as_deref(),
        cfg.runtime_variant.as_deref(),
    ) {
        if runtime::find_server_binary(Path::new(dir)).is_some() {
            mgr.progress(Progress {
                    stage: "runtime",
                    file: None,
                    downloaded: 1,
                    total: Some(1),
                    message: Some("llama.cpp is already installed"),
                },
            );
            return Ok((PathBuf::from(dir), tag.to_string(), variant.to_string()));
        }
    }

    mgr.progress(Progress {
            stage: "runtime",
            file: None,
            downloaded: 0,
            total: None,
            message: Some("Finding the latest llama.cpp build…"),
        },
    );
    let client = download::http_client();
    let releases = runtime::fetch_releases(&client).await?;
    let prefs = runtime::backend_preference(probe);
    let sel = runtime::select_runtime(&releases, &probe.os, &probe.arch, &prefs).ok_or_else(|| {
        format!(
            "No prebuilt llama.cpp server for {} / {} in the latest releases",
            probe.os, probe.arch
        )
    })?;
    log::info!(
        "[local-llm] runtime {} {} ({} asset(s))",
        sel.tag,
        sel.variant,
        sel.assets.len()
    );

    let dl_dir = downloads_dir();
    let final_dir = runtimes_dir().join(format!("{}-{}", sel.tag, sel.variant));
    if runtime::find_server_binary(&final_dir).is_some() {
        // Same build already extracted (config was reset or set up elsewhere).
        return Ok((final_dir, sel.tag, sel.variant));
    }
    let staging = runtimes_dir().join(format!("{}-{}.partial", sel.tag, sel.variant));
    let _ = std::fs::remove_dir_all(&staging);
    for asset in &sel.assets {
        let dest = dl_dir.join(&asset.name);
        let name = asset.name.clone();
        let progress = |done: u64, total: Option<u64>| {
            mgr.progress(Progress {
                    stage: "runtime",
                    file: Some(&name),
                    downloaded: done,
                    total,
                    message: None,
                },
            )
        };
        let verify = || {
            mgr.progress(Progress {
                    stage: "verifying",
                    file: Some(&name),
                    downloaded: 0,
                    total: None,
                    message: Some("Checking the download…"),
                },
            )
        };
        download::download(
            &client,
            &asset.browser_download_url,
            &dest,
            Some(asset.size),
            asset.sha256(),
            &mgr.cancel,
            &progress,
            &verify,
        )
        .await?;
        mgr.progress(Progress {
                stage: "runtime",
                file: Some(&name),
                downloaded: asset.size,
                total: Some(asset.size),
                message: Some("Extracting…"),
            },
        );
        let (archive, target) = (dest.clone(), staging.clone());
        tokio::task::spawn_blocking(move || runtime::extract(&archive, &target))
            .await
            .map_err(|e| format!("Extract task failed: {}", e))??;
    }
    if runtime::find_server_binary(&staging).is_none() {
        return Err("The downloaded llama.cpp build has no llama-server binary".into());
    }
    let _ = std::fs::remove_dir_all(&final_dir);
    std::fs::rename(&staging, &final_dir)
        .map_err(|e| format!("Failed to install the runtime: {}", e))?;
    // Remove older runtimes and the archives.
    if let Ok(entries) = std::fs::read_dir(runtimes_dir()) {
        for e in entries.flatten() {
            if e.path() != final_dir {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
    for asset in &sel.assets {
        let _ = std::fs::remove_file(dl_dir.join(&asset.name));
    }
    Ok((final_dir, sel.tag, sel.variant))
}

/// Resolve the model: download a preset (resumable) or validate an existing file.
/// Returns `(path, model_name, preset_id)`.
pub async fn ensure_model(
    mgr: &LocalLlmManager,
    cfg: &LocalLlmConfig,
    source: &ModelSource,
) -> Result<(PathBuf, String, Option<String>), String> {
    match source {
        ModelSource::Existing(path) => {
            validate_gguf(path)?;
            mgr.progress(Progress {
                    stage: "model",
                    file: path.file_name().and_then(|n| n.to_str()),
                    downloaded: 1,
                    total: Some(1),
                    message: Some("Using your existing model file"),
                },
            );
            Ok((path.clone(), model_stem(path), None))
        }
        ModelSource::Preset(id) => {
            let preset = presets::find(id).ok_or_else(|| format!("Unknown preset '{}'", id))?;
            let dir = models_dir(cfg);
            let dest = dir.join(preset.file_name);
            let have = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
            if have != preset.size_bytes {
                let part = std::fs::metadata(dir.join(format!("{}.part", preset.file_name)))
                    .map(|m| m.len())
                    .unwrap_or(0);
                let remaining_mib = preset.size_bytes.saturating_sub(part) / (1024 * 1024);
                if let Some(free) = hardware::disk_free_mib(&dir) {
                    if free < remaining_mib + 512 {
                        return Err(format!(
                            "Not enough disk space in {}: {:.1} GB needed, {:.1} GB free. Pick another models folder.",
                            dir.display(),
                            remaining_mib as f64 / 1024.0,
                            free as f64 / 1024.0
                        ));
                    }
                }
            }
            let client = download::http_client();
            let progress = |done: u64, total: Option<u64>| {
                mgr.progress(Progress {
                        stage: "model",
                        file: Some(preset.file_name),
                        downloaded: done,
                        total,
                        message: None,
                    },
                )
            };
            let verify = || {
                mgr.progress(Progress {
                        stage: "verifying",
                        file: Some(preset.file_name),
                        downloaded: 0,
                        total: None,
                        message: Some("Verifying the model checksum…"),
                    },
                )
            };
            download::download(
                &client,
                preset.url,
                &dest,
                Some(preset.size_bytes),
                Some(preset.sha256),
                &mgr.cancel,
                &progress,
                &verify,
            )
            .await?;
            Ok((dest, preset.model_name.to_string(), Some(preset.id.to_string())))
        }
    }
}

fn validate_gguf(path: &Path) -> Result<(), String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path)
        .map_err(|e| format!("Cannot open {}: {}", path.display(), e))?;
    let mut magic = [0u8; 4];
    f.read_exact(&mut magic)
        .map_err(|_| format!("{} is not a GGUF model", path.display()))?;
    if &magic != b"GGUF" {
        return Err(format!("{} is not a GGUF model file", path.display()));
    }
    Ok(())
}

impl LocalLlmManager {
    /// The whole one-click flow: runtime → model → start → test → profile.
    pub async fn install(
        self: &Arc<Self>,
        app: &AppHandle,
        source: ModelSource,
        use_quality: bool,
        use_fast: bool,
    ) -> Result<InstallOutcome, String> {
        if self
            .installing
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("A local model setup is already running".into());
        }
        self.cancel.store(false, Ordering::SeqCst);
        self.emit_status();
        let result = self.install_inner(app, source, use_quality, use_fast).await;
        self.installing.store(false, Ordering::SeqCst);
        match &result {
            Ok(_) => self.progress(Progress {
                    stage: "done",
                    file: None,
                    downloaded: 1,
                    total: Some(1),
                    message: None,
                },
            ),
            Err(e) => self.progress(Progress {
                    stage: if e == CANCELLED { "cancelled" } else { "error" },
                    file: None,
                    downloaded: 0,
                    total: None,
                    message: Some(e),
                },
            ),
        }
        self.emit_status();
        result
    }

    async fn install_inner(
        self: &Arc<Self>,
        app: &AppHandle,
        source: ModelSource,
        use_quality: bool,
        use_fast: bool,
    ) -> Result<InstallOutcome, String> {
        let cfg = app.state::<Mutex<AppConfig>>().lock().local_llm.clone();
        let probe = hardware::probe(&models_dir(&cfg));

        let (runtime_dir, tag, variant) = ensure_runtime(self, &cfg, &probe).await?;
        update_config(app, |c| {
            c.local_llm.runtime_dir = Some(runtime_dir.to_string_lossy().to_string());
            c.local_llm.runtime_version = Some(tag.clone());
            c.local_llm.runtime_variant = Some(variant.clone());
        })?;
        if self.cancelled() {
            return Err(CANCELLED.into());
        }

        let (model_path, model_name, preset_id) =
            ensure_model(self, &cfg, &source).await?;
        update_config(app, |c| {
            c.local_llm.model_path = Some(model_path.to_string_lossy().to_string());
            c.local_llm.model_name = Some(model_name.clone());
            c.local_llm.preset_id = preset_id.clone();
            c.local_llm.use_for_quality = use_quality;
            c.local_llm.use_for_fast = use_fast;
        })?;
        if self.cancelled() {
            return Err(CANCELLED.into());
        }

        self.progress(Progress {
                stage: "starting",
                file: None,
                downloaded: 0,
                total: None,
                message: Some("Starting llama-server…"),
            },
        );
        // A changed model needs a fresh server.
        self.stop().await;
        let cfg = app.state::<Mutex<AppConfig>>().lock().local_llm.clone();
        let status = self.start(&cfg).await?;
        let port = status.port.unwrap_or(cfg.port);

        self.progress(Progress {
                stage: "test",
                file: None,
                downloaded: 0,
                total: None,
                message: Some("Running a quick test…"),
            },
        );
        let bench = server::benchmark(port, &model_name).await?;
        if !bench.valid_json {
            return Err(format!(
                "The model answered, but not with valid JSON: {}",
                bench.output.chars().take(200).collect::<String>()
            ));
        }

        update_config(app, |c| apply_profile(c, port, true))?;
        Ok(InstallOutcome {
            status: self.status(),
            benchmark: Some(bench),
            runtime_version: tag,
            runtime_variant: variant,
        })
    }

    /// Stop the server and delete the runtime (and, optionally, models we
    /// downloaded — never a user-supplied file).
    pub async fn uninstall(&self, app: &AppHandle, remove_models: bool) -> Result<(), String> {
        if self.installing.load(Ordering::SeqCst) {
            return Err("Cancel the running setup first".into());
        }
        self.stop().await;
        let cfg = app.state::<Mutex<AppConfig>>().lock().local_llm.clone();
        let _ = std::fs::remove_dir_all(runtimes_dir());
        let _ = std::fs::remove_dir_all(downloads_dir());
        if remove_models {
            let dir = models_dir(&cfg);
            for p in presets::PRESETS {
                let _ = std::fs::remove_file(dir.join(p.file_name));
                let _ = std::fs::remove_file(dir.join(format!("{}.part", p.file_name)));
            }
            if dir == default_models_dir() {
                let _ = std::fs::remove_dir(&dir);
            }
        }
        update_config(app, |c| {
            let keep_dir = c.local_llm.models_dir.clone();
            c.local_llm = LocalLlmConfig {
                models_dir: keep_dir,
                ..Default::default()
            };
            remove_profile(c);
        })
    }
}

/// On app launch: start the server if it was set up and auto-start is on.
pub fn spawn_auto_start(app: AppHandle) {
    let cfg = app.state::<Mutex<AppConfig>>().lock().local_llm.clone();
    if !cfg.auto_start || !cfg.is_set_up() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let mgr = app.state::<Arc<LocalLlmManager>>().inner().clone();
        match mgr.start(&cfg).await {
            Ok(status) => {
                log::info!("[local-llm] auto-started on port {:?}", status.port);
                sync_profile_port(&app, status.port);
            }
            Err(e) => log::error!("[local-llm] auto-start failed: {}", e),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_profile_creates_and_orders_chains() {
        let mut cfg = AppConfig::default();
        cfg.local_llm.model_name = Some("Qwen".into());
        cfg.local_llm.use_for_quality = true;
        cfg.local_llm.use_for_fast = false;
        apply_profile(&mut cfg, 1234, true);
        assert!(cfg.llm.enabled);
        let p = cfg.llm.profiles.iter().find(|p| p.id == LOCAL_LLM_PROFILE_ID).unwrap();
        assert_eq!(p.endpoint.as_deref(), Some("http://127.0.0.1:1234/v1/chat/completions"));
        assert!(p.disable_thinking);
        assert_eq!(cfg.llm.quality_chain, vec![LOCAL_LLM_PROFILE_ID, "default"]);
        assert_eq!(cfg.llm.fast_chain, vec!["default"]);

        // Toggling fast on moves it to the front there too; no duplicates.
        cfg.local_llm.use_for_fast = true;
        apply_profile(&mut cfg, 1235, true);
        assert_eq!(cfg.llm.fast_chain, vec![LOCAL_LLM_PROFILE_ID, "default"]);
        assert_eq!(cfg.llm.quality_chain, vec![LOCAL_LLM_PROFILE_ID, "default"]);
        assert_eq!(
            cfg.llm.profiles.iter().filter(|p| p.id == LOCAL_LLM_PROFILE_ID).count(),
            1
        );

        // Port sync only touches the endpoint.
        cfg.local_llm.use_for_quality = false;
        apply_profile(&mut cfg, 1300, false);
        assert_eq!(cfg.llm.quality_chain, vec![LOCAL_LLM_PROFILE_ID, "default"]);
        let p = cfg.llm.profiles.iter().find(|p| p.id == LOCAL_LLM_PROFILE_ID).unwrap();
        assert_eq!(p.endpoint.as_deref(), Some("http://127.0.0.1:1300/v1/chat/completions"));

        remove_profile(&mut cfg);
        assert!(cfg.llm.profiles.iter().all(|p| p.id != LOCAL_LLM_PROFILE_ID));
        assert_eq!(cfg.llm.quality_chain, vec!["default"]);
    }

    #[test]
    fn port_sync_never_creates_the_profile() {
        let mut cfg = AppConfig::default();
        apply_profile(&mut cfg, 1234, false);
        assert!(cfg.llm.profiles.iter().all(|p| p.id != LOCAL_LLM_PROFILE_ID));
        assert!(!cfg.llm.enabled);
    }

    /// End-to-end on real hardware: install the runtime into the config dir,
    /// start llama-server on an existing model, benchmark, stop.
    /// `LOCAL_LLM_TEST_MODEL=G:\llm\models\x.gguf cargo test --lib local_llm_e2e -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn local_llm_e2e() {
        let model = std::env::var("LOCAL_LLM_TEST_MODEL").expect("set LOCAL_LLM_TEST_MODEL");
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let mgr = Arc::new(LocalLlmManager::new());
            let mut cfg = LocalLlmConfig::default();
            let probe = hardware::probe(&default_models_dir());
            println!("probe: {}", serde_json::to_string_pretty(&probe).unwrap());
            println!("recommend: {:?}", presets::recommend(&probe, true));
            let t = Instant::now();
            let (dir, tag, variant) = ensure_runtime(&mgr, &cfg, &probe).await.unwrap();
            println!("runtime {} {} at {} ({:?})", tag, variant, dir.display(), t.elapsed());
            cfg.runtime_dir = Some(dir.to_string_lossy().to_string());
            cfg.runtime_version = Some(tag);
            cfg.runtime_variant = Some(variant);
            let (path, name, _) = ensure_model(&mgr, &cfg, &ModelSource::Existing(model.into()))
                .await
                .unwrap();
            cfg.model_path = Some(path.to_string_lossy().to_string());
            cfg.model_name = Some(name.clone());
            let status = mgr.start(&cfg).await.unwrap();
            println!("status: {}", serde_json::to_string_pretty(&status).unwrap());
            let port = status.port.unwrap();
            for i in 0..2 {
                let b = server::benchmark(port, &name).await.unwrap();
                println!("benchmark #{}: {}", i + 1, serde_json::to_string_pretty(&b).unwrap());
                assert!(b.valid_json);
            }
            println!("final status: {}", serde_json::to_string(&mgr.status()).unwrap());
            mgr.stop().await;
            assert_eq!(mgr.status().state, ServerState::Stopped);
        });
    }
}
