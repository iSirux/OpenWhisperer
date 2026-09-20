# Launch task queues

In Settings → Repositories, each launch profile has an execution type:

- **Service** starts its commands together and keeps running. Existing profiles default to Service.
- **Task** starts its commands together and completes when all succeed. A failed command pauses the queue.

Set Build to Task, then click Build in the launch bar. While it runs, clicking another profile adds it to the queue. For example: Build → Tests → Front + API. A Service can be the final queue item. Clicking a queued item removes it. Stop All stops the active launch and clears its task queue; Retry reruns a failed task and preserves the queue.

Tasks default to closing their terminals on success. Disable **Close terminal on success** to keep successful output open. Failures keep their terminal open for inspection. Completion is based on the command's exit code, independently of whether its terminal stays open.

Queued launches use the original task's working directory, including its worktree. Queues continue when switching sessions or repositories, but are held in memory and do not survive restarting OpenWhisperer. Existing options for waiting on agents remain available when no task is active.

## Verification

- `pnpm check`
- `node --test scripts/launch-profiles.test.mjs`
- `cargo test --manifest-path src-tauri/Cargo.toml --lib launch`

The Rust terminal tests run hidden on Windows. For a desktop smoke test, configure a short successful Task and a failing Task, queue a Service after each, and verify successful progression versus failure/retry. Also check the configured terminal choice and a worktree session. macOS and Linux terminal integration require testing on those platforms.
