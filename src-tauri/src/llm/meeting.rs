//! Meeting-mode LLM features: rolling triage of a transcript window into item
//! ops, and the whole-meeting consolidation pass (summary, merges, rewrites).
//!
//! Contract: docs/meeting-mode-spec.md (Workstream A). The frontend windows the
//! transcript for triage, so neither feature truncates its input; consolidation
//! map-reduces on its own when a meeting is too long for one call.

use std::collections::{HashMap, HashSet};

use super::api_types::LlmUsage;
use super::providers::GenerationResult;
use super::types::*;
use super::LlmRouter;

/// Above this many transcript characters (~40k tokens) consolidation first
/// digests the transcript in chunks (map) and consolidates the digests (reduce).
const CONSOLIDATE_SINGLE_PASS_CHARS: usize = 150_000;
/// Chunk size for the map step.
const CONSOLIDATE_CHUNK_CHARS: usize = 60_000;

const CATEGORY_GUIDE: &str = r#"Categories (pick exactly one per item):
Actionable — work for a coding agent or the developer:
- bug: something is broken or behaves wrong compared to what was intended (crash, wrong value, visual glitch, regression). Behavior that someone explains is INTENDED is not a bug.
- task: a concrete change someone asked for or committed to ("we should add X", "can you make Y configurable", "I'll fix the docs").
- investigate: something to look into, measure or root-cause before anyone can act ("FPS drops in the cave, not sure why", "check if the save file grows").
- question: an open technical question that needs research or an answer, raised but not resolved in the meeting.
Non-actionable — worth keeping, not a task yet:
- feedback: an opinion or reaction about existing behavior or feel (UX, balance, pacing, "the jump feels floaty") that isn't clearly a defect.
- idea: a suggestion, wish or "it would be cool if" that nobody committed to.
- decision: something the participants agreed on or settled ("let's ship without multiplayer", "we keep the old save format").
- note: a noteworthy fact or piece of context worth remembering that fits no other category (a deadline, a constraint, who owns what)."#;

impl LlmRouter {
    /// Rolling triage pass over one transcript window.
    pub async fn meeting_triage_with_usage(
        &self,
        request: &MeetingTriageRequest,
    ) -> Result<GenerationResult<MeetingTriageResult>, String> {
        if request.transcript.trim().is_empty() {
            return Ok(GenerationResult {
                data: MeetingTriageResult::default(),
                usage: LlmUsage::default(),
            });
        }
        let prompt = Self::build_triage_prompt(request);
        let schema = Self::triage_schema(request);
        let mut result: GenerationResult<MeetingTriageResult> =
            self.run_feature(prompt, schema).await?;
        let raw = result.data.ops.len();
        result.data.ops = normalize_triage_ops(request, std::mem::take(&mut result.data.ops));
        log::info!(
            "[llm][meeting_triage] {} op(s) returned, {} kept after validation",
            raw,
            result.data.ops.len()
        );
        Ok(result)
    }

