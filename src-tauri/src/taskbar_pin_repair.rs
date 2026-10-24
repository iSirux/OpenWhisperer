//! Repair taskbar pins whose icon points at a deleted MSI icon file.
//!
//! The MSI used to give its shortcuts an Icon-table icon, which Windows Installer
//! extracts to `%WINDIR%\Installer\{ProductCode}\ProductIcon`. Every update is a
//! major upgrade with a new ProductCode, so that folder is deleted by the next
//! update. Pinning copies the Start-menu shortcut into `User Pinned\TaskBar`, and
//! the installer never touches that copy — so the pin kept the old icon path and
//! went blank (a generic page icon) once the icon cache let go of it.
//!
//! The installer template no longer sets a shortcut icon (the shortcut then uses
//! the exe's embedded icon), but pins made before that keep the dead path. At
//! startup we point every pin that targets this exe and carries an MSI icon path
//! back at the exe itself. Windows offers no API for pins; editing the `.lnk`
//! copies in place is what the shell itself reads.

use std::path::{Path, PathBuf};

use windows::core::{Interface, HSTRING};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED, STGM_READWRITE,
};
use windows::Win32::UI::Shell::{
    IShellLinkW, SHChangeNotify, ShellLink, SHCNE_ASSOCCHANGED, SHCNF_IDLIST,
};

/// Runs the repair on its own thread (COM init + a handful of file reads).
pub fn spawn() {
    let spawned = std::thread::Builder::new()
        .name("taskbar-pin-repair".into())
        .spawn(|| {
            let Ok(exe) = std::env::current_exe() else {
                return;
            };
            let Some(pinned) = dirs::data_dir()
                .map(|d| d.join(r"Microsoft\Internet Explorer\Quick Launch\User Pinned"))
            else {
                return;
            };
            let repaired = repair_dir(&pinned, &exe);
            if repaired > 0 {
                log::info!("[taskbar] Repaired the icon of {} pinned shortcut(s)", repaired);
                // Make Explorer drop its cached (blank) icons for the pins.
                unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None) };
            }
        });
    if let Err(e) = spawned {
        log::warn!("[taskbar] Could not start the pin repair thread: {}", e);
    }
}

/// Repairs every pinned `.lnk` under `dir` (recursively) that targets `exe`.
/// Returns how many were rewritten.
fn repair_dir(dir: &Path, exe: &Path) -> usize {
    let links = collect_links(dir);
    if links.is_empty() {
        return 0;
    }
    // SAFETY: COM is initialised and torn down on this thread only.
    let init = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    let mut repaired = 0;
    for link in links {
        match repair_link(&link, exe) {
            Ok(true) => repaired += 1,
            Ok(false) => {}
            Err(e) => log::warn!("[taskbar] Could not check {}: {}", link.display(), e),
        }
    }
    if init.is_ok() {
        unsafe { CoUninitialize() };
    }
    repaired
}

fn collect_links(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(collect_links(&path));
        } else if path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("lnk"))
        {
            out.push(path);
        }
    }
    out
}

/// Points `link`'s icon at `exe` when the link targets `exe` and its icon is an
/// MSI-extracted one (or missing). Returns whether the link was rewritten.
fn repair_link(link: &Path, exe: &Path) -> windows::core::Result<bool> {
    unsafe {
        let shell_link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        let file: IPersistFile = shell_link.cast()?;
        file.Load(&HSTRING::from(link.as_os_str()), STGM_READWRITE)?;

        let mut target = [0u16; 1024];
        shell_link.GetPath(&mut target, std::ptr::null_mut(), 0)?;
        if !same_path(&from_wide(&target), exe) {
            return Ok(false);
        }

        let mut icon = [0u16; 1024];
        let mut index = 0i32;
        shell_link.GetIconLocation(&mut icon, &mut index)?;
        if !needs_repair(&from_wide(&icon)) {
            return Ok(false);
        }

        shell_link.SetIconLocation(&HSTRING::from(exe.as_os_str()), 0)?;
        file.Save(None, true)?;
        log::info!(
            "[taskbar] Pointed {} at the exe icon (was {})",
            link.display(),
            from_wide(&icon)
        );
        Ok(true)
    }
}

/// An empty icon location already means "the target's own icon". Anything under
/// `\Installer\` is an MSI-extracted icon that the next update deletes; anything
/// else is left alone unless the file is gone.
fn needs_repair(icon: &str) -> bool {
    if icon.is_empty() {
        return false;
    }
    icon.to_ascii_lowercase().contains(r"\installer\{") || !Path::new(icon).exists()
}

fn same_path(a: &str, b: &Path) -> bool {
    !a.is_empty() && a.eq_ignore_ascii_case(&b.to_string_lossy())
}

fn from_wide(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn msi_icon_paths_need_repair() {
        assert!(needs_repair(
            r"C:\WINDOWS\Installer\{8ED3C9B0-E607-471D-9FD7-1D98DEEF94C2}\ProductIcon"
        ));
        assert!(needs_repair(r"C:\definitely\not\here.ico"));
        assert!(!needs_repair(""));
        assert!(!needs_repair(r"C:\Windows\System32\shell32.dll"));
    }

    /// Builds a pin the way the old MSI did (target exe + Installer icon path)
    /// and checks the repair rewrites only the icon.
    #[test]
    fn repairs_a_pin_with_a_dead_msi_icon() {
        let dir = std::env::temp_dir().join(format!("ow-pin-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let link = dir.join("App.lnk");
        let exe = PathBuf::from(r"C:\Windows\System32\notepad.exe");
        let dead_icon = r"C:\WINDOWS\Installer\{00000000-0000-0000-0000-000000000000}\ProductIcon";

        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().unwrap();
            let shell_link: IShellLinkW =
                CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).unwrap();
            shell_link.SetPath(&HSTRING::from(exe.as_os_str())).unwrap();
            shell_link.SetIconLocation(&HSTRING::from(dead_icon), 0).unwrap();
            let file: IPersistFile = shell_link.cast().unwrap();
            file.Save(&HSTRING::from(link.as_os_str()), true).unwrap();
        }

        let other = PathBuf::from(r"C:\Windows\System32\cmd.exe");
        assert_eq!(repair_dir(&dir, &other), 0, "pins of other apps are left alone");
        assert_eq!(repair_dir(&dir, &exe), 1);
        assert_eq!(repair_dir(&dir, &exe), 0, "a repaired pin stays repaired");

        unsafe {
            let shell_link: IShellLinkW =
                CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).unwrap();
            let file: IPersistFile = shell_link.cast().unwrap();
            file.Load(&HSTRING::from(link.as_os_str()), STGM_READWRITE).unwrap();
            let mut icon = [0u16; 1024];
            let mut index = -1;
            shell_link.GetIconLocation(&mut icon, &mut index).unwrap();
            assert!(same_path(&from_wide(&icon), &exe));
            assert_eq!(index, 0);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
