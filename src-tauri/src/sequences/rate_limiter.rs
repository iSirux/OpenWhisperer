//! Rate limiting for sequence prompt execution.
//!
//! Provides a global concurrency semaphore and per-provider RPM tracking
//! to prevent overloading Claude/LLM APIs during parallel sequence execution.

use std::collections::HashMap;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// Rate limiter for sequence prompt execution.
///
/// Limits concurrent prompt calls via a semaphore and tracks per-provider
/// request rates using a sliding window.
pub struct SequenceRateLimiter {
    /// Global concurrency limit for prompt nodes
    prompt_semaphore: Arc<Semaphore>,
    /// Per-provider request timestamps for RPM tracking
    provider_requests: Mutex<HashMap<String, Vec<DateTime<Utc>>>>,
    /// Default RPM limit per provider
    default_rpm: u32,
}

impl SequenceRateLimiter {
    /// Create a new rate limiter.
    ///
    /// - `max_concurrent_prompts` — maximum number of prompt nodes running simultaneously
    /// - `default_provider_rpm` — default requests-per-minute limit per provider
    pub fn new(max_concurrent_prompts: usize, default_provider_rpm: u32) -> Self {
        Self {
            prompt_semaphore: Arc::new(Semaphore::new(max_concurrent_prompts)),
            provider_requests: Mutex::new(HashMap::new()),
            default_rpm: default_provider_rpm,
        }
    }

    /// Acquire a permit for a prompt execution.
    ///
    /// Blocks until a slot is available within the concurrency limit.
    pub async fn acquire_prompt_permit(&self) -> Result<OwnedSemaphorePermit, String> {
        self.prompt_semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| format!("Rate limiter semaphore closed: {}", e))
    }

    /// Check if a provider is rate-limited.
    ///
    /// Returns `Some(delay_ms)` if we should wait before sending, `None` if OK.
    pub fn check_provider_rate(&self, provider: &str) -> Option<u64> {
        let mut requests = self.provider_requests.lock();
        let now = Utc::now();
        let window_start = now - chrono::Duration::seconds(60);

        if let Some(timestamps) = requests.get_mut(provider) {
            // Prune old entries outside the 60s window
            timestamps.retain(|t| *t > window_start);

            if timestamps.len() as u32 >= self.default_rpm {
                // Calculate how long until the oldest request falls out of the window
                if let Some(oldest) = timestamps.first() {
                    let wait_until = *oldest + chrono::Duration::seconds(60);
                    let delay = (wait_until - now).num_milliseconds().max(100) as u64;
                    return Some(delay);
                }
            }
        }

        None
    }

    /// Record a request for a provider.
    pub fn record_request(&self, provider: &str) {
        let mut requests = self.provider_requests.lock();
        requests
            .entry(provider.to_string())
            .or_default()
            .push(Utc::now());
    }

    /// Handle a rate-limit response from a provider.
    ///
    /// Returns the recommended delay in milliseconds.
    #[allow(dead_code)]
    pub fn handle_rate_limit_response(&self, provider: &str, retry_after_secs: Option<u64>) -> u64 {
        // If the provider told us a Retry-After, use it
        if let Some(secs) = retry_after_secs {
            return secs * 1000;
        }

        // Otherwise, check our own tracking
        if let Some(delay) = self.check_provider_rate(provider) {
            return delay;
        }

        // Default backoff: 5 seconds
        5000
    }

    /// Calculate a stagger delay for parallel branch execution.
    ///
    /// Each branch gets a small offset to avoid thundering-herd API calls.
    pub fn stagger_delay_ms(parallel_index: usize) -> u64 {
        (parallel_index as u64) * 100
    }
}
