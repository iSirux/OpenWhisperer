//! Versioned, linear config migrations run against the raw `serde_json::Value`
//! at load time. Each entry brings the config up by exactly one version; the
//! current schema version is derived from the length of the table so it can
//! never fall out of sync.
//!
//! Legacy field fix-ups (`fix_known_fields`) and deprecated-model remapping are
//! folded into the v0 -> v1 migration body.

use serde_json::Value;

use super::default_openai_model;
use super::ui::Theme;

/// A migration mutates the raw config JSON in place.
type Migration = fn(&mut Value);

/// Ordered migration table. Index `i` upgrades a config from version `i` to `i + 1`.
const MIGRATIONS: &[Migration] = &[
    migrate_v0_to_v1,
    migrate_v1_to_v2,
    migrate_v2_to_v3,
    migrate_v3_to_v4,
    migrate_v4_to_v5,
];

/// The schema version the current build writes. Derived from the table length so
/// it always matches the number of available migrations.
pub const CURRENT_CONFIG_VERSION: u32 = MIGRATIONS.len() as u32;

/// Run every migration whose source version is `>= from_version`, in order.
/// Returns true if at least one migration ran (i.e. the config should be re-saved).
pub fn run_migrations(value: &mut Value, from_version: u32) -> bool {
    let mut ran = false;
    for (i, migration) in MIGRATIONS.iter().enumerate() {
        if (i as u32) >= from_version {
            migration(value);
            ran = true;
        }
    }
    ran
}

// ============================================================================
// Centralized model-ID alias map (single source of truth for all remaps)
// ============================================================================

/// Map a deprecated/removed OpenAI (Codex) model ID to its current replacement.
pub fn openai_model_alias(model: &str) -> Option<&'static str> {
    match model {
        "codex-mini-latest" | "gpt-5.4-codex" => Some("gpt-5.4"),
        "gpt-5-mini" | "gpt-5.1-codex-mini" => Some("gpt-5.4-mini"),
        // Deprecated by OpenAI with the GPT-5.6 (Sol/Terra/Luna) release
        "gpt-5.3-codex" | "gpt-5.2-codex" => Some("gpt-5.6-terra"),
        _ => None,
    }
}

/// Map a retired Groq chat model ID to its current production replacement.
pub fn groq_model_alias(model: &str) -> Option<&'static str> {
    match model {
        "meta-llama/llama-4-maverick-17b-128e-instruct"
        | "meta-llama/llama-4-scout-17b-16e-instruct"
        | "moonshotai/kimi-k2-instruct-0905"
        | "qwen/qwen3-32b"
        | "llama-3.3-70b-versatile" => Some("openai/gpt-oss-120b"),
        "llama-3.1-8b-instant" => Some("openai/gpt-oss-20b"),
        _ => None,
    }
}

/// Map a retired Gemini model ID to its current replacement.
pub fn gemini_model_alias(model: &str) -> Option<&'static str> {
    match model {
        "gemini-2.0-flash" => Some("gemini-3.1-flash-lite"),
        _ => None,
    }
}

// ============================================================================
// v0 -> v1: legacy field fix-ups + deprecated model remaps
// ============================================================================

fn migrate_v0_to_v1(value: &mut Value) {
    fix_known_fields(value);
    migrate_deprecated_llm_models(value);
}

// ============================================================================
// v1 -> v2: GPT-5.6 rollout (Sol/Terra/Luna) — remap deprecated Codex models
// and surface the new family in existing configs
// ============================================================================

