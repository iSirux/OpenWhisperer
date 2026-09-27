//! llama.cpp runtime: pick the right prebuilt release asset for this machine,
//! download it (resumable, SHA-256-checked against the GitHub asset digest)
//! and extract it into a versioned directory.
//!
//! Release shape (checked 2026-09-27, b11222): every build is published as a
//! GitHub *pre-release* tagged `b<N>` (the repo's "latest" release is an
//! unrelated `v0.5.0` placeholder), so we list releases and take the newest
//! `b<N>` one that carries the asset we need. Windows zips are flat; macOS /
//! Linux tarballs wrap everything in a `llama-<tag>/` directory, so the server
//! binary is located by searching the extracted tree.

use serde::Deserialize;
use std::path::{Path, PathBuf};

use super::hardware::{driver_major, GpuVendor, HardwareProbe};

/// NVIDIA drivers from this major version on support CUDA 13.
pub const CUDA13_MIN_DRIVER: u32 = 580;

#[derive(Debug, Clone, Deserialize)]
pub struct ReleaseAsset {
    pub name: String,
    pub size: u64,
    pub browser_download_url: String,
    /// `sha256:<hex>` (GitHub computes it for every asset).
    #[serde(default)]
    pub digest: Option<String>,
}

impl ReleaseAsset {
    pub fn sha256(&self) -> Option<&str> {
        self.digest.as_deref().and_then(|d| d.strip_prefix("sha256:"))
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Release {
    pub tag_name: String,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub assets: Vec<ReleaseAsset>,
}

/// GPU backend family to fetch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    Cuda13,
    Cuda12,
    Vulkan,
    Metal,
    Cpu,
}

/// Preferred backend for the probed hardware, most capable first; the asset
/// picker walks this list until the release has a matching build.
pub fn backend_preference(probe: &HardwareProbe) -> Vec<Backend> {
    if probe.os == "macos" {
        return vec![Backend::Metal];
    }
    let mut prefs = Vec::new();
    if let Some(gpu) = &probe.gpu {
        match gpu.vendor {
            GpuVendor::Nvidia => {
                let major = gpu.driver_version.as_deref().and_then(driver_major);
                if major.is_some_and(|m| m >= CUDA13_MIN_DRIVER) {
                    prefs.push(Backend::Cuda13);
                }
                prefs.push(Backend::Cuda12);
                prefs.push(Backend::Vulkan);
            }
            GpuVendor::Amd | GpuVendor::Intel | GpuVendor::Other => prefs.push(Backend::Vulkan),
            GpuVendor::Apple | GpuVendor::None => {}
        }
    }
    prefs.push(Backend::Cpu);
    prefs
}

/// The assets to download for one runtime install (main build + optional
/// CUDA runtime DLL/so bundle).
#[derive(Debug, Clone)]
pub struct RuntimeSelection {
    pub tag: String,
    /// Stable variant label, e.g. `cuda-13.4`, `vulkan`, `cpu`, `metal`.
    pub variant: String,
    pub assets: Vec<ReleaseAsset>,
}

fn os_token(os: &str) -> Option<&'static str> {
    match os {
        "windows" => Some("win"),
        "linux" => Some("ubuntu"),
        "macos" => Some("macos"),
        _ => None,
    }
}

fn arch_token(arch: &str) -> Option<&'static str> {
    match arch {
        "x86_64" => Some("x64"),
        "aarch64" => Some("arm64"),
        _ => None,
    }
}

/// Extract the CUDA version from a build name like
/// `llama-b1-bin-win-cuda-13.4-x64.zip` (→ `13.4`).
fn cuda_version_of(name: &str) -> Option<&str> {
    let rest = &name[name.find("-cuda-")? + 6..];
    let end = rest.find('-')?;
    Some(&rest[..end])
}

