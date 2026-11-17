//! Windows-only: shed an inherited RedirectionGuard by relaunching the app.
//!
//! RedirectionGuard (the `ProcessRedirectionTrustPolicy` mitigation) makes a
//! process refuse to follow junctions and symlinks that a non-admin user
//! created. Windows propagates it to every child process, and the MSI's
//! post-update `LaunchApplication` custom action (`wix/main.wxs`) starts the
//! app from Windows Installer, which enforces it. So after every in-app update
//! the app — and every agent, shell and `node` it spawns — ran with it
//! enforced, until the user next started the app from Explorer.
//!
//! The visible damage is in agents' repos: pnpm builds `node_modules` out of
//! user-created junctions, so `pnpm install` fails with "The path cannot be
//! traversed because it contains an untrusted mount point. (os error 448)" and
//! every `pnpm typecheck/lint/test` dies with `MODULE_NOT_FOUND`. npm repos
//! (real directories) are unaffected, which made it look repo-specific. uv,
//! fnm and Scoop shims break the same way.
//!
//! A child's mitigation policies come from the parent named at creation, so at
//! startup we check our own policy and, if it is enforced, start a fresh copy
//! of ourselves with Explorer as its parent (`PROC_THREAD_ATTRIBUTE_PARENT_PROCESS`)
//! and exit. Unlike `explorer.exe <path>`, that keeps the command line
//! (`--minimized`, the args the installer forwards) and the working
//! directory. This must run before the single-instance plugin takes its lock,
//! or the new copy would hand off to us and quit.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::Environment::GetCommandLineW;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcess, GetProcessMitigationPolicy,
    InitializeProcThreadAttributeList, OpenProcess, ProcessRedirectionTrustPolicy,
    UpdateProcThreadAttribute, CREATE_NO_WINDOW, EXTENDED_STARTUPINFO_PRESENT,
    LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_CREATE_PROCESS, PROCESS_INFORMATION,
    PROC_THREAD_ATTRIBUTE_PARENT_PROCESS, STARTUPINFOEXW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{GetShellWindow, GetWindowThreadProcessId};

/// Set on the relaunched copy so a relaunch that still inherits the guard
/// (Explorer itself enforcing it) can't turn into a restart loop.
const RELAUNCHED_ENV: &str = "OPENWHISPERER_REDIRECTION_GUARD_RELAUNCHED";

/// What the startup check found; logged from `setup`, since the log plugin
/// does not exist yet when the check runs.
pub enum GuardReport {
    /// Not enforced (the normal case).
    Clear,
    /// Enforced, and we are already the relaunched copy: give up on it.
    StillEnforcedAfterRelaunch,
    /// Enforced, but this is a debug build: relaunching would detach `tauri dev`.
    EnforcedInDevBuild,
    /// Enforced, and the relaunch failed; the app keeps running with it.
    RelaunchFailed(String),
}

impl GuardReport {
    pub fn log(&self) {
        match self {
            GuardReport::Clear => {}
            GuardReport::StillEnforcedAfterRelaunch => log::warn!(
                "[env] RedirectionGuard is still enforced after relaunching via Explorer; \
                 agents cannot follow user-created junctions (pnpm, uv: os error 448)"
            ),
            GuardReport::EnforcedInDevBuild => log::warn!(
                "[env] RedirectionGuard is enforced (inherited from the launching process); \
                 agents cannot follow user-created junctions (pnpm, uv: os error 448). \
                 Debug build, so not relaunching"
            ),
            GuardReport::RelaunchFailed(err) => log::error!(
                "[env] RedirectionGuard is enforced and relaunching via Explorer failed: {err}. \
                 Agents cannot follow user-created junctions (pnpm, uv: os error 448); \
                 start the app from the Start menu to clear it"
            ),
        }
    }
}

/// If this process inherited an enforced RedirectionGuard, relaunch it with
/// Explorer as the parent and exit. Returns only when no relaunch happened.
pub fn shed_inherited_guard() -> GuardReport {
    let relaunched = std::env::var_os(RELAUNCHED_ENV).is_some();
    if relaunched {
        // Don't leak the marker into every agent process we spawn.
        std::env::remove_var(RELAUNCHED_ENV);
    }
    if !is_enforced() {
        return GuardReport::Clear;
    }
    if relaunched {
        return GuardReport::StillEnforcedAfterRelaunch;
    }
    if cfg!(debug_assertions) {
        return GuardReport::EnforcedInDevBuild;
    }
    // Inherited by the child, which removes it again at startup.
    std::env::set_var(RELAUNCHED_ENV, "1");
    match relaunch_under_explorer() {
        Ok(()) => std::process::exit(0),
        Err(err) => {
            std::env::remove_var(RELAUNCHED_ENV);
            GuardReport::RelaunchFailed(err)
        }
    }
}