fn migrate_v1_to_v2(value: &mut Value) {
    let Some(obj) = value.as_object_mut() else {
        return;
    };

    // Remap a deprecated default model (e.g. gpt-5.3-codex -> gpt-5.6-terra).
    if let Some(Value::String(openai_model)) = obj.get("openai_model") {
        if let Some(new_model) = openai_model_alias(openai_model) {
            log::error!(
                "[config.migrate] Migrating openai_model '{}' -> '{}'",
                openai_model,
                new_model
            );
            obj.insert(
                "openai_model".to_string(),
                Value::String(new_model.to_string()),
            );
        }
    }

    if let Some(Value::Array(enabled_models)) = obj.get_mut("enabled_openai_models") {
        // Remap deprecated entries, then prepend the new GPT-5.6 family so
        // existing users see the new models without resetting their selection.
        for model in enabled_models.iter_mut() {
            if let Value::String(s) = model {
                if let Some(new_model) = openai_model_alias(s) {
                    *s = new_model.to_string();
                }
            }
        }
        for new_model in ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"] {
            enabled_models.insert(0, Value::String(new_model.to_string()));
        }
        let mut seen = std::collections::HashSet::new();
        enabled_models.retain(|v| match v {
            Value::String(s) => seen.insert(s.clone()),
            _ => true,
        });
    }
}

// ============================================================================
// v2 -> v3: first-run onboarding wizard — any config already on disk belongs
// to an existing user who must never see the wizard, so stamp it completed
// ============================================================================

fn migrate_v2_to_v3(value: &mut Value) {
    if let Some(obj) = value.as_object_mut() {
        obj.insert("onboarding_completed".to_string(), Value::Bool(true));
    }
}

// ============================================================================
// v3 -> v4: rename the real-time transcription config key `vosk` -> `realtime`.
// Vosk was the original (and once only) realtime provider, so the container was
// historically named after it; it now holds Moonshine/VoiceStreamAI/etc. Move
// the existing object across so nothing is lost (a stale `realtime` never wins).
// ============================================================================

fn migrate_v3_to_v4(value: &mut Value) {
    let Some(obj) = value.as_object_mut() else {
        return;
    };
    if let Some(vosk) = obj.remove("vosk") {
        log::error!("[config.migrate] Renaming config key 'vosk' -> 'realtime'");
        obj.insert("realtime".to_string(), vosk);
    }
}

// ============================================================================
// v4 -> v5: introduce the native Validation pipeline config (`validation` on
// AppConfig; `validation_commands`/`review_guidelines`/`validation_steps` on
// each repo). All new fields are `#[serde(default)]`, so nothing needs to be
// rewritten — an explicit default `validation` object is stamped only so the
// on-disk file surfaces the new settings after the version bump.
// ============================================================================

fn migrate_v4_to_v5(value: &mut Value) {
    let Some(obj) = value.as_object_mut() else {
        return;
    };
    if !obj.contains_key("validation") {
        if let Ok(default_validation) =
            serde_json::to_value(crate::config::ValidationConfig::default())
        {
            obj.insert("validation".to_string(), default_validation);
        }
    }
}

/// Remap deprecated Groq/Gemini LLM model IDs on the raw config value.
fn migrate_deprecated_llm_models(value: &mut Value) {
    let Some(obj) = value.as_object_mut() else {
        return;
    };
    let Some(Value::Object(llm)) = obj.get_mut("llm") else {
        return;
    };

    // Provider is lowercase-serialized? No: LlmProvider serializes as "Groq"/"Gemini".
    let provider = llm.get("provider").and_then(|p| p.as_str()).map(String::from);
    let model = llm.get("model").and_then(|m| m.as_str()).map(String::from);

    let (Some(provider), Some(model)) = (provider, model) else {
        return;
    };

    let replacement = match provider.as_str() {
        "Groq" => groq_model_alias(&model),
        "Gemini" => gemini_model_alias(&model),
        _ => None,
    };

    if let Some(new_model) = replacement {
        log::error!(
            "[config.migrate] Migrating deprecated {} model '{}' -> '{}'",
            provider,
            model,
            new_model
        );
        llm.insert("model".to_string(), Value::String(new_model.to_string()));
    }
}