    pub(crate) fn build_triage_prompt(request: &MeetingTriageRequest) -> String {
        let context = request
            .context
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .unwrap_or("(none given)");

        let items = format_item_refs(&request.items);
        let journal = format_item_refs(&request.journal_items);

        let repo_section = match &request.repos {
            Some(repos) if !repos.is_empty() => {
                let list = repos
                    .iter()
                    .map(|r| {
                        let desc = r.description.trim();
                        if desc.is_empty() {
                            format!("- {} | {}", r.id, r.name)
                        } else {
                            format!("- {} | {} — {}", r.id, r.name, desc)
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                format!(
                    "\n\nREPOSITORIES (auto-repo mode): for every `new` op set repo_id to the id of the repository the item belongs to, or null when it is unclear or not about code.\n{}",
                    list
                )
            }
            _ => String::new(),
        };

        let repo_rule = if request.repos.as_ref().is_some_and(|r| !r.is_empty()) {
            "\n11. repo_id: only for `new` ops, only an id from REPOSITORIES, null when unsure."
        } else {
            ""
        };

        format!(
            r#"You triage a live meeting transcript for a software developer. A meeting is recorded in windows; you see one window at a time and turn what was said into structured items the developer reviews later (actionable items may become coding-agent sessions).

Meeting context: {context}

Transcript line format: `[HH:MM:SS speaker] text`. Speaker "me" is the developer who is recording; "them" (or "them:<label>") is any other participant. Lines come from speech-to-text, so expect misheard words — interpret the intent.

{categories}

{rubric}

EXISTING ITEMS in this meeting (id | category | title):
{items}

OPEN JOURNAL ITEMS from earlier meetings (id | category | title):
{journal}{repo_section}

Rules:
1. Ignore small talk: greetings, jokes, weather, sports, pets, food, audio/connection checks ("can you hear me"), scheduling the meeting itself, and anything off-topic. Filler and thinking out loud with no content is not an item.
2. Merge repeated mentions. If something in this window is the same thing as an EXISTING ITEM or OPEN JOURNAL ITEM, emit an `update` op with that exact id (journal ids keep their "j:" prefix) — never a second `new` op for it. If the same new thing is mentioned several times in this window (possibly by different speakers or in different words/languages), emit ONE `new` op quoting its clearest mention.
3. The window may begin with lines a previous pass already triaged. If a mention is already fully covered by an existing item, emit nothing for it; emit an `update` only when the mention adds new information or is a new sighting (said again later / by someone else).
4. `quote` must be VERBATIM: an exact contiguous span copied from ONE transcript line, without the `[HH:MM:SS speaker]` prefix. Do not paraphrase, translate, fix grammar or join lines. Keep it to the key sentence.
5. `t0` is the HH:MM:SS timestamp of the line the quote was copied from.
6. `new` ops: set `category`, `title` (short, specific, max ~10 words, English) and `detail` (1-3 sentences: what, where, how to reproduce or what was asked, who said it; English even when the speech was in another language). `id` is null.
7. `update` ops: set `id`; `detail` only with information not already in the item's title (else null); `category` and `title` null.
8. `complexity` (new ops): score the work it would take a coding agent to act on the item, using the rubric above (for non-actionable items, estimate the work if it were acted on). null for updates.
9. `confidence` (new ops): 0.0-1.0 — how sure you are this is a real, correctly categorized item worth keeping (clear explicit request ≈ 0.9, vague aside ≈ 0.4). null for updates.
10. Categorize by what was actually said. A complaint about feel is feedback, not a bug, unless something is clearly broken. An agreed plan is a decision; a proposal nobody agreed to is an idea.{repo_rule}
12. If the window contains nothing worth capturing, return {{"ops": []}}. Returning nothing is better than inventing items.

TRANSCRIPT WINDOW:
{transcript}{json}"#,
            context = context,
            categories = CATEGORY_GUIDE,
            rubric = Self::COMPLEXITY_RUBRIC,
            items = items,
            journal = journal,
            repo_section = repo_section,
            repo_rule = repo_rule,
            transcript = request.transcript.trim(),
            json = Self::json_only(
                r#"{"ops": [
  {"op": "new", "id": null, "category": "bug", "title": "HUD flickers when opening the map", "detail": "Both players saw the HUD flicker every time the map opens.", "quote": "the HUD flickers every time I open the map", "t0": "00:12:41", "complexity": 4, "confidence": 0.9, "repo_id": null},
  {"op": "update", "id": "itm_3", "category": null, "title": null, "detail": null, "quote": "yeah the jump still feels floaty", "t0": "00:14:02", "complexity": null, "confidence": null, "repo_id": null}
]}"#
            )
        )
    }

    pub(crate) fn triage_schema(request: &MeetingTriageRequest) -> serde_json::Value {
        let mut op_props = serde_json::json!({
            "op": { "type": "string", "enum": ["new", "update"], "description": "new item, or a sighting/update of an existing one" },
            "id": { "type": "string", "description": "update: the existing item id (journal ids keep the j: prefix); null for new" },
            "category": { "type": "string", "enum": MEETING_CATEGORIES, "description": "Required for new" },
            "title": { "type": "string", "description": "Required for new: short specific title" },
            "detail": { "type": "string", "description": "1-3 sentences of specifics" },
            "quote": { "type": "string", "description": "Verbatim span copied from one transcript line" },
            "t0": { "type": "string", "description": "HH:MM:SS of the quoted line" },
            "complexity": { "type": "integer", "minimum": 1, "maximum": 10, "description": "New items: 1-10 work estimate" },
            "confidence": { "type": "number", "minimum": 0, "maximum": 1, "description": "New items: 0-1" }
        });
        if let Some(repos) = request.repos.as_ref().filter(|r| !r.is_empty()) {
            let ids: Vec<&str> = repos.iter().map(|r| r.id.as_str()).collect();
            op_props["repo_id"] = serde_json::json!({
                "type": "string",
                "enum": ids,
                "description": "New items: repository id, null when unclear"
            });
        }
        serde_json::json!({
            "type": "object",
            "properties": {
                "ops": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": op_props,
                        "required": ["op", "quote", "t0"]
                    }
                }
            },
            "required": ["ops"]
        })
    }

    /// Final consolidation pass over a finished meeting.
    pub async fn meeting_consolidate_with_usage(
        &self,
        request: &MeetingConsolidateRequest,
    ) -> Result<GenerationResult<MeetingConsolidateResult>, String> {
        let mut usage = LlmUsage::default();

        // Map step for very long meetings: digest chunks, consolidate digests.
        let (material, is_digest) = if request.transcript.len() > CONSOLIDATE_SINGLE_PASS_CHARS {
            let chunks = chunk_lines(&request.transcript, CONSOLIDATE_CHUNK_CHARS);
            log::info!(
                "[llm][meeting_consolidate] transcript {} chars → map-reduce over {} chunk(s)",
                request.transcript.len(),
                chunks.len()
            );
            let mut digests = Vec::with_capacity(chunks.len());
            for (i, chunk) in chunks.iter().enumerate() {
                let prompt =
                    Self::build_digest_prompt(chunk, i + 1, chunks.len(), request.context.as_deref());
                let result: GenerationResult<MeetingChunkDigest> =
                    self.run_feature(prompt, Self::digest_schema()).await?;
                add_usage(&mut usage, &result.usage);
                digests.push(format!(
                    "### Part {}/{}\n{}",
                    i + 1,
                    chunks.len(),
                    result.data.digest.trim()
                ));
            }
            (digests.join("\n\n"), true)
        } else {
            (request.transcript.trim().to_string(), false)
        };

        let prompt = Self::build_consolidate_prompt(request, &material, is_digest);
        let mut result: GenerationResult<MeetingConsolidateResult> =
            self.run_feature(prompt, Self::consolidate_schema()).await?;
        add_usage(&mut result.usage, &usage);
        result.data = normalize_consolidation(request, std::mem::take(&mut result.data));
        Ok(result)
    }

    pub(crate) fn build_consolidate_prompt(
        request: &MeetingConsolidateRequest,
        material: &str,
        is_digest: bool,
    ) -> String {
        let context = request
            .context
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .unwrap_or("(none given)");
        let items = if request.items.is_empty() {
            "(none)".to_string()
        } else {
            request
                .items
                .iter()
                .map(|i| {
                    let detail = i.detail.trim();
                    format!(
                        "- {} | {} | sightings: {} | {}{}",
                        i.id,
                        i.category,
                        i.sightings.max(1),
                        i.title.trim(),
                        if detail.is_empty() {
                            String::new()
                        } else {
                            format!(" — {}", detail)
                        }
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        };
        let material_heading = if is_digest {
            "MEETING DIGEST (the transcript was too long for one pass; these are chronological digests of its parts):"
        } else {
            "FULL TRANSCRIPT (`[HH:MM:SS speaker] text`; \"me\" is the developer recording, \"them\" the other participants):"
        };

        format!(
            r#"You consolidate the notes of a finished meeting for a software developer. During the meeting, items were extracted window by window, so the list below contains duplicates, fragments and early guesses. With the whole meeting in view, clean it up and write a summary.

Meeting context: {context}

{categories}

ITEMS extracted during the meeting (id | category | sightings | title — detail):
{items}

{material_heading}
{material}

Produce:
1. `summary` — markdown, English, factual, no small talk. Use exactly these sections: `## Overview` (2-4 sentences: what the meeting was about and its outcome), `## Decisions` (bullets), `## Open questions` (bullets), `## Top items` (bullets: the most important actionable items by impact and sightings, each naming the item's title). Write "- None" under an empty section. Do not invent anything that was not said.
2. `merges` — groups of items that describe the SAME underlying thing (same bug, same request, repeated feedback). `keep_id` is the best-described or most-sighted item; `merge_ids` are the duplicates folded into it. Only merge true duplicates, never items that are merely related. Every id appears in at most one group.
3. `updates` — items whose title, detail or category should change now that the whole meeting is known: a clearer title, a detail that incorporates later clarification (repro steps, who raised it, how often), or a corrected category (e.g. "bug" that turned out to be intended → feedback; an idea that was agreed on → decision). For every merge, include an update for its `keep_id` whose detail combines the merged items. Each update carries the item's full new title, detail and category. Omit items that need no change.
Only reference ids from ITEMS. Never create new items here.{json}"#,
            context = context,
            categories = CATEGORY_GUIDE,
            items = items,
            material_heading = material_heading,
            material = material,
            json = Self::json_only(
                r###"{"summary": "## Overview\n...\n\n## Decisions\n- ...\n\n## Open questions\n- ...\n\n## Top items\n- ...", "merges": [{"keep_id": "itm_2", "merge_ids": ["itm_7"]}], "updates": [{"id": "itm_2", "title": "Jump feels floaty", "detail": "Raised three times by two players ...", "category": "feedback"}]}"###
            )
        )
    }

    pub(crate) fn consolidate_schema() -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "summary": { "type": "string", "description": "Markdown summary: Overview, Decisions, Open questions, Top items" },
                "merges": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "keep_id": { "type": "string" },
                            "merge_ids": { "type": "array", "items": { "type": "string" } }
                        },
                        "required": ["keep_id", "merge_ids"]
                    }
                },
                "updates": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": { "type": "string" },
                            "title": { "type": "string" },
                            "detail": { "type": "string" },
                            "category": { "type": "string", "enum": MEETING_CATEGORIES }
                        },
                        "required": ["id", "title", "detail", "category"]
                    }
                }
            },
            "required": ["summary", "merges", "updates"]
        })
    }

    fn build_digest_prompt(chunk: &str, part: usize, total: usize, context: Option<&str>) -> String {
        let context = context
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .unwrap_or("(none given)");
        format!(
            r#"This is part {part} of {total} of a long meeting transcript (`[HH:MM:SS speaker] text`; "me" is the developer recording, "them" the other participants). Meeting context: {context}

Write a dense, factual digest of this part for a later whole-meeting consolidation: the topics discussed; every bug, task, thing to investigate, open question, piece of feedback, idea and decision raised (with speaker and HH:MM:SS, and short verbatim key phrases in quotes); and anything that corrects or clarifies something said earlier. Skip small talk. English, markdown bullets.

TRANSCRIPT PART {part}/{total}:
{chunk}{json}"#,
            part = part,
            total = total,
            context = context,
            chunk = chunk.trim(),
            json = Self::json_only(r#"{"digest": "- ..."}"#)
        )
    }

    fn digest_schema() -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": { "digest": { "type": "string" } },
            "required": ["digest"]
        })
    }
}

