//! Prompt-calibration tests for transcription cleanup/merge.
//!
//! These are NOT assertion tests: LLM output is nondeterministic, so each case
//! prints the model's output (3 runs) for a human/AI to judge against the
//! documented expectation, and the prompt is iterated on until the runs look
//! right. Every case is a real recording from the debug recordings log that
//! either failed (concatenated merge, hallucinated words) or serves as a
//! control that must keep working.
//!
//! They hit the live Groq API with the production model, so they are `#[ignore]`d.
//! The key is read from the `GROQ_API_KEY` env var or from `src-tauri/.env.local`
//! (git-ignored, line `GROQ_API_KEY=...`).
//!
//! Run all:
//! ```text
//! cargo test --lib cleanup_prompt -- --ignored --nocapture --test-threads=1
//! ```
//! Run one case:
//! ```text
//! cargo test --lib cleanup_prompt_01 -- --ignored --nocapture
//! ```
//!
//! The output tags each run with the length guard's verdict: `guard TRIPPED`
//! means production would have discarded that output and fallen back to the raw
//! Whisper transcript. The guard is a safety net — a tripped guard still counts
//! as a prompt failure for calibration purposes.

use super::types::TranscriptionCleanupResult;
use super::LlmClient;
use crate::config::{LlmModelPriority, LlmProvider};

/// The production cleanup model (Settings → LLM: Groq / gpt-oss-120b).
const MODEL: &str = "openai/gpt-oss-120b";
const RUNS: usize = 3;

struct Case {
    /// What historically went wrong (or "(control)" for cases that worked).
    failure: &'static str,
    /// What a good output looks like — the judgment criterion.
    expect: &'static str,
    whisper: &'static str,
    realtime: Option<&'static str>,
}

fn groq_api_key() -> String {
    if let Ok(key) = std::env::var("GROQ_API_KEY") {
        if !key.trim().is_empty() {
            return key.trim().to_string();
        }
    }
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(".env.local");
    if let Ok(content) = std::fs::read_to_string(&path) {
        for line in content.lines() {
            if let Some(value) = line.trim().strip_prefix("GROQ_API_KEY=") {
                let value = value.trim().trim_matches('"');
                if !value.is_empty() {
                    return value.to_string();
                }
            }
        }
    }
    panic!(
        "GROQ_API_KEY not found — set the env var or put `GROQ_API_KEY=...` in {} (git-ignored)",
        path.display()
    );
}

