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
use super::{LlmClient, LlmRouter};
use crate::config::LlmProvider;

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
    );
    let prompt = LlmRouter::build_cleanup_prompt(case.whisper, case.realtime, None);
    let schema = LlmRouter::cleanup_schema();

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
                let guard = super::features::cleanup_guard_violation(
                    case.whisper,
                    case.realtime,
                    None,
                    &generated.data.cleaned_text,
                );
                let guard_tag = match &guard {
                    Some(reason) => format!("guard TRIPPED: {reason}"),
                    None => "guard ok".to_string(),
                };
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
    let prompt = LlmRouter::build_cleanup_prompt(
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
fn cleanup_prompt_09_down_arrow_in_its_button() {
    run_case(
        "down_arrow_in_its_button",
        &Case {
            failure: "deleted 'in its button' (present in BOTH transcripts) as 'redundant' — \
                      agreed-on speech dropped for style",
            expect: "'…is not centered in its button' kept; 'I can' → 'icon' fixed; dropping the \
                     'in the' stutter before 'beside' is acceptable",
            whisper: "The down arrow I can in the beside the reject button is not centered in its button.",
            realtime: Some(
                "Down arrow icon In the beside the Reject button It's not centered in its button.",
            ),
        },
    );
}

#[test]
#[ignore = "hits the live Groq API — see module docs for how to run"]
fn cleanup_prompt_10_back_off_retry_domain() {
    run_case(
        "back_off_retry_domain",
        &Case {
            failure: "invented 'retry it' — a phrasing from NEITHER transcript — instead of \
                      choosing between whisper's 'retry a domain' and realtime's 'retry the main'",
            expect: "one of the two readings kept verbatim (whisper's 'retry a domain' is the \
                     plausible one); 'back of' → 'back-off' via realtime is good; no invented words",
            whisper: "Why are you talking about back of numbers? I'm not sure we should even try to retry a domain.",
            realtime: Some(
                "Are you talking about back-off numbers? I'm not sure we should even try to I'll retry the main",
            ),
        },
    );
}

#[test]
#[ignore = "hits the live Groq API — see module docs for how to run"]
fn cleanup_prompt_11_number_one_ok() {
    run_case(
        "number_one_ok",
        &Case {
            failure: "replaced the agreed-on 'number one' with a hallucinated 'OK' \
                      ('double check your OK.')",
            expect: "'double check your number one' kept; recovering B's 'what to do' and \
                     'are' is fine",
            whisper: "I'm not sure I'm pretty sure we already running the latest code so double check your number one",
            realtime: Some(
                "I'm not sure what to do. I'm pretty sure we are already running the latest code. So double check your Number one.",
            ),
        },
    );
}

#[test]
#[ignore = "hits the live Groq API — see module docs for how to run"]
fn cleanup_prompt_12_capture_logs_search_web() {
    run_case(
        "capture_logs_search_web",
        &Case {
            failure: "dropped A's trailing 'search web' as 'extraneous' — it was the user \
                      invoking the search-web action",
            expect: "'search web' kept (A's ending; B cut off at 'search for'), e.g. \
                     'How do we capture the logs correctly? Search web.'",
            whisper: "How do we capture the logs correctly search web?",
            realtime: Some("How do we capture the logs? Correctly search for"),
        },
    );
}

#[test]
#[ignore = "hits the live Groq API — see module docs for how to run"]
fn cleanup_prompt_13_pending_backlog_by_the_job() {
    run_case(
        "pending_backlog_by_the_job",
        &Case {
            failure: "B's disfluent 'or should we say' fragment displaced real content — \
                      'by the job' was dropped and the question mangled",
            expect: "'classified by the job' intact; keeping or dropping B's 'or should we \
                     say' aside is acceptable, but A's clause must survive",
            whisper: "How do we handle the current pending backlog since they were already classified by the job?",
            realtime: Some(
                "How do we handle The Current pending backlog Since they're already Uh... Or should we say classified by the job?",
            ),
        },
    );
}

// ---------------------------------------------------------------------------
// Deterministic guard tests — no API, always run. Each uses a REAL bad output
// from the recordings log and asserts the guard rejects it (and accepts the
// known-good outputs).
// ---------------------------------------------------------------------------

use super::features::cleanup_guard_violation;

#[test]
fn guard_rejects_hallucinated_ok() {
    let violation = cleanup_guard_violation(
        "I'm not sure I'm pretty sure we already running the latest code so double check your number one",
        Some("I'm not sure what to do. I'm pretty sure we are already running the latest code. So double check your Number one."),
        None,
        "I'm not sure what to do. I'm pretty sure we are already running the latest code. So double check your OK.",
    );
    assert!(violation.is_some(), "hallucinated 'OK' must be rejected");
}

#[test]
fn guard_rejects_dropped_by_the_job() {
    let violation = cleanup_guard_violation(
        "How do we handle the current pending backlog since they were already classified by the job?",
        Some("How do we handle The Current pending backlog Since they're already Uh... Or should we say classified by the job?"),
        None,
        "How do we handle the current pending backlog since they're already, or should we say \"classified\"?",
    );
    assert!(violation.is_some(), "dropping 'by the job' must be rejected");
}

#[test]
fn guard_rejects_dropped_in_its_button() {
    let violation = cleanup_guard_violation(
        "The down arrow I can in the beside the reject button is not centered in its button.",
        Some("Down arrow icon In the beside the Reject button It's not centered in its button."),
        None,
        "The down arrow icon beside the Reject button is not centered.",
    );
    assert!(violation.is_some(), "dropping 'in its button' must be rejected");
}

#[test]
fn guard_rejects_hallucinated_apology() {
    let violation = cleanup_guard_violation(
        "The icons in the menu, pipeline menu thing look pretty awful. I think we should move the buttons and icons out of this menu and somewhere else.",
        Some("The icons in the menu, pipeline menu thing Look pretty awful Um... I think we should move the buttons and icons out of this Menu And somewhere else"),
        None,
        "The icons in the menu, pipeline menu thing look pretty awful. Um... I think we should move the buttons and icons out of this menu and somewhere else. And I'm sorry.",
    );
    assert!(violation.is_some(), "hallucinated 'And I'm sorry.' must be rejected");
}

#[test]
fn guard_rejects_invented_retry_it() {
    let violation = cleanup_guard_violation(
        "Why are you talking about back of numbers? I'm not sure we should even try to retry a domain.",
        Some("Are you talking about back-off numbers? I'm not sure we should even try to I'll retry the main"),
        None,
        "Are you talking about back-off numbers? I'm not sure we should even try to retry it.",
    );
    assert!(violation.is_some(), "invented 'retry it' must be rejected");
}

#[test]
fn guard_rejects_concatenated_merge() {
    let violation = cleanup_guard_violation(
        "Also there's no way to select an organization when there's no connection like in this case.",
        Some("Also there's no way to select the navigation when there's no connection I like in this case."),
        None,
        "Also there's no way to select an organization when there's no connection like in this case. Also there's no way to select the navigation when there's no connection.",
    );
    assert!(violation.is_some(), "concatenated merge must be rejected");
}

#[test]
fn guard_accepts_good_merges() {
    // (whisper, realtime, known-good cleaned output) from the recordings log
    let good: &[(&str, &str, &str)] = &[
        (
            "Also there's no way to select an organization when there's no connection like in this case.",
            "Also there's no way to select the navigation when there's no connection I like in this case.",
            "Also, there's no way to select an organization when there's no connection, like in this case.",
        ),
        (
            "So he can't see the rendered file on guitar. Anyway.",
            "So he can't see the rendered file on GitHub. Anyway,",
            "So he can't see the rendered file on GitHub. Anyway.",
        ),
        (
            "Create some mock data in my local database so I can test this properly. You can do it on the account funnel hub spot.",
            "Create some mock data in my local database So I can test this properly. You can do it on the account funnel hubspot",
            "Create some mock data in my local database so I can test this properly. You can do it on the account funnel HubSpot.",
        ),
        (
            "The down arrow I can in the beside the reject button is not centered in its button.",
            "Down arrow icon In the beside the Reject button It's not centered in its button.",
            "The down arrow icon in the beside the Reject button is not centered in its button.",
        ),
        (
            "Also, the value isn't synced, it should be $1,000, but there's nothing now.",
            "Also the value isn't synced it should be a thousand dollars but But there's nothing now.",
            "Also, the value isn't synced, it should be $1,000, but there's nothing now.",
        ),
        (
            "The icons in the menu, pipeline menu thing look pretty awful. I think we should move the buttons and icons out of this menu and somewhere else.",
            "The icons in the menu, pipeline menu thing Look pretty awful Um... I think we should move the buttons and icons out of this Menu And somewhere else",
            "The icons in the menu, pipeline menu thing look pretty awful. I think we should move the buttons and icons out of this menu and somewhere else.",
        ),
    ];
    for (whisper, realtime, cleaned) in good {
        let violation = cleanup_guard_violation(whisper, Some(realtime), None, cleaned);
        assert!(
            violation.is_none(),
            "good output wrongly rejected ({}): {cleaned}",
            violation.unwrap()
        );
    }
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