/// Fix known problematic fields in a parsed JSON Value.
/// This handles fields that can't be fixed by custom deserializers alone
/// (e.g., completely wrong types, removed enum variants).
pub fn fix_known_fields(value: &mut Value) {
    let Value::Object(obj) = value else {
        return;
    };

    // Fix default_effort_level / default_thinking_level
    if let Some(field) = obj
        .get("default_effort_level")
        .or(obj.get("default_thinking_level"))
    {
        if let Value::Bool(_) | Value::Number(_) = field {
            log::error!("[config.fix] Fixing non-string default_effort_level");
            obj.insert(
                "default_effort_level".to_string(),
                Value::String("high".to_string()),
            );
        }
    }

    // Fix llm.features.auto_model_effort / auto_model_thinking
    if let Some(Value::Object(llm)) = obj.get_mut("llm") {
        if let Some(Value::Object(features)) = llm.get_mut("features") {
            for key in &["auto_model_effort", "auto_model_thinking"] {
                if let Some(field) = features.get(*key) {
                    if let Value::Bool(_) | Value::Number(_) = field {
                        log::error!("[config.fix] Fixing non-string {}", key);
                        features.insert(key.to_string(), Value::String("dynamic".to_string()));
                    }
                }
            }
        }
    }

    // Fix theme if it's a removed/unknown variant. The valid list is derived from
    // the Theme enum itself, so it can never drift from the variants.
    if let Some(Value::String(theme)) = obj.get("theme") {
        let valid_themes = Theme::valid_names();
        if !valid_themes.iter().any(|t| t == theme) {
            log::error!("[config.fix] Fixing unknown theme '{}' → Midnight", theme);
            obj.insert("theme".to_string(), Value::String("Midnight".to_string()));
        }
    }

    // Migrate removed/aliased OpenAI model id
    if let Some(Value::String(openai_model)) = obj.get("openai_model") {
        if let Some(new_model) = openai_model_alias(openai_model) {
            log::error!(
                "[config.fix] Migrating openai_model '{}' → '{}'",
                openai_model,
                new_model
            );
            obj.insert(
                "openai_model".to_string(),
                Value::String(new_model.to_string()),
            );
        }
    }

    if let Some(Value::Array(enabled_models)) = obj.get_mut("enabled_openai_models") {
        let mut migrated_any = false;
        for model in enabled_models.iter_mut() {
            if let Value::String(s) = model {
                if let Some(new_model) = openai_model_alias(s) {
                    *s = new_model.to_string();
                    migrated_any = true;
                }
            }
        }

        // Deduplicate after alias migrations.
        let mut seen = std::collections::HashSet::new();
        enabled_models.retain(|v| match v {
            Value::String(s) => seen.insert(s.clone()),
            _ => true,
        });

        if migrated_any {
            log::error!(
                "[config.fix] Migrated deprecated model IDs in enabled_openai_models"
            );
        }
        if enabled_models.is_empty() {
            enabled_models.push(Value::String(default_openai_model()));
            log::error!(
                "[config.fix] enabled_openai_models was empty after migration; restored default"
            );
        }
    }

    // Migrate legacy shared terminal mode into Codex-specific mode.
    if !obj.contains_key("codex_mode") && !obj.contains_key("openai_terminal_mode") {
        if let Some(Value::String(mode)) = obj.get("terminal_mode") {
            if mode == "CodexAppServer" {
                log::error!(
                    "[config.fix] Migrating legacy terminal_mode 'CodexAppServer' to codex_mode"
                );
                obj.insert(
                    "codex_mode".to_string(),
                    Value::String("AppServer".to_string()),
                );
                obj.insert(
                    "terminal_mode".to_string(),
                    Value::String("Interactive".to_string()),
                );
            }
        }
    }

    // Migrate transitional field name openai_terminal_mode -> codex_mode
    if !obj.contains_key("codex_mode") {
        if let Some(Value::String(mode)) = obj.get("openai_terminal_mode") {
            let migrated = if mode == "CodexAppServer" || mode == "AppServer" {
                "AppServer"
            } else {
                "Sdk"
            };
            if mode == "CodexAppServer" || mode == "AppServer" {
                log::error!(
                    "[config.fix] Migrating openai_terminal_mode '{}' to codex_mode=AppServer",
                    mode
                );
            }
            obj.insert("codex_mode".to_string(), Value::String(migrated.to_string()));
        }
    }
}
