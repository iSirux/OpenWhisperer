//! LLM feature methods (session naming, transcription cleanup, model recommendations, etc.)

use super::api_types::LlmUsage;
use super::providers::GenerationResult;
use super::types::*;
use super::utils::truncate_text;
use super::LlmClient;

impl LlmClient {
    /// Generate a session name from the user's prompt (called immediately when prompt is sent)
    pub async fn generate_session_name_with_usage(
        &self,
        user_prompt: &str,
    ) -> Result<GenerationResult<SessionNameResult>, String> {
        let prompt = format!(
            r#"Generate a concise name for this coding session based on the user's request.

User's request:
{}

Respond with ONLY a JSON object in this exact format:
{{"name": "3-6 word concise name describing the task", "category": "feature|bugfix|refactor|research|question|other"}}"#,
            truncate_text(user_prompt, 500)
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

        self.generate_structured_with_usage(&prompt, Some(schema)).await
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

Keep it brief (5-15 words) but INCLUDE THE ACTUAL INFORMATION.

User's original request:
{}

Assistant's work (truncated):
{}

Respond with ONLY a JSON object in this exact format:
{{"outcome": "the specific result or answer"}}"#,
            truncate_text(user_prompt, 500),
            truncate_text(assistant_messages, 2000)
        );

        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "outcome": {
                    "type": "string",
                    "description": "A brief outcome describing what was accomplished or the answer (3-10 words)"
                }
            },
            "required": ["outcome"]
        });

        self.generate_structured_with_usage(&prompt, Some(schema)).await
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
{}

Respond with ONLY a JSON object in this exact format:
{{"needs_interaction": true/false, "reason": "why or null", "urgency": "low|medium|high", "waiting_for": "approval|clarification|input|review|decision|null"}}"#,
            truncate_text(last_message, 2000)
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

        self.generate_structured_with_usage(&prompt, Some(schema)).await
    }

    /// Clean transcription with usage tracking
    pub async fn clean_transcription_with_usage(
        &self,
        whisper_transcription: &str,
        vosk_transcription: Option<&str>,
        repo_context: Option<&str>,
    ) -> Result<GenerationResult<TranscriptionCleanupResult>, String> {
        let context_section = if let Some(context) = repo_context {
            format!(
                r#"
Project context (use this to better recognize project-specific terms):
{}

"#,
                context
            )
        } else {
            String::new()
        };

        let transcription_section = if let Some(vosk) = vosk_transcription {
            format!(
                r#"You have two transcriptions from different speech-to-text engines:

**Whisper transcription** (more accurate, but may miss quick words):
{}

**Vosk transcription** (real-time, may capture words Whisper missed but less accurate overall):
{}

Compare both transcriptions and produce the best combined result. Use Whisper as the primary source but incorporate any clearly correct words from Vosk that Whisper may have missed."#,
                truncate_text(whisper_transcription, 1500),
                truncate_text(vosk, 1500)
            )
        } else {
            format!(
                "Transcription to clean:\n{}",
                truncate_text(whisper_transcription, 2000)
            )
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

Respond with ONLY a JSON object in this exact format:
{{"cleaned_text": "the corrected text", "corrections_made": ["correction 1", "correction 2"]}}"#,
            context_section,
            transcription_section
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

        self.generate_structured_with_usage(&prompt, Some(schema)).await
    }

    /// Recommend model with usage tracking
    pub async fn recommend_model_with_usage(&self, prompt: &str, enabled_models: &[String]) -> Result<GenerationResult<ModelRecommendation>, String> {
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
            if enabled_models.iter().any(|id| model_id_to_name(id) == Some(model)) {
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
- **max**: Deepest reasoning for the most complex tasks (Opus only)

Available models (only recommend from these): {}

Prompt to analyze:
{}

Choose the most cost-effective model that can handle this task well. Prefer cheaper models when the task is simple.

Respond with ONLY a JSON object in this exact format:
{{"recommended_model": "{}", "reasoning": "brief explanation", "confidence": "low|medium|high", "suggested_effort": "null|low|medium|high"}}"#,
            available_models.iter().map(|m| format!("**{}**", m)).collect::<Vec<_>>().join(", "),
            truncate_text(prompt, 1500),
            model_list
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
                    "enum": ["null", "low", "medium", "high"],
                    "description": "Suggested effort level: null (off), low, medium, or high"
                }
            },
            "required": ["recommended_model", "reasoning", "confidence", "suggested_effort"]
        });

        self.generate_structured_with_usage(&prompt_text, Some(schema)).await
    }

    /// Recommend repo with usage tracking
    pub async fn recommend_repo_with_usage(
        &self,
        prompt: &str,
        repos: &[(String, String, Option<String>, Option<Vec<String>>, Option<Vec<String>>)],
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

IMPORTANT: If the prompt doesn't contain enough information to make a meaningful recommendation (e.g., generic requests like "help me with this" or "fix the bug"), return -1 for recommended_index and empty string for recommended_name. Only recommend a repository if you have actual evidence from the prompt to support the choice.

Respond with ONLY a JSON object in this exact format:
{{"recommended_index": 0, "recommended_name": "repo name", "confidence": "low|medium|high", "reasoning": "brief explanation"}}

Or if no clear match:
{{"recommended_index": -1, "recommended_name": "", "confidence": "low", "reasoning": "Not enough information to determine repository"}}"#,
            repos_list,
            truncate_text(prompt, 1500)
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

        self.generate_structured_with_usage(&prompt_text, Some(schema)).await
    }

    /// Generate quick actions with usage tracking
    pub async fn generate_quick_actions_with_usage(
        &self,
        user_prompt: &str,
        last_message: &str,
    ) -> Result<GenerationResult<QuickActionsResult>, String> {
        let prompt = format!(
            r#"Based on this AI coding assistant's last message, generate 2-4 contextual quick action prompts that would be most helpful for the user's next step.

User's original request:
{}

Assistant's last message:
{}

Generate quick actions that are:
1. Contextually relevant to what the assistant just said or did
2. Common next steps the user might want to take
3. Specific to the current situation (not generic)
4. Short and direct (2-6 words) - these are displayed as button text AND sent as-is

Examples of GOOD quick actions (specific to context):
- After explaining code: "Show example usage", "Add error handling"
- After making changes: "Run the tests", "Show the diff", "Commit these changes"
- After asking for clarification: "Yes, proceed", "No, try alternative"
- After reporting an error: "Show stack trace", "Try a different approach"
- After completing a task: "Add documentation", "Refactor this", "Add tests"

Examples of BAD quick actions (too generic or too long):
- "Help me", "Continue", "Do more"
- "Please run the test suite and show me the results" (too long)

Respond with ONLY a JSON object in this exact format:
{{"actions": [{{"prompt": "Run the tests"}}]}}"#,
            truncate_text(user_prompt, 500),
            truncate_text(last_message, 1500)
        );

        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "actions": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "prompt": {
                                "type": "string",
                                "description": "Short actionable prompt (2-6 words) displayed as button text and sent as-is"
                            }
                        },
                        "required": ["prompt"]
                    },
                    "minItems": 2,
                    "maxItems": 4,
                    "description": "List of 2-4 contextual quick action prompts"
                }
            },
            "required": ["actions"]
        });

        self.generate_structured_with_usage(&prompt, Some(schema)).await
    }
}
