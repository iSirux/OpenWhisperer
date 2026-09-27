//! Headless end-to-end check of the meeting pipeline against real local
//! services (no speakers, no GUI). `#[ignore]`d — run explicitly:
//!
//! ```text
//! cargo test --lib meeting::e2e_tests -- --ignored --nocapture
//! ```
//!
//! Needs:
//! - a speech WAV (16-bit PCM mono/stereo, any rate) at `OW_E2E_WAV`
//!   (default `%TEMP%/ow-meeting-e2e/playtest.wav`)
//! - an OpenAI-compatible Whisper server (`OW_E2E_WHISPER`, default
//!   `http://127.0.0.1:8000/v1/audio/transcriptions`, model `OW_E2E_WHISPER_MODEL`)
//! - an OpenAI-compatible chat server (`OW_E2E_LLM`, default
//!   `http://127.0.0.1:1234/v1/chat/completions`) — set `OW_E2E_SKIP_LLM=1` to skip
//!
//! It drives the same building blocks the live pipeline uses (Resampler →
//! Segmenter → WAV → `whisper::transcribe_detailed` with `build_prompt` /
//! `resolve_speaker` → transcript.jsonl via `storage::*_in`) in a temp meetings
//! dir, then runs the real `LlmRouter::meeting_triage_with_usage` and
//! `meeting_consolidate_with_usage` on the resulting transcript.
//! `MeetingHandle` itself is not used because it needs a Wry `AppHandle`.

use std::path::PathBuf;

use crate::config::{LlmProvider, MeetingConfig, WhisperConfig, WhisperProvider};
use crate::llm::{
    LlmClient, LlmFeature, LlmRouter, MeetingConsolidateItem, MeetingConsolidateRequest,
    MeetingTriageRequest,
};

use super::pipeline::{build_prompt, resolve_speaker};
use super::resample::Resampler;
use super::storage;
use super::types::{LineStatus, MeetingMeta, MeetingSources, MeetingStatus, TranscriptLine};
use super::vad::{Segmenter, VadConfig, SAMPLE_RATE};
use super::wav::encode_wav_i16;

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| default.to_string())
}

/// Minimal logger so the provider's `format=` / fallback lines are visible.
struct StderrLogger;
impl log::Log for StderrLogger {
    fn enabled(&self, m: &log::Metadata) -> bool {
        m.level() <= log::Level::Info
    }
    fn log(&self, r: &log::Record) {
        if self.enabled(r.metadata()) {
            eprintln!("[{}] {}", r.level(), r.args());
        }
    }
    fn flush(&self) {}
}

/// Decode a 16-bit PCM WAV into mono f32 + sample rate.
fn read_wav_pcm16(bytes: &[u8]) -> (Vec<f32>, u32) {
    assert!(&bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE", "not a WAV file");
    let mut pos = 12;
    let (mut channels, mut rate, mut bits) = (1u16, 16_000u32, 16u16);
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let len = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().unwrap()) as usize;
        let body = &bytes[pos + 8..(pos + 8 + len).min(bytes.len())];
        if id == b"fmt " {
            channels = u16::from_le_bytes([body[2], body[3]]);
            rate = u32::from_le_bytes(body[4..8].try_into().unwrap());
            bits = u16::from_le_bytes([body[14], body[15]]);
        } else if id == b"data" {
            assert_eq!(bits, 16, "only 16-bit PCM supported");
            let frames = body.len() / (2 * channels as usize);
            let mut out = Vec::with_capacity(frames);
            for f in 0..frames {
                let mut acc = 0f32;
                for c in 0..channels as usize {
                    let i = (f * channels as usize + c) * 2;
                    acc += i16::from_le_bytes([body[i], body[i + 1]]) as f32 / 32768.0;
                }
                out.push(acc / channels as f32);
            }
            return (out, rate);
        }
        pos += 8 + len + (len & 1);
    }
    panic!("WAV has no data chunk");
}

