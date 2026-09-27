//! Hardware probe for the local LLM setup: GPU (name, VRAM total/free, driver),
//! system RAM and free disk space. Every probe is best-effort and windowless —
//! a missing tool just leaves the field empty.

use serde::Serialize;
use std::path::Path;

use crate::proc::run_program;

/// Which GPU family was detected; drives the llama.cpp build choice.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub enum GpuVendor {
    Nvidia,
    Amd,
    Intel,
    Apple,
    Other,
    None,
}

#[derive(Debug, Clone, Serialize)]
pub struct GpuInfo {
    pub name: String,
    pub vendor: GpuVendor,
    /// Dedicated VRAM (MiB). On Apple Silicon this is the unified-memory budget
    /// Metal can use (~70% of RAM).
    pub vram_total_mib: Option<u64>,
    pub vram_free_mib: Option<u64>,
    /// NVIDIA driver version string (e.g. `610.47`).
    pub driver_version: Option<String>,
    /// Apple Silicon: VRAM is system RAM shared with the CPU.
    pub unified_memory: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct HardwareProbe {
    pub os: String,
    pub arch: String,
    pub gpu: Option<GpuInfo>,
    pub ram_total_mib: Option<u64>,
    pub cpu_name: Option<String>,
    /// Free space on the drive holding the models directory.
    pub disk_free_mib: Option<u64>,
    pub models_dir: String,
}

pub fn probe(models_dir: &Path) -> HardwareProbe {
    let _ = std::fs::create_dir_all(models_dir);
    HardwareProbe {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        gpu: probe_gpu(),
        ram_total_mib: ram_total_mib(),
        cpu_name: cpu_name(),
        disk_free_mib: disk_free_mib(models_dir),
        models_dir: models_dir.to_string_lossy().to_string(),
    }
}

/// Parse `nvidia-smi --query-gpu=name,memory.total,memory.free,driver_version
/// --format=csv,noheader,nounits` output; picks the GPU with the most VRAM.
pub fn parse_nvidia_smi(out: &str) -> Option<GpuInfo> {
    out.lines()
        .filter_map(|line| {
            let cols: Vec<&str> = line.split(',').map(|c| c.trim()).collect();
            if cols.len() < 4 || cols[0].is_empty() {
                return None;
            }
            Some(GpuInfo {
                name: cols[0].to_string(),
                vendor: GpuVendor::Nvidia,
                vram_total_mib: cols[1].parse().ok(),
                vram_free_mib: cols[2].parse().ok(),
                driver_version: Some(cols[3].to_string()).filter(|s| !s.is_empty()),
                unified_memory: false,
            })
        })
        .max_by_key(|g| g.vram_total_mib.unwrap_or(0))
}

/// Current free VRAM on the NVIDIA GPU (MiB), re-probed right before a start.
pub fn nvidia_free_vram_mib() -> Option<u64> {
    nvidia_gpu().and_then(|g| g.vram_free_mib)
}

fn nvidia_gpu() -> Option<GpuInfo> {
    let out = run_program(
        "nvidia-smi",
        &[
            "--query-gpu=name,memory.total,memory.free,driver_version",
            "--format=csv,noheader,nounits",
        ],
        None,
    )
    .ok()?;
    if !out.success {
        return None;
    }
    parse_nvidia_smi(&out.stdout)
}

/// VRAM used by one process per `nvidia-smi --query-compute-apps` (MiB).
/// Windows WDDM drivers often report `[N/A]`, hence the `Option`.
pub fn nvidia_process_vram_mib(pid: u32) -> Option<u64> {
    let out = run_program(
        "nvidia-smi",
        &["--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"],
        None,
    )
    .ok()?;
    out.stdout.lines().find_map(|line| {
        let (p, mem) = line.split_once(',')?;
        (p.trim().parse::<u32>().ok()? == pid)
            .then(|| mem.trim().parse::<u64>().ok())
            .flatten()
    })
}

/// NVIDIA driver major version (`610.47` → 610).
pub fn driver_major(version: &str) -> Option<u32> {
    version.split('.').next()?.trim().parse().ok()
}

#[cfg(target_os = "macos")]
fn probe_gpu() -> Option<GpuInfo> {
    let ram = ram_total_mib();
    let apple = std::env::consts::ARCH == "aarch64";
    let name = if apple {
        cpu_name().unwrap_or_else(|| "Apple Silicon".to_string())
    } else {
        "Intel Mac GPU".to_string()
    };
    Some(GpuInfo {
        name,
        vendor: if apple { GpuVendor::Apple } else { GpuVendor::Other },
        // Metal's recommended working set is roughly 2/3–3/4 of RAM.
        vram_total_mib: ram.map(|r| r * 7 / 10),
        vram_free_mib: None,
        driver_version: None,
        unified_memory: apple,
    })
}

#[cfg(target_os = "windows")]
fn probe_gpu() -> Option<GpuInfo> {
    if let Some(g) = nvidia_gpu() {
        return Some(g);
    }
    // No NVIDIA GPU: find any other adapter (AMD/Intel → Vulkan build).
    let out = run_program(
        "powershell",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance Win32_VideoController | ForEach-Object { \"$($_.Name)|$($_.AdapterRAM)\" }",
        ],
        None,
    )
    .ok()?;
    out.stdout
        .lines()
        .filter_map(|line| {
            let (name, ram) = line.trim().split_once('|')?;
            let vendor = vendor_from_name(name);
            if matches!(vendor, GpuVendor::None) {
                return None;
            }
            // AdapterRAM is a uint32 and caps at 4 GiB, so treat it as a floor.
            let vram = ram.trim().parse::<u64>().ok().map(|b| b / (1024 * 1024));
            Some(GpuInfo {
                name: name.trim().to_string(),
                vendor,
                vram_total_mib: vram.filter(|v| *v > 0),
                vram_free_mib: None,
                driver_version: None,
                unified_memory: false,
            })
        })
        .max_by_key(|g| (g.vendor == GpuVendor::Amd, g.vram_total_mib.unwrap_or(0)))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn probe_gpu() -> Option<GpuInfo> {
    if let Some(g) = nvidia_gpu() {
        return Some(g);
    }
    // AMD/Intel via sysfs (Vulkan build).
    let entries = std::fs::read_dir("/sys/class/drm").ok()?;
    let mut best: Option<GpuInfo> = None;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("card") || name.contains('-') {
            continue;
        }
        let dev = entry.path().join("device");
        let vendor_id = std::fs::read_to_string(dev.join("vendor")).unwrap_or_default();
        let vendor = match vendor_id.trim() {
            "0x1002" => GpuVendor::Amd,
            "0x8086" => GpuVendor::Intel,
            "0x10de" => GpuVendor::Nvidia,
            _ => continue,
        };
        let read_mib = |f: &str| {
            std::fs::read_to_string(dev.join(f))
                .ok()
                .and_then(|s| s.trim().parse::<u64>().ok())
                .map(|b| b / (1024 * 1024))
        };
        let total = read_mib("mem_info_vram_total");
        let used = read_mib("mem_info_vram_used");
        let info = GpuInfo {
            name: format!("{:?} GPU ({})", vendor, name),
            vendor,
            vram_total_mib: total,
            vram_free_mib: total.zip(used).map(|(t, u)| t.saturating_sub(u)),
            driver_version: None,
            unified_memory: false,
        };
        if best
            .as_ref()
            .map(|b| b.vram_total_mib.unwrap_or(0) < info.vram_total_mib.unwrap_or(0))
            .unwrap_or(true)
        {
            best = Some(info);
        }
    }
    best
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn vendor_from_name(name: &str) -> GpuVendor {
    let n = name.to_lowercase();
    if n.contains("nvidia") || n.contains("geforce") || n.contains("quadro") {
        GpuVendor::Nvidia
    } else if n.contains("amd") || n.contains("radeon") {
        GpuVendor::Amd
    } else if n.contains("intel") {
        // Basic display adapters are not worth a Vulkan build.
        GpuVendor::Intel
    } else if n.contains("microsoft basic") || n.contains("remote") || n.contains("virtual") {
        GpuVendor::None
    } else {
        GpuVendor::Other
    }
}

#[cfg(target_os = "windows")]
fn ram_total_mib() -> Option<u64> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    let ok = unsafe { GlobalMemoryStatusEx(&mut status) };
    (ok != 0).then(|| status.ullTotalPhys / (1024 * 1024))
}

#[cfg(target_os = "macos")]
fn ram_total_mib() -> Option<u64> {
    let out = run_program("sysctl", &["-n", "hw.memsize"], None).ok()?;
    out.stdout.trim().parse::<u64>().ok().map(|b| b / (1024 * 1024))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn ram_total_mib() -> Option<u64> {
    let info = std::fs::read_to_string("/proc/meminfo").ok()?;
    let line = info.lines().find(|l| l.starts_with("MemTotal:"))?;
    let kb: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kb / 1024)
}

fn cpu_name() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::HKEY_LOCAL_MACHINE;
        winreg::RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0")
            .and_then(|k| k.get_value::<String, _>("ProcessorNameString"))
            .map(|s| s.trim().to_string())
            .ok()
            .or_else(|| std::env::var("PROCESSOR_IDENTIFIER").ok())
    }
    #[cfg(target_os = "macos")]
    {
        run_program("sysctl", &["-n", "machdep.cpu.brand_string"], None)
            .ok()
            .map(|o| o.stdout.trim().to_string())
            .filter(|s| !s.is_empty())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let info = std::fs::read_to_string("/proc/cpuinfo").ok()?;
        info.lines()
            .find(|l| l.starts_with("model name"))
            .and_then(|l| l.split_once(':'))
            .map(|(_, v)| v.trim().to_string())
    }
}

