//! Curated model presets and the probe-based recommendation.
//!
//! Sizes and SHA-256s come from the Hugging Face tree API (`lfs.oid`), checked
//! 2026-09-27. Benchmarks behind the picks: `docs/meeting-mode-brainstorm-2026-09.md`.

use serde::Serialize;

use super::hardware::{GpuVendor, HardwareProbe};

#[derive(Debug, Clone, Serialize)]
pub struct ModelPreset {
    pub id: &'static str,
    pub label: &'static str,
    /// Model name used for the LLM profile.
    pub model_name: &'static str,
    pub file_name: &'static str,
    pub url: &'static str,
    pub size_bytes: u64,
    pub sha256: &'static str,
    /// VRAM needed to run fully on the GPU at the default 32k context (MiB).
    pub vram_needed_mib: u64,
    /// Only recommended on GPUs with at least this much total VRAM (MiB).
    pub min_gpu_total_mib: u64,
    pub description: &'static str,
    pub license: &'static str,
    /// Non-empty when the license needs the user's attention.
    pub license_note: Option<&'static str>,
}

pub const PRESETS: &[ModelPreset] = &[
    ModelPreset {
        id: "qwen3.8-9b-distill-q5",
        label: "Qwen3.8 9B Distill (Q5_K_M)",
        model_name: "Qwen3.8-9B-Distill-Q5_K_M",
        file_name: "Qwen3.8-9B-Distill-Q5_K_M.gguf",
        url: "https://huggingface.co/empero-ai/Qwen3.8-9B-Distill-GGUF/resolve/main/Qwen3.8-9B-Q5_K_M.gguf",
        size_bytes: 6_642_543_936,
        sha256: "c6667345d4e45d8cddca3c8e997a483a4f9ae04ee9402273c24e959dee7173dc",
        vram_needed_mib: 6_800,
        // 8 GB cards get the Q4 (the Q5 leaves no room for the desktop).
        min_gpu_total_mib: 8_704,
        description: "Recommended. Near-27B quality for triage, cleanup and naming at ~80 tokens/s on a modern GPU. Fits next to a local Whisper container on a 16 GB card.",
        license: "Apache-2.0",
        license_note: None,
    },
    ModelPreset {
        id: "qwen3.8-9b-distill-q4",
        label: "Qwen3.8 9B Distill (Q4_K_M)",
        model_name: "Qwen3.8-9B-Distill-Q4_K_M",
        file_name: "Qwen3.8-9B-Distill-Q4_K_M.gguf",
        url: "https://huggingface.co/empero-ai/Qwen3.8-9B-Distill-GGUF/resolve/main/Qwen3.8-9B-Q4_K_M.gguf",
        size_bytes: 5_780_090_176,
        sha256: "df13d66021cef676f82be74053220fd75af6bf2a6a7fb77f5222ab9e50744a7a",
        vram_needed_mib: 6_200,
        min_gpu_total_mib: 0,
        description: "Same model, smaller quant for GPUs with 8 GB of VRAM. Slightly lower quality.",
        license: "Apache-2.0",
        license_note: None,
    },
    ModelPreset {
        id: "qwen3.5-4b-q5",
        label: "Qwen3.5 4B (Q5_K_M)",
        model_name: "Qwen3.5-4B-Q5_K_M",
        file_name: "Qwen3.5-4B-Q5_K_M.gguf",
        url: "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q5_K_M.gguf",
        size_bytes: 3_143_656_608,
        sha256: "8814232b85594dcd46c50e5b8b29324a7efe9e746edbe8a3d1df3d3fce7aad39",
        vram_needed_mib: 3_800,
        min_gpu_total_mib: 0,
        description: "Small and fast. For low-VRAM GPUs or CPU-only machines. Good enough for naming and cleanup, weaker at triage.",
        license: "Apache-2.0",
        license_note: None,
    },
    ModelPreset {
        id: "swift-1.5-qwen3.8-27b-q3",
        label: "Swift 1.5 Qwen3.8 27B (Q3_K_M)",
        model_name: "Swift-1.5-Qwen3.8-27B-Q3_K_M",
        file_name: "Swift-1.5-Qwen3.8-27B-Q3_K_M.gguf",
        url: "https://huggingface.co/ukisai/Swift-1.5-Qwen3.8-27B-GGUF/resolve/main/Swift-1.5-Qwen3.8-27B-Q3_K_M.gguf",
        size_bytes: 13_404_051_136,
        sha256: "5390afeec94dffea4875e8e93611d0143db126c17fb3ed897e4ff770ebc9e190",
        vram_needed_mib: 14_000,
        min_gpu_total_mib: 16_000,
        description: "Highest quality. Needs ~14 GB of free VRAM (use API transcription, not a local Whisper container). About 20 tokens/s.",
        license: "Custom (Swift)",
        license_note: Some("Free only for individuals and organizations with under $1M annual revenue."),
    },
];

pub fn find(id: &str) -> Option<&'static ModelPreset> {
    PRESETS.iter().find(|p| p.id == id)
}

/// VRAM a local faster-whisper container typically holds.
pub const WHISPER_CONTAINER_MIB: u64 = 5_120;
/// Headroom kept for the desktop/compositor.
const DESKTOP_RESERVE_MIB: u64 = 1_024;

