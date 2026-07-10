# Local transcription containers

Self-hosted real-time STT servers for OpenWhisperer. Neither project publishes an official Docker image, so we build our own — both are small, CPU-only, and speak protocols the app already implements.

**Normal usage is fully in-app:** these build contexts are embedded into the binary at compile time (`src-tauri/src/commands/docker_cmds.rs`), and Settings → Real-time has a **Build & Start Container** button per provider that writes the context to the config dir and runs `docker build` + `docker run` in a terminal window. The manual commands below are only for building outside the app.

Background/evaluation: see `docs/local-transcription-research-2026-07.md`.

## sherpa-onnx (streaming Zipformer, English)

True streaming transducer — genuine partials, ~44 ms latency, runs far faster than real time on CPU. Speaks the app's existing **SherpaOnnx** provider protocol (binary float32 in, `{"text", "is_final"}` out, `"Done"` to finalize).

```bash
docker build -t open-whisperer-sherpa-onnx docker/sherpa-onnx
docker run -d --restart unless-stopped --name sherpa-onnx -p 6006:6006 open-whisperer-sherpa-onnx
```

**App config:** Settings → Real-time → provider **Sherpa-ONNX**, endpoint `ws://localhost:6006`, sample rate 16000.

Model is baked into the image at build time (`sherpa-onnx-streaming-zipformer-en-2023-06-26`). For a lighter image, build with `--build-arg MODEL=sherpa-onnx-streaming-zipformer-en-20M-2023-02-17` (adjust the model filenames in the CMD to the int8 variants).

## Moonshine v2 (streaming, English)

Streaming-native Whisper-quality model (Medium Streaming beats whisper-large-v3 on WER while streaming on CPU). No server mode upstream, so `server.py` wraps the `moonshine-voice` library behind the **Vosk** WebSocket protocol — the app's Vosk provider connects to it unchanged.

```bash
docker build -t open-whisperer-moonshine docker/moonshine
docker run -d --restart unless-stopped --name moonshine -p 2702:2702 open-whisperer-moonshine
```

**App config:** Settings → Real-time → provider **Moonshine** (first-class provider; its sessions reuse the Vosk protocol implementation under the hood), endpoint `ws://localhost:2702`, sample rate 16000.

Port 2702 (2700 = real Vosk, 2701 = Speaches) so it can run alongside Vosk for A/B comparison.

**Status: prototype server.** The `moonshine-voice` pip API (`Transcriber.add_audio`, line-event listeners) was taken from the package docs as of v0.0.65; `server.py` asserts the API at startup and documents the mapping.
