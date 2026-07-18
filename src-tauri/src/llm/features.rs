//! LLM feature methods (session naming, transcription cleanup, model recommendations, etc.)

use serde::de::DeserializeOwned;

use super::api_types::LlmUsage;
use super::providers::GenerationResult;
use super::types::*;
use super::utils::truncate_text;
use super::LlmClient;

/// The single JSON-output instruction shared by every feature prompt.
const JSON_ONLY_INSTRUCTION: &str = "Respond with ONLY a JSON object in this exact format:";

impl LlmClient {
    /// Build the shared "respond with only a JSON object" prompt trailer for a
    /// given `example` instance. The example is kept next to its feature's schema
    /// so the two stay in sync.
    fn json_only(example: &str) -> String {
        format!("\n\n{}\n{}", JSON_ONLY_INSTRUCTION, example)
    }

    /// One generic entry point for every feature: run a structured generation
    /// with its schema and return the typed result plus usage.
    async fn run_feature<T: DeserializeOwned>(
        &self,
        prompt: String,
        schema: serde_json::Value,
    ) -> Result<GenerationResult<T>, String> {
        self.generate_structured_with_usage(&prompt, Some(schema))
            .await
    }

    /// Generate a session name from the user's prompt (called immediately when prompt is sent).
    pub async fn generate_session_name_with_usage(
        &self,
        user_prompt: &str,
    ) -> Result<GenerationResult<SessionNameResult>, String> {
        let prompt = format!(
            r#"Generate a concise name for this coding session based on the user's request.

IMPORTANT: The prompt may contain operational/tool instructions like "read card", "scan codebase", "set the card status", "using the notion skill". Strip these away and focus on the ACTUAL task:
- If the prompt wraps a specific card/task title (e.g. "read card: Fix login bug. set status... then implement"), name it after the task: "Fix Login Bug"
- If the prompt is a batch operation (e.g. "classify all unclassified cards..." or "triage cards in New status..."), name it after the operation: "Classify Backlog Cards" or "Triage New Cards"

User's request:
{}{}"#,
            truncate_text(user_prompt, 500),
            Self::json_only(
                r#"{"name": "3-6 word concise name describing the task", "category": "feature|bugfix|refactor|research|question|other"}"#
            )
        );

        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "A concise session name (3-6 words, no special characters)"
                },
                "category": {
                    "type": "string",
                    "enum": ["feature", "bugfix", "refactor", "research", "question", "plan", "other"],
                    "description": "The type of task"
                }
            },
            "required": ["name", "category"]
        });

        self.run_feature(prompt, schema).await
    }

    /// Generate session outcome with usage tracking
    pub async fn generate_session_outcome_with_usage(
        &self,
        user_prompt: &str,
        assistant_messages: &str,
    ) -> Result<GenerationResult<SessionOutcomeResult>, String> {
        let prompt = format!(
            r#"Analyze this completed coding session and extract the KEY RESULT.

IMPORTANT: Include the actual answer/value, not a description of what was provided.
IMPORTANT: Ignore operational/tool instructions in the prompt — things like "read card", "scan codebase", "set the card status", "using the notion skill". Focus on the actual task or feature.

Examples of BAD outcomes (too vague, clickbait-style):
- "Provided the movement speed values" ❌
- "Explained the authentication flow" ❌
- "Found the issue" ❌

Examples of GOOD outcomes (specific, informative):
- "Player speed: 5.0, Enemy speed: 3.5" ✓
- "Use JWT tokens with 24h expiry" ✓
- "Missing null check in getUserById()" ✓
- "Added dark mode toggle to settings" ✓
- "File not found - path was incorrect" ✓

The outcome should be:
- If the user asked a question: THE ACTUAL ANSWER with specific values/names
- If it was an implementation task: What was specifically done
- If there was an error: The specific error or blocker

Keep it to a SINGLE sentence (roughly 5-15 words) but INCLUDE THE ACTUAL INFORMATION. Never exceed one sentence.

User's original request:
{}

Assistant's work (truncated):
{}{}"#,
            truncate_text(user_prompt, 500),
            truncate_text(assistant_messages, 2000),
            Self::json_only(r#"{"outcome": "the specific result or answer"}"#)
        );

        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "outcome": {
                    "type": "string",
                    "description": "A single-sentence outcome describing what was accomplished or the answer (roughly 3-15 words, one sentence max)"
                }
            },
            "required": ["outcome"]
        });

        self.run_feature(prompt, schema).await
    }

    /// Analyze interaction needed with usage tracking
    pub async fn analyze_interaction_needed_with_usage(
        &self,
        last_message: &str,
    ) -> Result<GenerationResult<InteractionAnalysis>, String> {
        let prompt = format!(
            r#"Analyze this AI assistant's message to determine if it TRULY requires human interaction to proceed.

IMPORTANT: Only flag as needs_interaction=true if the assistant CANNOT proceed without user input.

DO NOT flag as needing interaction:
- Polite offers to help further (e.g., "Would you like me to...", "Let me know if you need...")
- Conversational questions that don't block progress (e.g., "Would you like help with X?")
- Suggestions or recommendations the user can ignore
- "Is there anything else?" type questions
- Offers to implement additional features
- Questions about whether the user wants more examples or explanations

DO flag as needing interaction:
- Explicit requests for required information (e.g., "What is your API key?", "Which database should I use?")
- Errors that require user decision to resolve
- Multiple critical options where the assistant cannot reasonably choose
- Requests for approval before destructive operations (e.g., deleting files, force pushing)
- Missing required configuration or credentials
- Ambiguous requirements where proceeding would be risky

Message to analyze:
{}{}"#,
            truncate_text(last_message, 2000),
            Self::json_only(
                r#"{"needs_interaction": true/false, "reason": "why or null", "urgency": "low|medium|high", "waiting_for": "approval|clarification|input|review|decision|null"}"#
            )
        );

        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "needs_interaction": {
                    "type": "boolean",
                    "description": "Whether the message requires human input to proceed"
                },
                "reason": {
                    "type": "string",
                    "description": "Why interaction is needed (null if not needed)"
                },
                "urgency": {
                    "type": "string",
                    "enum": ["low", "medium", "high"],
                    "description": "How urgently the interaction is needed"
                },
                "waiting_for": {
                    "type": "string",
                    "enum": ["approval", "clarification", "input", "review", "decision"],
                    "description": "What type of interaction is needed (null if not needed)"
                }
            },
            "required": ["needs_interaction", "urgency"]
        });

        self.run_feature(prompt, schema).await
    }

    /// Clean transcription with usage tracking
    pub async fn clean_transcription_with_usage(
        &self,
        whisper_transcription: &str,
        realtime_transcription: Option<&str>,
        repo_context: Option<&str>,
    ) -> Result<GenerationResult<TranscriptionCleanupResult>, String> {
        let context_section = if let Some(context) = repo_context {
            format!(
                r#"6. Project-specific terms. The speaker's known projects and vocabulary are listed below. If a word or phrase in the transcription is phonetically close to one of these known terms, the speaker almost certainly said the known term — replace it, using the exact casing shown (e.g. "cloud whisperer" -> "OpenWhisperer", "torii" -> "Tauri", "sopranos" -> "Sonnet"). Only substitute on sound-alike matches; never insert terms that were not plausibly spoken.

{}

"#,
                context
            )
        } else {
            String::new()
        };

        let transcription_section = if let Some(realtime) = realtime_transcription {
            format!(
                r#"You have two transcriptions of the SAME audio from different speech-to-text engines. They are two readings of the same spoken words — not two separate utterances, and never two pieces to join together.

**Transcription A** (batch engine — usually the more accurate reading):
{}

**Transcription B** (realtime engine — often fragmentary, but may catch words A missed):
{}

Produce ONE merged transcript. Use Transcription A as the base, and use B only to recover words that A clearly missed or misheard.

Where the two disagree at the same position (e.g. A has "select an organization" where B has "select the navigation"), that is one utterance misheard by one engine — choose the more plausible reading and discard the other. NEVER keep both variants, and NEVER append one transcription after the other. The merged result must be roughly the length of the longer transcription, never the two combined.

A word both engines agree on is real speech — keep it, even if it seems redundant or odd (it may be a proper noun, a product name, or jargon you don't recognize). If B ends with words that A lacks entirely — a continuation of the speech, not a variant reading of A's ending — keep them; engines truncate endings more often than they hallucinate extra words."#,
                whisper_transcription,
                realtime
            )
        } else {
            format!("Transcription to clean:\n{}", whisper_transcription)
        };

        // The preservation rule differs by mode: in dual-source mode, merging the two
        // readings IS the task, so a blanket "never merge" would instruct the model
        // to concatenate both variants of every disagreement.
        let preserve_section = if realtime_transcription.is_some() {
            r#"CRITICAL: Preserve ALL of the speaker's content. Keep every spoken clause and sentence — including trailing questions, asides, and apparent self-corrections (e.g. "..., or does it show here?"). Never drop, shorten, or summarize what was said. But remember: the two transcriptions are readings of the same speech, so each spoken clause must appear exactly ONCE in the output — in one engine's reading, never both."#
        } else {
            r#"CRITICAL: Preserve ALL of the speaker's content. Keep every clause and sentence — including trailing questions, asides, and apparent self-corrections (e.g. "..., or does it show here?"). Never drop, shorten, summarize, or merge parts of what was said. The cleaned text must carry the same information as the input, only with errors fixed. When in doubt, leave the wording as-is."#
        };

        let prompt = format!(
            r#"Clean up this voice transcription for a software development task. Fix:

1. Common homophones (there/their/they're, your/you're, its/it's, etc.)
2. Technical terms that may have been misheard (e.g., "react" vs "re-act", "typescript" vs "type script")
3. Missing or incorrect punctuation
4. Code-related terms (function names, file extensions, programming concepts)
5. Common speech-to-text errors
{}
Keep the original meaning and intent. Only fix clear errors, don't rewrite the content.

{}

{}{}"#,
            context_section,
            preserve_section,
            transcription_section,
            Self::json_only(
                r#"{"cleaned_text": "the corrected text", "corrections_made": ["correction 1", "correction 2"]}"#
            )
        );

        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "cleaned_text": {
                    "type": "string",
                    "description": "The corrected transcription with proper punctuation and fixed errors"
                },
                "corrections_made": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "List of corrections made"
                }
            },
            "required": ["cleaned_text", "corrections_made"]
        });

        let mut result: GenerationResult<TranscriptionCleanupResult> =
            self.run_feature(prompt, schema).await?;

        // Guard against runaway merges: cleaned text substantially longer than the
        // longest input means the model concatenated both readings (or invented
        // content) instead of merging — fall back to the raw batch transcript
        // rather than ship a corrupted prompt.
        let word_count = |s: &str| s.split_whitespace().count();
        let baseline = word_count(whisper_transcription).max(
            realtime_transcription.map(word_count).unwrap_or(0),
        );
        let cleaned_len = word_count(&result.data.cleaned_text);
        if baseline > 0 && cleaned_len > baseline * 13 / 10 + 2 {
            log::warn!(
                "[llm] transcription cleanup output ({} words) far exceeds the longest input ({} words); discarding it and falling back to the raw transcript",
                cleaned_len,
                baseline
            );
            result.data = TranscriptionCleanupResult {
                cleaned_text: whisper_transcription.to_string(),
                corrections_made: Vec::new(),
            };
        }

        Ok(result)
    }

    /// Recommend model with usage tracking
    pub async fn recommend_model_with_usage(
        &self,
        prompt: &str,
        enabled_models: &[String],
    ) -> Result<GenerationResult<ModelRecommendation>, String> {
        // Map model IDs to simple names for filtering
        let model_id_to_name = |id: &str| -> Option<&str> {
            if id.starts_with("claude-haiku") {
                Some("haiku")
            } else if id.starts_with("claude-sonnet") {
                Some("sonnet")
            } else if id.starts_with("claude-opus") {
                Some("opus")
            } else {
                None
            }
        };

        // Determine which models are enabled
        let mut available_models = Vec::new();
        for model in ["haiku", "sonnet", "opus"] {
            if enabled_models
                .iter()
                .any(|id| model_id_to_name(id) == Some(model))
            {
                available_models.push(model);
            }
        }

        // If no models are enabled, return an error
        if available_models.is_empty() {
            return Err("No enabled models available for recommendation".to_string());
        }

        // Build the prompt with only enabled models
        let model_list = available_models.join("|");
        let prompt_text = format!(
            r#"Analyze this software development prompt and recommend the best model.

Model capabilities:
- **Haiku**: Fast, cheap. Best for simple questions, quick lookups, straightforward code edits, syntax questions, documentation searches.
- **Sonnet**: Balanced. Good for typical coding tasks, debugging, feature implementation, code review, refactoring.
- **Opus**: Most capable, expensive. Best for complex architecture, multi-file refactoring, difficult debugging, system design, novel problem-solving.

Effort level (controls reasoning depth, tool use, and verbosity):
- **null**: No effort preference (fastest, cheapest)
- **low**: Minimal reasoning for simple tasks
- **medium**: Balanced reasoning for typical tasks
- **high**: Thorough reasoning for complex tasks
- **xhigh**: Extra-high reasoning for very complex tasks (Sonnet and Opus)
- **max**: Deepest reasoning for the most complex tasks (Opus only)

Available models (only recommend from these): {}

Prompt to analyze:
{}

Choose the most cost-effective model that can handle this task well. Prefer cheaper models when the task is simple.{}"#,
            available_models
                .iter()
                .map(|m| format!("**{}**", m))
                .collect::<Vec<_>>()
                .join(", "),
            truncate_text(prompt, 1500),
            Self::json_only(&format!(
                r#"{{"recommended_model": "{}", "reasoning": "brief explanation", "confidence": "low|medium|high", "suggested_effort": "null|low|medium|high|xhigh|max"}}"#,
                model_list
            ))
        );

        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "recommended_model": {
                    "type": "string",
                    "enum": available_models,
                    "description": "The recommended model"
                },
                "reasoning": {
                    "type": "string",
                    "description": "Brief explanation of why this model was chosen"
                },
                "confidence": {
                    "type": "string",
                    "enum": ["low", "medium", "high"],
                    "description": "Confidence level in this recommendation"
                },
                "suggested_effort": {
                    "type": "string",
                    "enum": ["null", "low", "medium", "high", "xhigh", "max"],
                    "description": "Suggested effort level: null (off), low, medium, high, xhigh, or max"
                }
            },
            "required": ["recommended_model", "reasoning", "confidence", "suggested_effort"]
        });

        self.run_feature(prompt_text, schema).await
    }

    /// Recommend repo with usage tracking
    pub async fn recommend_repo_with_usage(
        &self,
        prompt: &str,
        repos: &[(
            String,
            String,
            Option<String>,
            Option<Vec<String>>,
            Option<Vec<String>>,
        )],
        is_transcribed: bool,
    ) -> Result<GenerationResult<RepoRecommendation>, String> {
        if repos.is_empty() {
            return Ok(GenerationResult {
                data: RepoRecommendation {
                    recommended_index: -1,
                    recommended_name: String::new(),
                    confidence: "low".to_string(),
                    reasoning: "No repositories configured".to_string(),
                },
                usage: LlmUsage::default(),
            });
        }

        let repos_list = repos
            .iter()
            .enumerate()
            .map(|(i, (name, path, desc, keywords, vocabulary))| {
                let desc_text = desc.as_deref().unwrap_or("No description");
                let keywords_text = keywords
                    .as_ref()
                    .map(|kw| kw.join(", "))
                    .unwrap_or_else(|| "None".to_string());
                let vocab_text = vocabulary
                    .as_ref()
                    .map(|v| v.join(", "))
                    .unwrap_or_else(|| "None".to_string());
                format!(
                    "{}. {} ({})\n   Description: {}\n   Keywords: {}\n   Vocabulary: {}",
                    i, name, path, desc_text, keywords_text, vocab_text
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n");

        let transcription_notice = if is_transcribed {
            "\n\nNOTE: The user's prompt was recorded via voice and transcribed using speech-to-text. \
             There may be minor transcription errors such as homophones, missing punctuation, or misheard words. \
             Pay special attention to the Vocabulary field - if the prompt contains words that sound like items in a repo's vocabulary, that's a strong match signal.\n"
        } else {
            ""
        };

        let prompt_text = format!(
            r#"Based on the user's prompt, recommend which repository they should work in.

Available repositories:
{}
{transcription_notice}
User's prompt:
{}

Analyze the prompt and determine which repository best matches. Consider:
- **Keywords**: Categorical terms that match the user's intent (e.g., "authentication", "frontend")
- **Vocabulary**: Project-specific lingo - if the prompt mentions terms from a repo's vocabulary, it's likely the right repo
- Project names or terminology mentioned
- Technologies or frameworks referenced
- Domain or feature areas discussed

For voice-transcribed prompts: The vocabulary is especially important because speech-to-text might transcribe project-specific terms incorrectly. Look for words that sound similar to vocabulary items.

IMPORTANT: If the prompt doesn't contain enough information to make a meaningful recommendation (e.g., generic requests like "help me with this" or "fix the bug"), return -1 for recommended_index and empty string for recommended_name. Only recommend a repository if you have actual evidence from the prompt to support the choice.{}"#,
            repos_list,
            truncate_text(prompt, 1500),
            Self::json_only(
                r#"{"recommended_index": 0, "recommended_name": "repo name", "confidence": "low|medium|high", "reasoning": "brief explanation"}

Or if no clear match:
{"recommended_index": -1, "recommended_name": "", "confidence": "low", "reasoning": "Not enough information to determine repository"}"#
            )
        );

        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "recommended_index": {
                    "type": "integer",
                    "description": "The index of the recommended repository (0-based), or -1 if no clear match"
                },
                "recommended_name": {
                    "type": "string",
                    "description": "The name of the recommended repository, or empty string if no clear match"
                },
                "confidence": {
                    "type": "string",
                    "enum": ["low", "medium", "high"],
                    "description": "Confidence level in this recommendation"
                },
                "reasoning": {
                    "type": "string",
                    "description": "Brief explanation of why this repo was chosen or why no recommendation could be made"
                }
            },
            "required": ["recommended_index", "recommended_name", "confidence", "reasoning"]
        });

        self.run_feature(prompt_text, schema).await
    }

    /// Generate quick actions with usage tracking.
    ///
    /// `latest_prompt` is the user's most recent turn (differs from `user_prompt`
    /// in multi-turn sessions); `session_activity` is a compact digest of tool
    /// calls the session already performed (commands run, files edited) so the
    /// model never suggests work that already happened.
    pub async fn generate_quick_actions_with_usage(
        &self,
        user_prompt: &str,
        latest_prompt: Option<&str>,
        session_activity: Option<&str>,
        last_message: &str,
    ) -> Result<GenerationResult<QuickActionsResult>, String> {
        let latest_section = match latest_prompt {
            Some(latest) if latest != user_prompt => format!(
                "\n\nUser's most recent request (the current focus — weigh this over the original):\n{}",
                truncate_text(latest, 500)
            ),
            _ => String::new(),
        };

        let activity_section = match session_activity {
            Some(activity) if !activity.is_empty() => format!(
                "\n\nWhat the session has ALREADY DONE (tool calls, newest last — never suggest repeating these):\n{}",
                truncate_text(activity, 1500)
            ),
            _ => String::new(),
        };

        let prompt = format!(
            r#"You suggest follow-up prompts for a coding-agent session. Each suggestion becomes a button; clicking it sends the `prompt` text VERBATIM as the next prompt to the coding agent working in the user's repository. The agent can edit code, run shell commands, commit, and investigate — it canNOT click UI, review PRs for the user, or do anything on the user's behalf outside the repo.

User's original request:
{}{}

Assistant's final message:
{}{}

Rules — every suggestion must pass ALL of these:
1. It must be an instruction the CODING AGENT can execute in the repo. Never suggest app-UI actions ("open X view", "show logs panel"), user-side actions ("copy the value", "review the PR", "mark the card done"), or interactions with a website/screenshot the assistant described.
2. Never suggest something the session already did. If tests already ran, a commit was already made, or a PR was already opened, do not suggest them again.
3. The BEST suggestions resolve loose ends the assistant itself stated: deferred items, untested paths, caveats ("worth testing X live", "the first run will tell us"), remaining errors, or an offered next step awaiting a yes. Prefer extracting those over inventing new work.
4. Each `prompt` must be a specific, self-contained instruction (the agent sees only this text): "Commit the pane-layout fix" not "Commit changes"; "Run svelte-check and fix any errors it reports" not "Run checks".
5. Quality over quantity: return 0-3 suggestions. If the session ended cleanly with no genuine next step, return an empty actions array — that is a correct answer, not a failure.

For each action provide `label` (2-4 word button text) and `prompt` (the full one-sentence instruction sent to the agent)."#,
            truncate_text(user_prompt, 500),
            latest_section,
            truncate_text(last_message, 2000),
            activity_section,
        ) + &Self::json_only(
            r#"{"actions": [{"label": "Test live run", "prompt": "Run a real backgrounded command to verify the background-task tracking works end to end"}]}"#,
        );

        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "actions": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": {
                                "type": "string",
                                "description": "Short button text (2-4 words)"
                            },
                            "prompt": {
                                "type": "string",
                                "description": "Full self-contained instruction sent verbatim to the coding agent (one sentence)"
                            }
                        },
                        "required": ["label", "prompt"]
                    },
                    "minItems": 0,
                    "maxItems": 3,
                    "description": "0-3 genuinely useful follow-up actions; empty when nothing useful remains"
                }
            },
            "required": ["actions"]
        });

        self.run_feature(prompt, schema).await
    }

    /// Draft a commit message and PR title/body for the validation ship step,
    /// from the intent, a `git diff --stat`, and a per-step outcome summary.
    /// The caller falls back to deterministic templates on any error.
    pub async fn draft_ship_with_usage(
        &self,
        intent: &str,
        diffstat: &str,
        validation_summary: &str,
    ) -> Result<GenerationResult<ShipDraftResult>, String> {
        let prompt = format!(
            r##"Draft a git commit message and a pull request title and body for a completed, validated change.

Use the intent as the source of truth for WHAT was intended, the diffstat for the surface area of the change, and the validation summary for the pipeline outcomes.

Rules:
- commit_message: a concise imperative subject line (<= 72 chars), optionally followed by a short body. No trailing period on the subject.
- pr_title: concise, imperative, no trailing period.
- pr_body: markdown with these sections, in order, using level-2 headings named Intent, What changed, and Validation. Keep it factual; do not invent work that isn't in the inputs.

Intent:
{}

Diffstat:
{}

Validation summary:
{}{}"##,
            truncate_text(intent, 3000),
            truncate_text(diffstat, 2000),
            truncate_text(validation_summary, 2000),
            Self::json_only(
                r###"{"commit_message": "imperative subject", "pr_title": "imperative title", "pr_body": "## Intent\n...\n\n## What changed\n...\n\n## Validation\n..."}"###
            )
        );

        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "commit_message": { "type": "string", "description": "Commit message (imperative subject, optional body)" },
                "pr_title": { "type": "string", "description": "Concise imperative PR title" },
                "pr_body": { "type": "string", "description": "Markdown PR body with Intent / What changed / Validation sections" }
            },
            "required": ["commit_message", "pr_title", "pr_body"]
        });

        self.run_feature(prompt, schema).await
    }

    /// Generate a descriptive git branch name from a user prompt
    pub async fn generate_branch_name_with_usage(
        &self,
        user_prompt: &str,
        existing_branches: &[String],
    ) -> Result<GenerationResult<BranchNameResult>, String> {
        let existing_list = if existing_branches.is_empty() {
            "None".to_string()
        } else {
            existing_branches
                .iter()
                .take(50) // Don't send too many
                .cloned()
                .collect::<Vec<_>>()
                .join(", ")
        };

        let prompt = format!(
            r#"Generate a concise git branch name for this coding task.

IMPORTANT: The prompt may contain operational/tool instructions like "read card", "scan codebase", "set the card status", "using the notion skill". Strip these away and name the branch after the ACTUAL task being implemented.

User's request:
{}

Existing branches (avoid these names):
{}

Rules:
- Use lowercase letters, numbers, and hyphens only
- 3-6 words, hyphen-separated (e.g., "fix-auth-token-refresh", "add-dark-mode-toggle")
- Be descriptive of the task, not generic
- Do NOT use any prefix like "claude/", "feature/", "fix/", etc.
- Do NOT include timestamps or random suffixes
- Must not conflict with existing branch names listed above{}"#,
            truncate_text(user_prompt, 2000),
            existing_list,
            Self::json_only(r#"{"branch_name": "descriptive-branch-name"}"#)
        );

        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "branch_name": {
                    "type": "string",
                    "description": "A concise, descriptive git branch name using lowercase and hyphens"
                }
            },
            "required": ["branch_name"]
        });

        self.run_feature(prompt, schema).await
    }
}