#[cfg(target_os = "windows")]
pub fn disk_free_mib(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    // Walk up to an existing ancestor (the dir may not exist yet).
    let mut p = path.to_path_buf();
    while !p.exists() {
        p = p.parent()?.to_path_buf();
    }
    let wide: Vec<u16> = p.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut free: u64 = 0;
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut free,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    (ok != 0).then(|| free / (1024 * 1024))
}

#[cfg(not(target_os = "windows"))]
pub fn disk_free_mib(path: &Path) -> Option<u64> {
    let mut p = path.to_path_buf();
    while !p.exists() {
        p = p.parent()?.to_path_buf();
    }
    let p_str = p.to_string_lossy().to_string();
    let out = run_program("df", &["-Pk", &p_str], None).ok()?;
    let line = out.stdout.lines().nth(1)?;
    let avail_kb: u64 = line.split_whitespace().nth(3)?.parse().ok()?;
    Some(avail_kb / 1024)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nvidia_smi_and_picks_biggest_gpu() {
        let out = "NVIDIA GeForce GTX 1050, 2048, 1900, 610.47\n\
                   NVIDIA GeForce RTX 4080, 16376, 7116, 610.47\n";
        let g = parse_nvidia_smi(out).unwrap();
        assert_eq!(g.name, "NVIDIA GeForce RTX 4080");
        assert_eq!(g.vram_total_mib, Some(16376));
        assert_eq!(g.vram_free_mib, Some(7116));
        assert_eq!(driver_major(g.driver_version.as_deref().unwrap()), Some(610));
    }

    #[test]
    fn empty_nvidia_smi_output_is_none() {
        assert!(parse_nvidia_smi("").is_none());
    }
}