fn add_usage(into: &mut LlmUsage, other: &LlmUsage) {
    into.input_tokens += other.input_tokens;
    into.output_tokens += other.output_tokens;
    into.total_tokens += other.total_tokens;
}

fn format_item_refs(items: &[MeetingItemRef]) -> String {
    if items.is_empty() {
        return "(none)".to_string();
    }
    items
        .iter()
        .map(|i| format!("- {} | {} | {}", i.id, i.category, i.title.trim()))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Split text into chunks of at most ~`max_chars`, cutting only at line
/// boundaries (a single over-long line becomes its own chunk).
pub(crate) fn chunk_lines(text: &str, max_chars: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    for line in text.lines() {
        if !current.is_empty() && current.len() + line.len() + 1 > max_chars {
            chunks.push(std::mem::take(&mut current));
        }
        if !current.is_empty() {
            current.push('\n');
        }
        current.push_str(line);
    }
    if !current.trim().is_empty() {
        chunks.push(current);
    }
    chunks
}

// ---------------------------------------------------------------------------
// Validation / normalization of model output (never trust the model's shape)
// ---------------------------------------------------------------------------

/// Parse seconds from `HH:MM:SS`, `H:MM:SS`, `MM:SS` or a plain number of
/// seconds (fractions allowed).
pub(crate) fn parse_timestamp(s: &str) -> Option<f64> {
    let s = s.trim().trim_start_matches('[').trim_end_matches(']').trim();
    if s.is_empty() {
        return None;
    }
    let parts: Vec<&str> = s.split(':').collect();
    let nums: Option<Vec<f64>> = parts.iter().map(|p| p.trim().parse::<f64>().ok()).collect();
    let nums = nums?;
    if nums.iter().any(|n| !n.is_finite() || *n < 0.0) {
        return None;
    }
    match nums.as_slice() {
        [secs] => Some(*secs),
        [m, s] => Some(m * 60.0 + s),
        [h, m, s] => Some(h * 3600.0 + m * 60.0 + s),
        _ => None,
    }
}

pub(crate) fn format_timestamp(secs: f64) -> String {
    let total = secs.max(0.0).floor() as u64;
    format!("{:02}:{:02}:{:02}", total / 3600, (total / 60) % 60, total % 60)
}

/// `(seconds, text)` for every `[HH:MM:SS speaker] text` line.
fn transcript_lines(transcript: &str) -> Vec<(f64, String)> {
    transcript
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let rest = line.strip_prefix('[')?;
            let close = rest.find(']')?;
            let header = &rest[..close];
            let ts = header.split_whitespace().next()?;
            let secs = parse_timestamp(ts)?;
            Some((secs, rest[close + 1..].trim().to_string()))
        })
        .collect()
}