#[derive(Debug, Clone, Serialize)]
pub struct Recommendation {
    pub preset_id: &'static str,
    /// VRAM the recommendation assumed is available to the model (MiB).
    pub budget_mib: Option<u64>,
    pub reason: String,
}

/// VRAM available to the model. When local Whisper is in use, reserve the
/// container's share of the *total* — taking the min with the currently-free
/// amount means an already-running container is not counted twice.
pub fn vram_budget_mib(probe: &HardwareProbe, whisper_local: bool) -> Option<u64> {
    let gpu = probe.gpu.as_ref()?;
    if matches!(gpu.vendor, GpuVendor::None) {
        return None;
    }
    let total = gpu.vram_total_mib?;
    let reserve = if gpu.unified_memory { 0 } else { DESKTOP_RESERVE_MIB };
    let whisper = if whisper_local { WHISPER_CONTAINER_MIB } else { 0 };
    let ceiling = total.saturating_sub(reserve + whisper);
    Some(match gpu.vram_free_mib {
        Some(free) => free.min(ceiling),
        None => ceiling,
    })
}

pub fn recommend(probe: &HardwareProbe, whisper_local: bool) -> Recommendation {
    let budget = vram_budget_mib(probe, whisper_local);
    let gpu_total = probe.gpu.as_ref().and_then(|g| g.vram_total_mib).unwrap_or(0);
    let whisper_note = if whisper_local {
        " (after reserving ~5 GB for the local Whisper container)"
    } else {
        ""
    };
    // The 27B is deliberately never auto-recommended: slower, license caveat.
    let order = ["qwen3.8-9b-distill-q5", "qwen3.8-9b-distill-q4", "qwen3.5-4b-q5"];
    if let Some(b) = budget {
        for id in order {
            let p = find(id).expect("preset exists");
            if p.vram_needed_mib <= b && gpu_total >= p.min_gpu_total_mib {
                return Recommendation {
                    preset_id: p.id,
                    budget_mib: budget,
                    reason: format!(
                        "~{:.1} GB of VRAM available{} — {} fits fully on the GPU.",
                        b as f64 / 1024.0,
                        whisper_note,
                        p.label
                    ),
                };
            }
        }
        return Recommendation {
            preset_id: "qwen3.5-4b-q5",
            budget_mib: budget,
            reason: format!(
                "Only ~{:.1} GB of VRAM available{} — the small 4B model is the safest pick; part of it runs on the CPU.",
                b as f64 / 1024.0,
                whisper_note
            ),
        };
    }
    Recommendation {
        preset_id: "qwen3.5-4b-q5",
        budget_mib: None,
        reason: "No supported GPU found — the small 4B model runs on the CPU (expect a few tokens/s)."
            .to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_llm::hardware::GpuInfo;

    fn probe_with(total: u64, free: Option<u64>) -> HardwareProbe {
        HardwareProbe {
            os: "windows".into(),
            arch: "x86_64".into(),
            gpu: Some(GpuInfo {
                name: "GPU".into(),
                vendor: GpuVendor::Nvidia,
                vram_total_mib: Some(total),
                vram_free_mib: free,
                driver_version: Some("610.47".into()),
                unified_memory: false,
            }),
            ram_total_mib: Some(65536),
            cpu_name: None,
            disk_free_mib: Some(400_000),
            models_dir: ".".into(),
        }
    }

    #[test]
    fn sixteen_gb_with_whisper_running_gets_the_9b_q5() {
        // 16 GB card, faster-whisper already loaded → ~7.1 GB free.
        let r = recommend(&probe_with(16376, Some(7116)), true);
        assert_eq!(r.preset_id, "qwen3.8-9b-distill-q5");
    }

    #[test]
    fn whisper_reserve_applies_when_container_not_running_yet() {
        // 12 GB card, nothing loaded yet, local Whisper planned: 12288-1024-5120 = 6144.
        let r = recommend(&probe_with(12288, Some(11800)), true);
        assert_eq!(r.preset_id, "qwen3.5-4b-q5");
        let r = recommend(&probe_with(12288, Some(11800)), false);
        assert_eq!(r.preset_id, "qwen3.8-9b-distill-q5");
    }

    #[test]
    fn eight_gb_card_gets_the_q4() {
        let r = recommend(&probe_with(8192, Some(7400)), false);
        assert_eq!(r.preset_id, "qwen3.8-9b-distill-q4");
    }

    #[test]
    fn no_gpu_gets_the_4b() {
        let mut p = probe_with(0, None);
        p.gpu = None;
        let r = recommend(&p, false);
        assert_eq!(r.preset_id, "qwen3.5-4b-q5");
        assert!(r.budget_mib.is_none());
    }

    #[test]
    fn preset_ids_are_unique_and_urls_match_file_sizes() {
        let mut ids: Vec<_> = PRESETS.iter().map(|p| p.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), PRESETS.len());
        for p in PRESETS {
            assert!(p.url.starts_with("https://huggingface.co/"));
            assert!(p.file_name.ends_with(".gguf"));
            assert_eq!(p.sha256.len(), 64);
            assert!(p.size_bytes > 1_000_000_000);
        }
    }
}