fn hms(secs: f64) -> String {
    let t = secs.max(0.0).floor() as u64;
    format!("{:02}:{:02}:{:02}", t / 3600, (t / 60) % 60, t % 60)
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs local whisper + llama servers and a generated WAV"]
async fn meeting_pipeline_end_to_end() {
    let _ = log::set_boxed_logger(Box::new(StderrLogger)).map(|()| log::set_max_level(log::LevelFilter::Info));

    // ---- 1. audio → resample → VAD segments --------------------------------
    let wav_path = PathBuf::from(env_or(
        "OW_E2E_WAV",
        &std::env::temp_dir().join("ow-meeting-e2e").join("playtest.wav").to_string_lossy(),
    ));
    let bytes = std::fs::read(&wav_path).unwrap_or_else(|e| panic!("read {:?}: {}", wav_path, e));
    let (samples, rate) = read_wav_pcm16(&bytes);
    eprintln!("input: {:?} {} Hz, {:.1} s", wav_path, rate, samples.len() as f64 / rate as f64);

    let mcfg = MeetingConfig::default();
    let mut seg = Segmenter::new(VadConfig::from_meeting(
        mcfg.vad_threshold,
        mcfg.silence_hangover_ms,
        mcfg.max_segment_secs,
    ));
    let mut resampler = Resampler::new(rate, SAMPLE_RATE);
    let mut segments = Vec::new();
    let mut buf = Vec::new();
    // ~10 ms capture-sized chunks, like a WASAPI/cpal callback.
    for chunk in samples.chunks((rate / 100) as usize) {
        buf.clear();
        resampler.process(chunk, &mut buf);
        segments.extend(seg.push(&buf));
    }
    segments.extend(seg.flush());
    eprintln!("VAD: {} segment(s)", segments.len());
    for s in &segments {
        eprintln!("  {:6.2}–{:6.2} s ({:.2} s)", s.t0(), s.t1(), s.t1() - s.t0());
    }
    assert!(segments.len() >= 5, "expected several utterances, got {}", segments.len());
    for w in segments.windows(2) {
        assert!(w[1].t0() >= w[0].t1(), "segments overlap");
    }

    // ---- 2. segments → WAV → whisper → transcript.jsonl --------------------
    let root = std::env::temp_dir().join(format!("ow-meeting-e2e-root-{}", storage::now_ms()));
    let id = format!("mtg-{}", storage::now_ms());
    let meta = MeetingMeta {
        id: id.clone(),
        title: "Playtest review".into(),
        started_at: storage::now_ms(),
        ended_at: None,
        status: MeetingStatus::Recording,
        repo_id: None,
        auto_repo: false,
        context: Some("Weekly playtest of the platformer demo".into()),
        summary: None,
        sources: MeetingSources { mic: false, system: true, system_target: "all".into() },
        segment_count: 0,
        pending_segments: 0,
        failed_segments: 0,
        duration_secs: samples.len() as f64 / rate as f64,
        vocabulary: vec!["HUD".into(), "playtest".into()],
    };
    storage::write_meta_in(&root, &meta).unwrap();
    let audio_dir = root.join(&id).join("audio");
    std::fs::create_dir_all(&audio_dir).unwrap();

    let wcfg = WhisperConfig {
        provider: WhisperProvider::Local,
        endpoint: env_or("OW_E2E_WHISPER", "http://127.0.0.1:8000/v1/audio/transcriptions"),
        model: env_or("OW_E2E_WHISPER_MODEL", "Systran/faster-whisper-large-v3"),
        ..WhisperConfig::default()
    };
    let speaker = "them";
    let mut previous: Option<String> = None;
    for (i, s) in segments.iter().enumerate() {
        let seg_id = storage::seg_id(i as u32 + 1, speaker);
        let mut line = TranscriptLine {
            seg_id: seg_id.clone(),
            t0: s.t0(),
            t1: s.t1(),
            speaker: speaker.into(),
            text: String::new(),
            status: LineStatus::Pending,
            error: None,
        };
        storage::append_line_in(&root, &id, &line).unwrap();
        let wav = encode_wav_i16(&s.samples, SAMPLE_RATE);
        std::fs::write(audio_dir.join(format!("{}.wav", seg_id)), &wav).unwrap();

        let prompt = build_prompt(&meta.vocabulary, previous.as_deref());
        let started = std::time::Instant::now();
        match crate::whisper::transcribe_detailed(
            &wcfg,
            wav,
            &format!("{}.wav", seg_id),
            "audio/wav",
            prompt.as_deref(),
        )
        .await
        {
            Ok(out) => {
                line.text = out.text.trim().to_string();
                line.speaker = resolve_speaker(speaker, &out.segments);
                line.status = LineStatus::Ok;
                eprintln!(
                    "  {} ok in {} ms ({} provider segment(s))",
                    seg_id,
                    started.elapsed().as_millis(),
                    out.segments.len()
                );
                if !line.text.is_empty() {
                    previous = Some(line.text.clone());
                }
            }
            Err(e) => {
                line.status = LineStatus::Error;
                line.error = Some(e);
            }
        }
        storage::append_line_in(&root, &id, &line).unwrap();
    }

    let raw = storage::read_lines_in(&root, &id).unwrap();
    assert_eq!(raw.len(), segments.len() * 2, "pending + final line per segment");
    let lines = storage::dedup_lines(raw);
    eprintln!("\ntranscript.jsonl ({:?}), deduped:", root.join(&id).join("transcript.jsonl"));
    for l in &lines {
        eprintln!("  {:?}", serde_json::to_string(l).unwrap());
    }
    let errors: Vec<_> = lines.iter().filter(|l| l.status != LineStatus::Ok).collect();
    assert!(errors.is_empty(), "failed segments: {:?}", errors);
    let full = lines.iter().map(|l| l.text.to_lowercase()).collect::<Vec<_>>().join(" ");
    for word in ["inventory", "jump", "score", "multiplayer", "cave"] {
        assert!(full.contains(word), "transcript lacks '{}'", word);
    }

    // Same line format the frontend sends (`[HH:MM:SS speaker] text`).
    let transcript = lines
        .iter()
        .map(|l| format!("[{} {}] {}", hms(l.t0), l.speaker, l.text.trim()))
        .collect::<Vec<_>>()
        .join("\n");
    eprintln!("\ntriage input:\n{}\n", transcript);

    if std::env::var("OW_E2E_SKIP_LLM").is_ok() {
        return;
    }

    // ---- 3. triage + consolidation on the local LLM ------------------------
    let client = || {
        LlmClient::new(
            String::new(),
            env_or("OW_E2E_LLM_MODEL", "qwen"),
            LlmProvider::Local,
            Some(env_or("OW_E2E_LLM", "http://127.0.0.1:1234/v1/chat/completions")),
            false,
        )
        .with_disable_thinking(true)
    };
    let router = LlmRouter::for_tests(vec![("local".into(), client())], LlmFeature::MeetingTriage);
    let request = MeetingTriageRequest {
        transcript: transcript.clone(),
        items: vec![],
        journal_items: vec![],
        repos: None,
        context: Some("Meeting: Playtest review".into()),
    };
    let started = std::time::Instant::now();
    let result = router.meeting_triage_with_usage(&request).await.expect("triage failed");
    eprintln!(
        "\ntriage: {} op(s) in {} ms, usage in/out {}/{}",
        result.data.ops.len(),
        started.elapsed().as_millis(),
        result.usage.input_tokens,
        result.usage.output_tokens
    );
    println!("{}", serde_json::to_string_pretty(&result.data).unwrap());
    let ops = &result.data.ops;
    assert!(!ops.is_empty(), "triage returned no ops");
    assert!(
        ops.iter().any(|o| o.category.as_deref() == Some("bug")),
        "expected at least one bug"
    );
    for o in ops {
        assert!(!o.quote.is_empty() && o.t0.len() == 8, "bad op {:?}", o);
    }

    let items: Vec<MeetingConsolidateItem> = ops
        .iter()
        .enumerate()
        .filter(|(_, o)| o.op == "new")
        .map(|(i, o)| MeetingConsolidateItem {
            id: format!("itm_{}", i + 1),
            category: o.category.clone().unwrap_or_default(),
            title: o.title.clone().unwrap_or_default(),
            detail: o.detail.clone().unwrap_or_default(),
            sightings: 1,
        })
        .collect();
    let router =
        LlmRouter::for_tests(vec![("local".into(), client())], LlmFeature::MeetingConsolidate);
    let started = std::time::Instant::now();
    let consolidated = router
        .meeting_consolidate_with_usage(&MeetingConsolidateRequest {
            transcript,
            items,
            context: Some("Meeting: Playtest review".into()),
        })
        .await
        .expect("consolidate failed");
    eprintln!("\nconsolidate in {} ms:", started.elapsed().as_millis());
    println!("{}", serde_json::to_string_pretty(&consolidated.data).unwrap());
    assert!(consolidated.data.summary.contains("## Overview"));
}
