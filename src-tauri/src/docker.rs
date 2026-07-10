//! Auto-start for the local transcription Docker containers.
//!
//! When a transcription attempt can't reach its local server, we try a plain
//! `docker start <container>` (start only — never build or configure; that
//! remains the one-click setup in `docker_cmds`). Failed attempts are
//! rate-limited per container so a missing container or stopped Docker daemon
//! isn't hammered on every recording.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::proc::run_command_async;

/// How long to back off after a failed `docker start` before trying again.
const FAILURE_COOLDOWN: Duration = Duration::from_secs(60);

fn failed_attempts() -> &'static Mutex<HashMap<String, Instant>> {
    static FAILED: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    FAILED.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Whether an endpoint points at this machine — the only place a local Docker
/// container could be serving it.
pub fn is_local_endpoint(endpoint: &str) -> bool {
    let host = endpoint
        .split("//")
        .nth(1)
        .unwrap_or(endpoint)
        .split('/')
        .next()
        .unwrap_or("");
    let host = host.trim_start_matches('[');
    host.starts_with("localhost")
        || host.starts_with("127.0.0.1")
        || host.starts_with("0.0.0.0")
        || host.starts_with("::1")
}

/// Try `docker start <container_name>`. Ok(()) means the container is running
/// (freshly started or already up). Failures are remembered and retried at
/// most once per [`FAILURE_COOLDOWN`].
pub async fn try_start_container(container_name: &str) -> Result<(), String> {
    if container_name.is_empty() {
        return Err("No container name configured".to_string());
    }

    if let Some(last) = failed_attempts().lock().unwrap().get(container_name) {
        if last.elapsed() < FAILURE_COOLDOWN {
            return Err(format!(
                "Skipping docker start for '{}' (failed recently)",
                container_name
            ));
        }
    }

    log::info!(
        "Transcription server unreachable, trying `docker start {}`",
        container_name
    );

    let result = run_command_async("docker", &["start".to_string(), container_name.to_string()], None, &[]).await;

    let err = match result {
        Ok(out) if out.success => {
            failed_attempts().lock().unwrap().remove(container_name);
            log::info!("Started docker container '{}'", container_name);
            return Ok(());
        }
        Ok(out) => {
            let stderr = out.stderr.trim();
            if stderr.is_empty() {
                format!("docker start {} failed (exit {:?})", container_name, out.code)
            } else {
                format!("docker start {} failed: {}", container_name, stderr)
            }
        }
        Err(e) => e,
    };

    failed_attempts()
        .lock()
        .unwrap()
        .insert(container_name.to_string(), Instant::now());
    log::warn!("{}", err);
    Err(err)
}

#[cfg(test)]
mod tests {
    use super::is_local_endpoint;

    #[test]
    fn local_endpoints() {
        assert!(is_local_endpoint("http://localhost:8000/v1/audio/transcriptions"));
        assert!(is_local_endpoint("ws://localhost:2702"));
        assert!(is_local_endpoint("ws://127.0.0.1:2700"));
        assert!(is_local_endpoint("ws://[::1]:2700"));
        assert!(!is_local_endpoint("https://api.openai.com/v1/audio/transcriptions"));
        assert!(!is_local_endpoint("ws://my-server.lan:2700"));
    }
}