fn run_case(name: &str, case: &Case) {
    let client = LlmClient::new(
        groq_api_key(),
        MODEL.to_string(),
        LlmProvider::Groq,
        None,
        false,
        LlmModelPriority::Speed,
    );
    let prompt = LlmClient::build_cleanup_prompt(case.whisper, case.realtime, None);
    let schema = LlmClient::cleanup_schema();

    println!("\n{}", "=".repeat(100));
    println!("CASE {name}  ({MODEL}, {RUNS} runs)");
    println!("  failure : {}", case.failure);
    println!("  expect  : {}", case.expect);
    println!("  WHISPER : {}", case.whisper);
    match case.realtime {
        Some(realtime) => println!("  REALTIME: {realtime}"),
        None => println!("  REALTIME: (none — single-source cleanup)"),
    }
    println!("{}", "-".repeat(100));

    let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
    for run in 1..=RUNS {
        // Free-tier Groq enforces a small tokens-per-minute budget; back off and
        // retry instead of reporting a rate limit as a prompt failure.
        let mut result;
        let mut attempts = 0;
        loop {
            result = rt.block_on(
                client.generate_structured_with_usage::<TranscriptionCleanupResult>(
                    &prompt,
                    Some(schema.clone()),
                ),
            );
            match &result {
                Err(error) if error.contains("429") && attempts < 3 => {
                    attempts += 1;
                    println!("  run {run}: rate-limited, backing off 25s (attempt {attempts})");
                    std::thread::sleep(std::time::Duration::from_secs(25));
                }
                _ => break,
            }
        }
        match result {
            Ok(generated) => {
                let guard = LlmClient::cleanup_exceeds_length_guard(
                    case.whisper,
                    case.realtime,
                    &generated.data.cleaned_text,
                );
                let guard_tag = if guard { "guard TRIPPED" } else { "guard ok" };
                println!("  run {run} [{guard_tag}]: {}", generated.data.cleaned_text);
                if !generated.data.corrections_made.is_empty() {
                    println!("           corrections: {:?}", generated.data.corrections_made);
                }
            }
            Err(error) => println!("  run {run} FAILED: {error}"),
        }
        // Stay clear of Groq per-minute rate limits.
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
}

/// Prints the exact production prompt (dual-source shape) — no API call.
/// Useful when iterating on the prompt text itself.
#[test]
#[ignore = "prints the prompt; run with --nocapture"]
fn cleanup_prompt_00_dump() {
    let prompt = LlmClient::build_cleanup_prompt(
        "The cleanup or merge of transcripts has been pretty awful after we changed things. I think we're running the latest version, I'm not sure. Look at the prompt and see why these are happening and also look at some of the recent recordings in the log to see what's going wrong.",
        Some(
            "A clean-up or merge-off. The transcript has been pretty awful after we changed things. I think we're running the latest version. I'm not sure. Look at the prompt and see Why this are happening And also look at some of the recent Recordings in the lobby Um... To see what's going on",
        ),
        None,
    );
    println!("{prompt}");
}

#[test]
#[ignore = "hits the live Groq API — see module docs for how to run"]
fn cleanup_prompt_01_organization_vs_navigation() {
    run_case(
        "organization_vs_navigation",
        &Case {
            failure: "cleaned output kept BOTH sentences back to back (concatenation instead of merge)",
            expect: "ONE sentence — organization/navigation is the same utterance misheard by one \
                     engine, so exactly one reading survives and nothing is appended",
            whisper: "Also there's no way to select an organization when there's no connection like in this case.",
            realtime: Some(
                "Also there's no way to select the navigation when there's no connection I like in this case.",
            ),
        },
    );
}

#[test]
#[ignore = "hits the live Groq API — see module docs for how to run"]
fn cleanup_prompt_02_remove_number_two() {
    run_case(
        "remove_number_two",
        &Case {
            failure: "appended a hallucinated near-duplicate: 'And we can completely remove them.'",
            expect: "the sentence exactly once, at most punctuation fixed; no second sentence",
            whisper: "And we can completely remove number two we don't need it anymore.",
            realtime: Some("And we can completely remove number two we don't need it anymore"),
        },
    );
}

#[test]
#[ignore = "hits the live Groq API — see module docs for how to run"]
fn cleanup_prompt_03_rename_drafts() {
    run_case(
        "rename_drafts",
        &Case {
            failure: "appended a hallucinated 'Amen.' that appears in neither transcript",
            expect: "one sentence using the 'For number one' reading; no invented words, no \
                     dangling 'Everywhere.' fragment",
            whisper: "For number one, let's just rename it drafts everywhere.",
            realtime: Some("Or number one, let's just rename it drafts. Everywhere."),
        },
    );
}

#[test]
#[ignore = "hits the live Groq API — see module docs for how to run"]
fn cleanup_prompt_04_hubspot_duplicated() {
    run_case(
        "hubspot_duplicated",
        &Case {
            failure: "appended a stray 'here' at the end",
            expect: "both sentences unchanged ('hub spot' → 'HubSpot' would also be fine); no \
                     trailing additions",
            whisper: "Also the viewing hub spot is duplicated. We only need it in the right pane.",
            realtime: Some(
                "Also the viewing hub spot is duplicated. we only need it in the right pane.",
            ),
        },
    );
}

#[test]
#[ignore = "hits the live Groq API — see module docs for how to run"]
fn cleanup_prompt_05_value_not_synced() {
    run_case(
        "value_not_synced",
        &Case {
            failure: "(control — output was OK, but the corrections list claimed edits never made)",
            expect: "whisper's reading essentially unchanged; realtime's stuttered 'but But' must \
                     not leak in",
            whisper: "Also, the value isn't synced, it should be $1,000, but there's nothing now.",
            realtime: Some(
                "Also the value isn't synced it should be a thousand dollars but But there's nothing now.",
            ),
        },
    );
}

#[test]
#[ignore = "hits the live Groq API — see module docs for how to run"]
fn cleanup_prompt_06_crm_organization() {
    run_case(
        "crm_organization",
        &Case {
            failure: "(control — worked: 'Syrian' resolved to 'CRM', grammar fixed)",
            expect: "single merged reading based on whisper; 'CRM' kept; none of the realtime \
                     fragments ('a different face') appended",
            whisper: "There's probably a bug in the sync code or somewhere because it has the CRM organization but no organization even though they're definitely is a connection or should be in this case.",
            realtime: Some(
                "Only a bug in the... Sync code or somewhere because it has the Syrian organization, but no organization, even though. there They're a different face, the connection. Or should be in this case",
            ),
        },
    );
}

#[test]
#[ignore = "hits the live Groq API — see module docs for how to run"]
fn cleanup_prompt_08_menu_icons_sorry() {
    run_case(
        "menu_icons_sorry",
        &Case {
            failure: "reinserted B's filler 'Um...' into A's text and appended a hallucinated \
                      'And I'm sorry.' that appears in neither transcript",
            expect: "whisper's reading essentially unchanged; no 'Um...', no invented apology",
            whisper: "The icons in the menu, pipeline menu thing look pretty awful. I think we should move the buttons and icons out of this menu and somewhere else.",
            realtime: Some(
                "The icons in the menu, pipeline menu thing Look pretty awful Um... I think we should move the buttons and icons out of this Menu And somewhere else",
            ),
        },
    );
}

#[test]
#[ignore = "hits the live Groq API — see module docs for how to run"]
fn cleanup_prompt_07_log_vs_lobby() {
    run_case(
        "log_vs_lobby",
        &Case {
            failure: "(control — worked: whisper base kept, 'lobby'/'Um' fragments not leaked)",
            expect: "whisper's text essentially unchanged; 'log' not 'lobby'; no 'Um'",
            whisper: "The cleanup or merge of transcripts has been pretty awful after we changed things. I think we're running the latest version, I'm not sure. Look at the prompt and see why these are happening and also look at some of the recent recordings in the log to see what's going wrong.",
            realtime: Some(
                "A clean-up or merge-off. The transcript has been pretty awful after we changed things. I think we're running the latest version. I'm not sure. Look at the prompt and see Why this are happening And also look at some of the recent Recordings in the lobby Um... To see what's going on",
            ),
        },
    );
}