/// Pick the assets for `backend` from one release, or `None` if it has no
/// matching build.
pub fn select_for_backend(
    release: &Release,
    os: &str,
    arch: &str,
    backend: Backend,
) -> Option<RuntimeSelection> {
    let os_t = os_token(os)?;
    let arch_t = arch_token(arch)?;
    let tag = &release.tag_name;
    let ext = if os == "windows" { ".zip" } else { ".tar.gz" };
    let prefix = format!("llama-{}-bin-{}-", tag, os_t);
    let find = |middle: &str| {
        let wanted = format!("{}{}{}", prefix, middle, ext);
        release.assets.iter().find(|a| a.name == wanted).cloned()
    };

    match backend {
        Backend::Metal => {
            if os != "macos" {
                return None;
            }
            let a = find(arch_t)?;
            Some(RuntimeSelection {
                tag: tag.clone(),
                variant: "metal".into(),
                assets: vec![a],
            })
        }
        Backend::Cpu => {
            let middle = match os {
                "windows" => format!("cpu-{}", arch_t),
                "linux" => arch_t.to_string(),
                _ => return None,
            };
            Some(RuntimeSelection {
                tag: tag.clone(),
                variant: "cpu".into(),
                assets: vec![find(&middle)?],
            })
        }
        Backend::Vulkan => {
            if os == "macos" {
                return None;
            }
            Some(RuntimeSelection {
                tag: tag.clone(),
                variant: "vulkan".into(),
                assets: vec![find(&format!("vulkan-{}", arch_t))?],
            })
        }
        Backend::Cuda13 | Backend::Cuda12 => {
            if os == "macos" {
                return None;
            }
            let major = if backend == Backend::Cuda13 { "13." } else { "12." };
            let suffix = format!("-{}{}", arch_t, ext);
            let main = release
                .assets
                .iter()
                .filter(|a| {
                    a.name.starts_with(&format!("{}cuda-{}", prefix, major))
                        && a.name.ends_with(&suffix)
                })
                .max_by(|a, b| a.name.cmp(&b.name))?
                .clone();
            let cuda = cuda_version_of(&main.name)?.to_string();
            // CUDA runtime bundle: `cudart-llama-bin-win-cuda-13.4-x64.zip` on
            // Windows, `cudart-llama-<tag>-bin-ubuntu-cuda-13.4-x64.tar.gz` on Linux.
            let cudart_tail = format!("-bin-{}-cuda-{}-{}{}", os_t, cuda, arch_t, ext);
            let cudart = release
                .assets
                .iter()
                .find(|a| a.name.starts_with("cudart-llama") && a.name.ends_with(&cudart_tail))
                .cloned();
            let mut assets = vec![main];
            assets.extend(cudart);
            Some(RuntimeSelection {
                tag: tag.clone(),
                variant: format!("cuda-{}", cuda),
                assets,
            })
        }
    }
}

/// Walk the preference list over the newest releases and return the first
/// match. Releases are expected newest-first (GitHub API order).
pub fn select_runtime(
    releases: &[Release],
    os: &str,
    arch: &str,
    prefs: &[Backend],
) -> Option<RuntimeSelection> {
    let builds: Vec<&Release> = releases
        .iter()
        .filter(|r| !r.draft && is_build_tag(&r.tag_name))
        .collect();
    for backend in prefs {
        for release in &builds {
            if let Some(sel) = select_for_backend(release, os, arch, *backend) {
                return Some(sel);
            }
        }
    }
    None
}

fn is_build_tag(tag: &str) -> bool {
    tag.len() > 1 && tag.starts_with('b') && tag[1..].chars().all(|c| c.is_ascii_digit())
}

pub async fn fetch_releases(client: &reqwest::Client) -> Result<Vec<Release>, String> {
    let resp = client
        .get("https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Could not reach GitHub: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!(
            "GitHub API returned HTTP {} while listing llama.cpp releases{}",
            resp.status(),
            if resp.status().as_u16() == 403 {
                " (rate limited — try again in a few minutes)"
            } else {
                ""
            }
        ));
    }
    resp.json::<Vec<Release>>()
        .await
        .map_err(|e| format!("Unexpected GitHub API response: {}", e))
}

/// Name of the server binary on this OS.
pub fn server_binary_name() -> &'static str {
    if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    }
}