fn normalize_for_match(s: &str) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
        .trim_matches(|c: char| c.is_ascii_punctuation() || c.is_whitespace())
        .to_string()
}

/// Resolve the op's timestamp: prefer the transcript line that actually
/// contains the quote (closest to the model's claimed time), else the model's
/// time normalized to `HH:MM:SS`, else the window's first line.
fn resolve_t0(lines: &[(f64, String)], quote: &str, claimed: &str) -> String {
    let claimed_secs = parse_timestamp(claimed);
    let needle = normalize_for_match(quote);
    if !needle.is_empty() {
        let best = lines
            .iter()
            .filter(|(_, text)| normalize_for_match(text).contains(&needle))
            .min_by(|a, b| {
                let target = claimed_secs.unwrap_or(0.0);
                (a.0 - target)
                    .abs()
                    .partial_cmp(&(b.0 - target).abs())
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
        if let Some((secs, _)) = best {
            return format_timestamp(*secs);
        }
    }
    if let Some(secs) = claimed_secs {
        return format_timestamp(secs);
    }
    lines
        .first()
        .map(|(secs, _)| format_timestamp(*secs))
        .unwrap_or_else(|| "00:00:00".to_string())
}

fn non_empty(s: Option<String>) -> Option<String> {
    s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn normalize_category(c: Option<&str>) -> Option<String> {
    let c = c?.trim().to_lowercase();
    MEETING_CATEGORIES.contains(&c.as_str()).then_some(c)
}

/// Validate triage ops against the request: known categories, known update
/// ids (unknown-id updates with a usable category+title become `new`),
/// clamped scores, repo ids only in auto-repo mode, timestamps re-derived from
/// the transcript, and no duplicate `new` ops (same title) in one response.
pub(crate) fn normalize_triage_ops(
    request: &MeetingTriageRequest,
    ops: Vec<TriageOp>,
) -> Vec<TriageOp> {
    let lines = transcript_lines(&request.transcript);
    let mut known: HashSet<&str> = request.items.iter().map(|i| i.id.as_str()).collect();
    known.extend(request.journal_items.iter().map(|i| i.id.as_str()));
    let repo_ids: Option<HashSet<&str>> = request
        .repos
        .as_ref()
        .map(|r| r.iter().map(|x| x.id.as_str()).collect());

    let mut seen_new_titles: HashSet<String> = HashSet::new();
    let mut out = Vec::new();

    for op in ops {
        let kind = op.op.trim().to_lowercase();
        let quote = op.quote.trim().to_string();
        let t0 = resolve_t0(&lines, &quote, &op.t0);
        let detail = non_empty(op.detail);

        let as_update_id = op.id.as_deref().map(str::trim).and_then(|id| {
            if known.contains(id) {
                Some(id.to_string())
            } else if !id.starts_with("j:") && known.contains(format!("j:{}", id).as_str()) {
                // Model dropped the journal prefix.
                Some(format!("j:{}", id))
            } else {
                None
            }
        });

        let category = normalize_category(op.category.as_deref());
        let title = non_empty(op.title);

        if kind == "update" {
            if let Some(id) = as_update_id {
                out.push(TriageOp {
                    op: "update".into(),
                    id: Some(id),
                    category: None,
                    title: None,
                    detail,
                    quote,
                    t0,
                    complexity: None,
                    confidence: None,
                    repo_id: None,
                });
                continue;
            }
            // Unknown id: salvage as a new item when it is self-describing.
            if category.is_none() || title.is_none() {
                log::warn!(
                    "[llm][meeting_triage] dropping update for unknown id {:?}",
                    op.id
                );
                continue;
            }
        } else if kind != "new" {
            log::warn!("[llm][meeting_triage] dropping op with unknown kind '{}'", op.op);
            continue;
        }

        let (Some(category), Some(title)) = (category, title) else {
            log::warn!("[llm][meeting_triage] dropping new op without a valid category/title");
            continue;
        };
        if quote.is_empty() {
            log::warn!("[llm][meeting_triage] dropping new op '{}' without a quote", title);
            continue;
        }
        if !seen_new_titles.insert(normalize_for_match(&title)) {
            continue;
        }
        let repo_id = match (&repo_ids, non_empty(op.repo_id)) {
            (Some(ids), Some(id)) if ids.contains(id.as_str()) => Some(id),
            _ => None,
        };
        out.push(TriageOp {
            op: "new".into(),
            id: None,
            category: Some(category),
            title: Some(title),
            detail,
            quote,
            t0,
            complexity: op.complexity.map(|c| c.clamp(1, 10)),
            confidence: op.confidence.map(|c| c.clamp(0.0, 1.0)),
            repo_id,
        });
    }
    out
}

/// Validate consolidation output: merges only between known, distinct ids
/// (each id used once), updates only for known surviving ids with a valid
/// category (falls back to the item's current one) and non-empty title.
pub(crate) fn normalize_consolidation(
    request: &MeetingConsolidateRequest,
    result: MeetingConsolidateResult,
) -> MeetingConsolidateResult {
    let by_id: HashMap<&str, &MeetingConsolidateItem> =
        request.items.iter().map(|i| (i.id.as_str(), i)).collect();

    let mut used: HashSet<String> = HashSet::new();
    let mut merges = Vec::new();
    for merge in result.merges {
        let keep = merge.keep_id.trim().to_string();
        if !by_id.contains_key(keep.as_str()) || used.contains(&keep) {
            continue;
        }
        let merge_ids: Vec<String> = merge
            .merge_ids
            .into_iter()
            .map(|id| id.trim().to_string())
            .filter(|id| id != &keep && by_id.contains_key(id.as_str()) && !used.contains(id))
            .collect::<Vec<_>>();
        let mut unique = Vec::new();
        for id in merge_ids {
            if !unique.contains(&id) {
                unique.push(id);
            }
        }
        if unique.is_empty() {
            continue;
        }
        used.insert(keep.clone());
        used.extend(unique.iter().cloned());
        merges.push(MeetingMerge {
            keep_id: keep,
            merge_ids: unique,
        });
    }
    let merged_away: HashSet<&str> = merges
        .iter()
        .flat_map(|m| m.merge_ids.iter().map(String::as_str))
        .collect();

    let mut updated: HashSet<String> = HashSet::new();
    let mut updates = Vec::new();
    for update in result.updates {
        let id = update.id.trim().to_string();
        let Some(item) = by_id.get(id.as_str()) else {
            continue;
        };
        if merged_away.contains(id.as_str()) || !updated.insert(id.clone()) {
            continue;
        }
        let title = update.title.trim();
        let title = if title.is_empty() { item.title.trim() } else { title };
        if title.is_empty() {
            continue;
        }
        let category = normalize_category(Some(&update.category))
            .or_else(|| normalize_category(Some(&item.category)))
            .unwrap_or_else(|| "note".to_string());
        let detail = update.detail.trim();
        updates.push(MeetingItemUpdate {
            id,
            title: title.to_string(),
            detail: if detail.is_empty() {
                item.detail.clone()
            } else {
                detail.to_string()
            },
            category,
        });
    }

    MeetingConsolidateResult {
        summary: result.summary.trim().to_string(),
        merges,
        updates,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, category: &str, title: &str) -> MeetingItemRef {
        MeetingItemRef {
            id: id.into(),
            category: category.into(),
            title: title.into(),
        }
    }

    fn op(kind: &str) -> TriageOp {
        TriageOp {
            op: kind.into(),
            id: None,
            category: None,
            title: None,
            detail: None,
            quote: String::new(),
            t0: String::new(),
            complexity: None,
            confidence: None,
            repo_id: None,
        }
    }

    fn request() -> MeetingTriageRequest {
        MeetingTriageRequest {
            transcript: "[00:12:40 them] the HUD flickers every time I open the map\n[00:12:55 me] okay noted\n[00:14:02 them:A] yeah the jump still feels floaty".into(),
            items: vec![item("itm_1", "feedback", "Jump feels floaty")],
            journal_items: vec![item("j:abc", "idea", "Add photo mode")],
            repos: None,
            context: Some("Playtest".into()),
        }
    }

    #[test]
    fn timestamps_parse_and_format() {
        assert_eq!(parse_timestamp("00:12:41"), Some(761.0));
        assert_eq!(parse_timestamp("12:41"), Some(761.0));
        assert_eq!(parse_timestamp("761.5"), Some(761.5));
        assert_eq!(parse_timestamp("[1:02:03]"), Some(3723.0));
        assert_eq!(parse_timestamp("soon"), None);
        assert_eq!(format_timestamp(3723.9), "01:02:03");
    }

    #[test]
    fn new_op_is_validated_and_timestamp_taken_from_the_quoted_line() {
        let mut new = op("new");
        new.category = Some("Bug".into());
        new.title = Some("HUD flickers on map open".into());
        new.quote = "HUD flickers every time I open the map".into();
        new.t0 = "12:00".into(); // wrong claim; the quote pins it
        new.complexity = Some(12);
        new.confidence = Some(1.7);
        new.repo_id = Some("repo-x".into()); // not auto-repo → dropped
        let ops = normalize_triage_ops(&request(), vec![new]);
        assert_eq!(ops.len(), 1);
        let o = &ops[0];
        assert_eq!(o.category.as_deref(), Some("bug"));
        assert_eq!(o.t0, "00:12:40");
        assert_eq!(o.complexity, Some(10));
        assert_eq!(o.confidence, Some(1.0));
        assert_eq!(o.repo_id, None);
        assert_eq!(o.id, None);
    }

    #[test]
    fn updates_need_known_ids_and_journal_prefix_is_repaired() {
        let mut known = op("update");
        known.id = Some("itm_1".into());
        known.quote = "the jump still feels floaty".into();
        known.category = Some("bug".into()); // stripped on updates
        let mut journal = op("update");
        journal.id = Some("abc".into());
        journal.quote = "okay noted".into();
        let mut unknown = op("update");
        unknown.id = Some("itm_99".into());
        unknown.quote = "okay noted".into();
        let ops = normalize_triage_ops(&request(), vec![known, journal, unknown]);
        assert_eq!(ops.len(), 2);
        assert_eq!(ops[0].id.as_deref(), Some("itm_1"));
        assert_eq!(ops[0].category, None);
        assert_eq!(ops[0].t0, "00:14:02");
        assert_eq!(ops[1].id.as_deref(), Some("j:abc"));
    }

    #[test]
    fn invalid_and_duplicate_new_ops_are_dropped() {
        let mut bad_cat = op("new");
        bad_cat.category = Some("smalltalk".into());
        bad_cat.title = Some("Football".into());
        bad_cat.quote = "okay noted".into();
        let mut a = op("new");
        a.category = Some("task".into());
        a.title = Some("Make map configurable".into());
        a.quote = "okay noted".into();
        let mut dup = a.clone();
        dup.title = Some("make map configurable.".into());
        let mut ignored = op("ignore_span");
        ignored.quote = "x".into();
        let ops = normalize_triage_ops(&request(), vec![bad_cat, a, dup, ignored]);
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].title.as_deref(), Some("Make map configurable"));
    }

    #[test]
    fn auto_repo_keeps_only_known_repo_ids() {
        let mut req = request();
        req.repos = Some(vec![MeetingRepoRef {
            id: "game".into(),
            name: "Game".into(),
            description: String::new(),
        }]);
        let mut good = op("new");
        good.category = Some("bug".into());
        good.title = Some("HUD flicker".into());
        good.quote = "the HUD flickers".into();
        good.repo_id = Some("game".into());
        let mut bad = good.clone();
        bad.title = Some("Other".into());
        bad.repo_id = Some("nope".into());
        let ops = normalize_triage_ops(&req, vec![good, bad]);
        assert_eq!(ops[0].repo_id.as_deref(), Some("game"));
        assert_eq!(ops[1].repo_id, None);
        let schema = LlmRouter::triage_schema(&req);
        assert_eq!(
            schema["properties"]["ops"]["items"]["properties"]["repo_id"]["enum"],
            serde_json::json!(["game"])
        );
        assert!(LlmRouter::triage_schema(&request())["properties"]["ops"]["items"]["properties"]
            .get("repo_id")
            .is_none());
    }

    #[test]
    fn lenient_triage_op_deserialization() {
        let v: MeetingTriageResult = serde_json::from_str(
            r#"{"ops":[{"op":"new","category":"bug","title":"t","quote":"q","t0":761,"complexity":"7","confidence":"0.8"}]}"#,
        )
        .unwrap();
        assert_eq!(v.ops[0].t0, "761");
        assert_eq!(v.ops[0].complexity, Some(7));
        assert_eq!(v.ops[0].confidence, Some(0.8));
        assert_eq!(v.ops[0].id, None);
    }

    fn citem(id: &str, category: &str, title: &str) -> MeetingConsolidateItem {
        MeetingConsolidateItem {
            id: id.into(),
            category: category.into(),
            title: title.into(),
            detail: format!("{} detail", title),
            sightings: 1,
        }
    }

    #[test]
    fn consolidation_merges_and_updates_are_validated() {
        let req = MeetingConsolidateRequest {
            transcript: String::new(),
            items: vec![
                citem("a", "feedback", "Jump floaty"),
                citem("b", "feedback", "Jumping feels floaty"),
                citem("c", "bug", "HUD flicker"),
            ],
            context: None,
        };
        let result = MeetingConsolidateResult {
            summary: "  ## Overview\nx  ".into(),
            merges: vec![
                MeetingMerge { keep_id: "a".into(), merge_ids: vec!["b".into(), "a".into(), "zz".into(), "b".into()] },
                MeetingMerge { keep_id: "b".into(), merge_ids: vec!["c".into()] }, // b already used
                MeetingMerge { keep_id: "c".into(), merge_ids: vec![] },
            ],
            updates: vec![
                MeetingItemUpdate { id: "a".into(), title: "Jump feels floaty".into(), detail: "".into(), category: "weird".into() },
                MeetingItemUpdate { id: "b".into(), title: "x".into(), detail: "y".into(), category: "bug".into() }, // merged away
                MeetingItemUpdate { id: "zz".into(), title: "x".into(), detail: "y".into(), category: "bug".into() },
                MeetingItemUpdate { id: "c".into(), title: "".into(), detail: "Flickers on map".into(), category: "BUG".into() },
            ],
        };
        let out = normalize_consolidation(&req, result);
        assert_eq!(out.summary, "## Overview\nx");
        assert_eq!(out.merges, vec![MeetingMerge { keep_id: "a".into(), merge_ids: vec!["b".into()] }]);
        assert_eq!(out.updates.len(), 2);
        assert_eq!(out.updates[0].category, "feedback"); // invalid → item's own
        assert_eq!(out.updates[0].detail, "Jump floaty detail"); // empty → kept
        assert_eq!(out.updates[1].title, "HUD flicker");
        assert_eq!(out.updates[1].category, "bug");
    }

    #[test]
    fn chunking_respects_line_boundaries() {
        let text = "aaaa\nbbbb\ncccc\ndddd";
        assert_eq!(chunk_lines(text, 10), vec!["aaaa\nbbbb", "cccc\ndddd"]);
        assert_eq!(chunk_lines(text, 1000), vec![text]);
        assert_eq!(chunk_lines("", 10), Vec::<String>::new());
    }

    #[test]
    fn prompts_carry_inputs_verbatim_without_truncation() {
        let mut req = request();
        req.transcript = format!("[00:00:01 me] {}", "word ".repeat(5000));
        let prompt = LlmRouter::build_triage_prompt(&req);
        assert!(prompt.contains(req.transcript.trim()));
        assert!(prompt.contains("itm_1 | feedback | Jump feels floaty"));
        assert!(prompt.contains("j:abc | idea | Add photo mode"));
        assert!(prompt.contains("Meeting context: Playtest"));
        assert!(!prompt.contains("REPOSITORIES"));
    }
}
