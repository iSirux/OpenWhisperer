use std::fs;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

struct Inbox(std::path::PathBuf);

impl Inbox {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("ow-timeout-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for Inbox {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn command(inbox: &Inbox) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_ow"));
    command
        .args(["ping", "--timeout", "1", "--json"])
        .env("OPENWHISPERER_INBOX_DIR", &inbox.0)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

fn take_request(inbox: &Inbox) -> String {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        for entry in fs::read_dir(&inbox.0).unwrap().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(id) = name.strip_suffix(".request.json") {
                fs::remove_file(entry.path()).unwrap();
                return id.to_string();
            }
        }
        assert!(Instant::now() < deadline, "CLI did not submit a request");
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn unclaimed_timeout_cancels_request() {
    let inbox = Inbox::new();
    let output = command(&inbox).output().unwrap();
    assert_eq!(output.status.code(), Some(1));
    let ack: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(ack["status"], "cancelled");
    assert_eq!(fs::read_dir(&inbox.0).unwrap().count(), 0);
}

#[test]
fn claimed_timeout_reports_unknown_and_keeps_late_completion_observable() {
    let inbox = Inbox::new();
    let child = command(&inbox).spawn().unwrap();
    let id = take_request(&inbox);
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(3));
    let ack: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(ack["status"], "unknown");
    assert_eq!(ack["id"], id);
    assert!(ack["error"].as_str().unwrap().contains("Do not retry"));
    let path = std::path::PathBuf::from(ack["ackPath"].as_str().unwrap());
    assert_eq!(path, inbox.0.join(format!("{id}.ack.json")));
    fs::write(
        &path,
        json!({"ok": true, "message": "Started session"}).to_string(),
    )
    .unwrap();
    assert!(path.exists());
}

#[test]
fn claimed_request_can_finish_within_explicit_timeout() {
    let inbox = Inbox::new();
    let child = command(&inbox).spawn().unwrap();
    let id = take_request(&inbox);
    thread::sleep(Duration::from_millis(200));
    fs::write(
        inbox.0.join(format!("{id}.ack.json")),
        json!({"ok": true, "message": "Started session"}).to_string(),
    )
    .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let ack: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(ack["message"], "Started session");
    assert_eq!(fs::read_dir(&inbox.0).unwrap().count(), 0);
}

#[test]
fn run_default_waits_for_launch_beyond_old_ten_second_deadline() {
    let inbox = Inbox::new();
    let child = Command::new(env!("CARGO_BIN_EXE_ow"))
        .args([
            "run",
            "--new-worktree",
            "--json",
            "Simulated worktree launch",
        ])
        .env("OPENWHISPERER_INBOX_DIR", &inbox.0)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let id = take_request(&inbox);
    thread::sleep(Duration::from_secs(11));
    fs::write(
        inbox.0.join(format!("{id}.ack.json")),
        json!({"ok": true, "kind": "run", "message": "Started session"}).to_string(),
    )
    .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let ack: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(ack["message"], "Started session");
}