/// Find `llama-server` under an extracted runtime directory (depth ≤ 3).
pub fn find_server_binary(dir: &Path) -> Option<PathBuf> {
    fn walk(dir: &Path, depth: u32) -> Option<PathBuf> {
        let direct = dir.join(server_binary_name());
        if direct.is_file() {
            return Some(direct);
        }
        if depth == 0 {
            return None;
        }
        let entries = std::fs::read_dir(dir).ok()?;
        for e in entries.flatten() {
            if e.path().is_dir() {
                if let Some(found) = walk(&e.path(), depth - 1) {
                    return Some(found);
                }
            }
        }
        None
    }
    walk(dir, 3)
}

/// Extract a `.zip` or `.tar.gz` into `dest` using the system `tar`
/// (Windows 10+ ships bsdtar, which reads zips). On Windows the System32 copy
/// is used explicitly — an MSYS/Git `tar` earlier on PATH can't read zips.
pub fn extract(archive: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest)
        .map_err(|e| format!("Failed to create {}: {}", dest.display(), e))?;
    #[cfg(windows)]
    let tar = std::env::var("SystemRoot")
        .map(|root| format!("{}\\System32\\tar.exe", root))
        .unwrap_or_else(|_| "tar".to_string());
    #[cfg(not(windows))]
    let tar = "tar".to_string();
    let archive_s = archive.to_string_lossy().to_string();
    let dest_s = dest.to_string_lossy().to_string();
    let out = crate::proc::run_program(&tar, &["-xf", &archive_s, "-C", &dest_s], None)?;
    if !out.success {
        return Err(format!(
            "Failed to extract {}: {}",
            archive.display(),
            out.stderr.trim()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_llm::hardware::GpuInfo;

    fn asset(name: &str) -> ReleaseAsset {
        ReleaseAsset {
            name: name.to_string(),
            size: 1,
            browser_download_url: format!("https://example.com/{}", name),
            digest: Some("sha256:ab".into()),
        }
    }

    /// Asset list of the real b11222 release (2026-09-27), trimmed.
    fn release(tag: &str) -> Release {
        let names = [
            "cudart-llama-{t}-bin-ubuntu-cuda-12.8-x64.tar.gz",
            "cudart-llama-{t}-bin-ubuntu-cuda-13.4-x64.tar.gz",
            "cudart-llama-bin-win-cuda-12.4-x64.zip",
            "cudart-llama-bin-win-cuda-13.4-arm64.zip",
            "cudart-llama-bin-win-cuda-13.4-x64.zip",
            "llama-{t}-bin-macos-arm64.tar.gz",
            "llama-{t}-bin-macos-x64.tar.gz",
            "llama-{t}-bin-ubuntu-arm64.tar.gz",
            "llama-{t}-bin-ubuntu-cuda-12.8-x64.tar.gz",
            "llama-{t}-bin-ubuntu-cuda-13.4-x64.tar.gz",
            "llama-{t}-bin-ubuntu-vulkan-x64.tar.gz",
            "llama-{t}-bin-ubuntu-x64.tar.gz",
            "llama-{t}-bin-win-cpu-arm64.zip",
            "llama-{t}-bin-win-cpu-x64.zip",
            "llama-{t}-bin-win-cuda-12.4-x64.zip",
            "llama-{t}-bin-win-cuda-13.4-arm64.zip",
            "llama-{t}-bin-win-cuda-13.4-x64.zip",
            "llama-{t}-bin-win-vulkan-x64.zip",
            "llama-{t}-ui.tar.gz",
        ];
        Release {
            tag_name: tag.to_string(),
            draft: false,
            assets: names.iter().map(|n| asset(&n.replace("{t}", tag))).collect(),
        }
    }

    fn names(sel: &RuntimeSelection) -> Vec<String> {
        sel.assets.iter().map(|a| a.name.clone()).collect()
    }

    fn nvidia_probe(driver: &str) -> HardwareProbe {
        HardwareProbe {
            os: "windows".into(),
            arch: "x86_64".into(),
            gpu: Some(GpuInfo {
                name: "RTX".into(),
                vendor: GpuVendor::Nvidia,
                vram_total_mib: Some(16376),
                vram_free_mib: Some(8000),
                driver_version: Some(driver.into()),
                unified_memory: false,
            }),
            ram_total_mib: None,
            cpu_name: None,
            disk_free_mib: None,
            models_dir: ".".into(),
        }
    }

    #[test]
    fn windows_new_nvidia_driver_gets_cuda13_plus_cudart() {
        let rels = vec![release("b11222")];
        let prefs = backend_preference(&nvidia_probe("610.47"));
        let sel = select_runtime(&rels, "windows", "x86_64", &prefs).unwrap();
        assert_eq!(sel.variant, "cuda-13.4");
        assert_eq!(
            names(&sel),
            vec![
                "llama-b11222-bin-win-cuda-13.4-x64.zip",
                "cudart-llama-bin-win-cuda-13.4-x64.zip"
            ]
        );
    }

    #[test]
    fn windows_old_nvidia_driver_gets_cuda12() {
        let rels = vec![release("b11222")];
        let prefs = backend_preference(&nvidia_probe("566.03"));
        let sel = select_runtime(&rels, "windows", "x86_64", &prefs).unwrap();
        assert_eq!(sel.variant, "cuda-12.4");
        assert_eq!(
            names(&sel),
            vec![
                "llama-b11222-bin-win-cuda-12.4-x64.zip",
                "cudart-llama-bin-win-cuda-12.4-x64.zip"
            ]
        );
    }

    #[test]
    fn windows_amd_gets_vulkan_and_no_gpu_gets_cpu() {
        let rels = vec![release("b11222")];
        let mut p = nvidia_probe("0");
        p.gpu.as_mut().unwrap().vendor = GpuVendor::Amd;
        let sel = select_runtime(&rels, "windows", "x86_64", &backend_preference(&p)).unwrap();
        assert_eq!(names(&sel), vec!["llama-b11222-bin-win-vulkan-x64.zip"]);
        p.gpu = None;
        let sel = select_runtime(&rels, "windows", "x86_64", &backend_preference(&p)).unwrap();
        assert_eq!(names(&sel), vec!["llama-b11222-bin-win-cpu-x64.zip"]);
    }

    #[test]
    fn linux_and_macos_assets() {
        let rels = vec![release("b11222")];
        let sel = select_runtime(&rels, "linux", "x86_64", &[Backend::Cuda13]).unwrap();
        assert_eq!(
            names(&sel),
            vec![
                "llama-b11222-bin-ubuntu-cuda-13.4-x64.tar.gz",
                "cudart-llama-b11222-bin-ubuntu-cuda-13.4-x64.tar.gz"
            ]
        );
        let sel = select_runtime(&rels, "linux", "x86_64", &[Backend::Cpu]).unwrap();
        assert_eq!(names(&sel), vec!["llama-b11222-bin-ubuntu-x64.tar.gz"]);
        let sel = select_runtime(&rels, "macos", "aarch64", &[Backend::Metal]).unwrap();
        assert_eq!(names(&sel), vec!["llama-b11222-bin-macos-arm64.tar.gz"]);
        assert_eq!(sel.variant, "metal");
    }

    #[test]
    fn skips_placeholder_and_incomplete_releases() {
        let placeholder = Release {
            tag_name: "v0.5.0".into(),
            draft: false,
            assets: vec![asset("nightly-tag.txt")],
        };
        // Newest build still uploading: no Windows CUDA asset yet.
        let mut partial = release("b11223");
        partial.assets.retain(|a| !a.name.contains("win-cuda"));
        let rels = vec![placeholder, partial, release("b11222")];
        let sel = select_runtime(&rels, "windows", "x86_64", &[Backend::Cuda13]).unwrap();
        assert_eq!(sel.tag, "b11222");
    }

    #[test]
    fn parses_github_digest() {
        let a = asset("x");
        assert_eq!(a.sha256(), Some("ab"));
        assert_eq!(cuda_version_of("llama-b1-bin-win-cuda-13.4-x64.zip"), Some("13.4"));
    }
}