/// `PROCESS_MITIGATION_REDIRECTION_TRUST_POLICY`: bit 0 = enforce, bit 1 = audit.
fn is_enforced() -> bool {
    let mut flags: u32 = 0;
    let ok = unsafe {
        GetProcessMitigationPolicy(
            GetCurrentProcess(),
            ProcessRedirectionTrustPolicy,
            (&mut flags as *mut u32).cast(),
            std::mem::size_of::<u32>(),
        )
    };
    // Older Windows builds don't know the policy and fail the query: nothing to shed.
    ok != 0 && flags & 1 != 0
}

fn relaunch_under_explorer() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;

    let mut shell_pid: u32 = 0;
    unsafe {
        let shell = GetShellWindow();
        if shell.is_null() {
            return Err("no shell window (Explorer not running)".into());
        }
        GetWindowThreadProcessId(shell, &mut shell_pid);
    }
    if shell_pid == 0 {
        return Err("could not find Explorer's process id".into());
    }

    let explorer = OwnedHandle(unsafe { OpenProcess(PROCESS_CREATE_PROCESS, 0, shell_pid) });
    if explorer.0.is_null() {
        return Err(format!(
            "OpenProcess(explorer): {}",
            std::io::Error::last_os_error()
        ));
    }

    let attrs = AttributeList::new(1)?;
    let parent: HANDLE = explorer.0;
    let ok = unsafe {
        UpdateProcThreadAttribute(
            attrs.ptr(),
            0,
            PROC_THREAD_ATTRIBUTE_PARENT_PROCESS as usize,
            (&parent as *const HANDLE).cast(),
            std::mem::size_of::<HANDLE>(),
            std::ptr::null_mut(),
            std::ptr::null(),
        )
    };
    if ok == 0 {
        return Err(format!(
            "UpdateProcThreadAttribute: {}",
            std::io::Error::last_os_error()
        ));
    }

    let app = wide(exe.as_os_str());
    // Our own command line, verbatim, so quoting survives. CreateProcessW may
    // write to the buffer, hence the copy.
    let mut cmdline = unsafe {
        let p = GetCommandLineW();
        let len = (0..).take_while(|&i| *p.add(i) != 0).count();
        let mut v = std::slice::from_raw_parts(p, len).to_vec();
        v.push(0);
        v
    };

    let mut si: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    si.lpAttributeList = attrs.ptr();
    let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };

    // Environment and working directory: ours (null = inherit from the caller).
    // CREATE_NO_WINDOW is a no-op for the GUI-subsystem release exe; a console
    // build re-parented to Explorer otherwise dies in console setup
    // (STATUS_DLL_INIT_FAILED, seen when testing from a sandboxed shell).
    let ok = unsafe {
        CreateProcessW(
            app.as_ptr(),
            cmdline.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW,
            std::ptr::null(),
            std::ptr::null(),
            &si.StartupInfo,
            &mut pi,
        )
    };
    if ok == 0 {
        return Err(format!(
            "CreateProcessW: {}",
            std::io::Error::last_os_error()
        ));
    }
    unsafe {
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
    }
    Ok(())
}

fn wide(s: &OsStr) -> Vec<u16> {
    s.encode_wide().chain(std::iter::once(0)).collect()
}

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CloseHandle(self.0) };
        }
    }
}

/// Backed by `usize`s: the list must be pointer-aligned, which a byte buffer
/// is not guaranteed to be.
struct AttributeList(Vec<usize>);

impl AttributeList {
    fn new(count: u32) -> Result<Self, String> {
        let mut size: usize = 0;
        // Size query: fails with ERROR_INSUFFICIENT_BUFFER by design.
        unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), count, 0, &mut size) };
        if size == 0 {
            return Err("InitializeProcThreadAttributeList: no size".into());
        }
        let mut buf = vec![0usize; size.div_ceil(std::mem::size_of::<usize>())];
        let ok = unsafe {
            InitializeProcThreadAttributeList(buf.as_mut_ptr().cast(), count, 0, &mut size)
        };
        if ok == 0 {
            return Err(format!(
                "InitializeProcThreadAttributeList: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(Self(buf))
    }

    fn ptr(&self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.0.as_ptr() as *mut usize as LPPROC_THREAD_ATTRIBUTE_LIST
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        unsafe { DeleteProcThreadAttributeList(self.ptr()) };
    }
}
