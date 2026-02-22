use minijinja::{Environment, Error, ErrorKind, Value};
use regex::Regex;
use serde_json;
use std::collections::BTreeMap;

/// Template engine wrapping minijinja for rendering template strings with context data.
///
/// A fresh `Environment` is created on each render call to avoid lifetime issues.
/// The engine is `Send + Sync` safe since it holds no mutable state.
pub struct TemplateEngine;

impl TemplateEngine {
    /// Create a new `TemplateEngine`.
    #[allow(dead_code)]
    pub fn new() -> Self {
        TemplateEngine
    }

    /// Render a template string with the given JSON context.
    ///
    /// Creates a fresh minijinja `Environment`, registers all custom filters,
    /// adds the template as an inline source, converts the context, and renders.
    pub fn render(template_str: &str, context: &serde_json::Value) -> Result<String, String> {
        let mut env = Environment::new();
        Self::register_filters(&mut env);

        env.add_template("template", template_str)
            .map_err(|e| format!("Failed to add template: {e}"))?;

        let tmpl = env
            .get_template("template")
            .map_err(|e| format!("Failed to get template: {e}"))?;

        let ctx = serde_to_minijinja(context);

        tmpl.render(ctx)
            .map_err(|e| format!("Failed to render template: {e}"))
    }

    /// Evaluate an expression to a boolean value.
    ///
    /// The expression is wrapped in `{% if expr %}true{% else %}false{% endif %}`,
    /// rendered, and the result is interpreted as a boolean.
    pub fn eval_bool(expr: &str, context: &serde_json::Value) -> Result<bool, String> {
        let template_str = format!("{{% if {expr} %}}true{{% else %}}false{{% endif %}}");

        let result = Self::render(&template_str, context)?;

        match result.trim() {
            "true" => Ok(true),
            "false" => Ok(false),
            "" => Ok(false),
            other => {
                // Try to parse as a number: non-zero is true
                if let Ok(n) = other.parse::<f64>() {
                    Ok(n != 0.0)
                } else {
                    // Non-empty string is truthy
                    Ok(true)
                }
            }
        }
    }

    /// Evaluate an expression and return its string representation.
    pub fn eval_string(expr: &str, context: &serde_json::Value) -> Result<String, String> {
        let template_str = format!("{{{{ {expr} }}}}");
        Self::render(&template_str, context)
    }

    /// Register all custom filters on the given environment.
    fn register_filters(env: &mut Environment<'_>) {
        env.add_filter("truncate", filter_truncate);
        env.add_filter("slugify", filter_slugify);
        env.add_filter("upper", filter_upper);
        env.add_filter("lower", filter_lower);
        env.add_filter("join", filter_join);
        env.add_filter("length", filter_length);
        env.add_filter("default", filter_default);
        env.add_filter("json_parse", filter_json_parse);
        env.add_filter("get", filter_get_key);
        env.add_filter("regex", filter_regex_match);
        env.add_filter("human_duration", filter_human_duration);
        env.add_filter("first", filter_first);
        env.add_filter("last", filter_last);
        env.add_filter("trim", filter_trim);
        env.add_filter("shell_escape", filter_shell_escape);
    }
}

// ---------------------------------------------------------------------------
// Custom filters
// ---------------------------------------------------------------------------

/// Truncate a string to `n` characters, appending "..." if truncated.
fn filter_truncate(value: String, n: usize) -> String {
    if value.chars().count() <= n {
        value
    } else {
        let truncated: String = value.chars().take(n).collect();
        format!("{truncated}...")
    }
}

/// Convert a string to a URL-friendly slug: lowercase, non-alphanumeric chars
/// replaced with hyphens, consecutive hyphens collapsed, leading/trailing hyphens trimmed.
fn filter_slugify(value: String) -> String {
    let lowered = value.to_lowercase();
    let replaced: String = lowered
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();

    // Collapse consecutive hyphens
    let mut collapsed = String::with_capacity(replaced.len());
    let mut prev_hyphen = false;
    for c in replaced.chars() {
        if c == '-' {
            if !prev_hyphen {
                collapsed.push('-');
            }
            prev_hyphen = true;
        } else {
            collapsed.push(c);
            prev_hyphen = false;
        }
    }

    // Trim leading and trailing hyphens
    collapsed.trim_matches('-').to_string()
}

/// Uppercase the entire string.
fn filter_upper(value: String) -> String {
    value.to_uppercase()
}

/// Lowercase the entire string.
fn filter_lower(value: String) -> String {
    value.to_lowercase()
}

/// Join an array of values with a separator string.
fn filter_join(value: Value, sep: String) -> Result<String, Error> {
    // Try to iterate over the value as a sequence
    if let Ok(iter) = value.try_iter() {
        let parts: Vec<String> = iter.map(|v| v.to_string()).collect();
        Ok(parts.join(&sep))
    } else {
        // If not iterable, just return the string representation
        Ok(value.to_string())
    }
}

/// Return the length of a string or array.
fn filter_length(value: Value) -> Result<usize, Error> {
    // Try sequence length first
    if let Some(seq_len) = value.len() {
        return Ok(seq_len);
    }
    // Fall back to string representation length
    let s = value.to_string();
    Ok(s.len())
}

/// Return `value` if it is truthy, otherwise return `default_val`.
fn filter_default(value: Value, default_val: Value) -> Value {
    if value.is_undefined() || value.is_none() {
        return default_val;
    }
    // Check for falsy values: false boolean or empty string
    if value.kind() == minijinja::value::ValueKind::Bool {
        if !value.is_true() {
            return default_val;
        }
    }
    if value.kind() == minijinja::value::ValueKind::String {
        if value.to_string().is_empty() {
            return default_val;
        }
    }
    value
}

/// Parse a JSON string into a minijinja `Value`.
///
/// Lenient parsing strategy:
/// 1. Try direct parse
/// 2. Strip markdown code fences and retry
/// 3. Extract the first `{...}` or `[...]` block and retry
/// 4. Return an error
fn filter_json_parse(value: String) -> Result<Value, Error> {
    // Attempt 1: direct parse
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&value) {
        return Ok(serde_to_minijinja(&parsed));
    }

    // Attempt 2: strip markdown code fences
    let stripped = strip_code_fences(&value);
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&stripped) {
        return Ok(serde_to_minijinja(&parsed));
    }

    // Attempt 3: extract the first JSON object or array
    if let Some(extracted) = extract_json_block(&value) {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&extracted) {
            return Ok(serde_to_minijinja(&parsed));
        }
    }

    Err(Error::new(
        ErrorKind::InvalidOperation,
        format!("Failed to parse JSON from string: {}", truncate_for_error(&value)),
    ))
}

/// Access a dictionary/object value by key.
fn filter_get_key(value: Value, key: String) -> Value {
    value.get_attr(&key).unwrap_or(Value::UNDEFINED)
}

/// Test if a regex pattern matches the given string.
fn filter_regex_match(value: String, pattern: String) -> Result<bool, Error> {
    let re = Regex::new(&pattern).map_err(|e| {
        Error::new(
            ErrorKind::InvalidOperation,
            format!("Invalid regex pattern: {e}"),
        )
    })?;
    Ok(re.is_match(&value))
}

/// Format a duration in seconds as a human-readable string (e.g. "1h 23m 45s").
/// Only non-zero parts are included. Zero seconds returns "0s".
fn filter_human_duration(seconds: f64) -> String {
    let total_secs = seconds.round() as u64;

    if total_secs == 0 {
        return "0s".to_string();
    }

    let hours = total_secs / 3600;
    let minutes = (total_secs % 3600) / 60;
    let secs = total_secs % 60;

    let mut parts = Vec::new();
    if hours > 0 {
        parts.push(format!("{hours}h"));
    }
    if minutes > 0 {
        parts.push(format!("{minutes}m"));
    }
    if secs > 0 {
        parts.push(format!("{secs}s"));
    }

    parts.join(" ")
}

/// Return the first element of an array, or UNDEFINED if empty.
fn filter_first(value: Value) -> Value {
    if let Ok(mut iter) = value.try_iter() {
        iter.next().unwrap_or(Value::UNDEFINED)
    } else {
        Value::UNDEFINED
    }
}

/// Return the last element of an array, or UNDEFINED if empty.
fn filter_last(value: Value) -> Value {
    if let Ok(iter) = value.try_iter() {
        iter.last().unwrap_or(Value::UNDEFINED)
    } else {
        Value::UNDEFINED
    }
}

/// Trim leading and trailing whitespace.
fn filter_trim(value: String) -> String {
    value.trim().to_string()
}

/// Escape a string for safe use in a shell command by wrapping it in single quotes
/// and escaping any existing single quotes.
fn filter_shell_escape(value: String) -> String {
    // Replace each ' with '\'' (end quote, escaped quote, start quote)
    let escaped = value.replace('\'', "'\\''");
    format!("'{escaped}'")
}

// ---------------------------------------------------------------------------
// Helper: serde_json::Value -> minijinja::Value conversion
// ---------------------------------------------------------------------------

/// Recursively convert a `serde_json::Value` into a `minijinja::Value`.
pub fn serde_to_minijinja(value: &serde_json::Value) -> Value {
    match value {
        serde_json::Value::Null => Value::UNDEFINED,
        serde_json::Value::Bool(b) => Value::from(*b),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::from(i)
            } else if let Some(f) = n.as_f64() {
                Value::from(f)
            } else {
                // Fallback for u64 values that don't fit in i64
                Value::from(n.as_u64().unwrap_or(0) as i64)
            }
        }
        serde_json::Value::String(s) => Value::from(s.as_str()),
        serde_json::Value::Array(arr) => {
            let items: Vec<Value> = arr.iter().map(serde_to_minijinja).collect();
            Value::from(items)
        }
        serde_json::Value::Object(obj) => {
            let map: BTreeMap<String, Value> = obj
                .iter()
                .map(|(k, v)| (k.clone(), serde_to_minijinja(v)))
                .collect();
            Value::from(map)
        }
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Strip markdown code fences (```json ... ``` or ``` ... ```) from a string.
fn strip_code_fences(s: &str) -> String {
    let trimmed = s.trim();

    // Match opening fence: ```<optional language>
    if let Some(rest) = trimmed.strip_prefix("```") {
        // Skip the language identifier on the first line
        let after_lang = if let Some(pos) = rest.find('\n') {
            &rest[pos + 1..]
        } else {
            rest
        };

        // Strip closing fence
        let content = if let Some(stripped) = after_lang.strip_suffix("```") {
            stripped
        } else {
            after_lang
        };

        content.trim().to_string()
    } else {
        trimmed.to_string()
    }
}

/// Extract the first balanced JSON object `{...}` or array `[...]` from a string.
fn extract_json_block(s: &str) -> Option<String> {
    // Find the first { or [
    let (open_char, close_char, start) = {
        let obj_pos = s.find('{');
        let arr_pos = s.find('[');
        match (obj_pos, arr_pos) {
            (Some(o), Some(a)) if o <= a => ('{', '}', o),
            (Some(_), Some(a)) => ('[', ']', a),
            (Some(o), None) => ('{', '}', o),
            (None, Some(a)) => ('[', ']', a),
            (None, None) => return None,
        }
    };

    let bytes = s.as_bytes();
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escape_next = false;

    for i in start..bytes.len() {
        let c = bytes[i] as char;

        if escape_next {
            escape_next = false;
            continue;
        }

        if c == '\\' && in_string {
            escape_next = true;
            continue;
        }

        if c == '"' {
            in_string = !in_string;
            continue;
        }

        if in_string {
            continue;
        }

        if c == open_char {
            depth += 1;
        } else if c == close_char {
            depth -= 1;
            if depth == 0 {
                return Some(s[start..=i].to_string());
            }
        }
    }

    None
}

/// Truncate a string for use in error messages.
fn truncate_for_error(s: &str) -> String {
    const MAX_LEN: usize = 100;
    if s.len() <= MAX_LEN {
        s.to_string()
    } else {
        format!("{}...", &s[..MAX_LEN])
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_new() {
        let _engine = TemplateEngine::new();
    }

    #[test]
    fn test_render_simple() {
        let ctx = json!({"name": "World"});
        let result = TemplateEngine::render("Hello, {{ name }}!", &ctx).unwrap();
        assert_eq!(result, "Hello, World!");
    }

    #[test]
    fn test_render_nested() {
        let ctx = json!({"user": {"name": "Alice", "age": 30}});
        let result =
            TemplateEngine::render("{{ user.name }} is {{ user.age }}", &ctx).unwrap();
        assert_eq!(result, "Alice is 30");
    }

    #[test]
    fn test_render_array() {
        let ctx = json!({"items": ["a", "b", "c"]});
        let result = TemplateEngine::render(
            "{% for item in items %}{{ item }}{% endfor %}",
            &ctx,
        )
        .unwrap();
        assert_eq!(result, "abc");
    }

    #[test]
    fn test_render_error() {
        let ctx = json!({});
        let result = TemplateEngine::render("{{ undefined_func() }}", &ctx);
        assert!(result.is_err());
    }

    #[test]
    fn test_eval_bool_true() {
        let ctx = json!({"flag": true});
        assert!(TemplateEngine::eval_bool("flag", &ctx).unwrap());
    }

    #[test]
    fn test_eval_bool_false() {
        let ctx = json!({"flag": false});
        assert!(!TemplateEngine::eval_bool("flag", &ctx).unwrap());
    }

    #[test]
    fn test_eval_bool_comparison() {
        let ctx = json!({"x": 5});
        assert!(TemplateEngine::eval_bool("x > 3", &ctx).unwrap());
        assert!(!TemplateEngine::eval_bool("x > 10", &ctx).unwrap());
    }

    #[test]
    fn test_eval_bool_undefined() {
        let ctx = json!({});
        assert!(!TemplateEngine::eval_bool("missing_var", &ctx).unwrap());
    }

    #[test]
    fn test_eval_string() {
        let ctx = json!({"greeting": "hello"});
        let result = TemplateEngine::eval_string("greeting", &ctx).unwrap();
        assert_eq!(result, "hello");
    }

    #[test]
    fn test_eval_string_expression() {
        let ctx = json!({"x": 2, "y": 3});
        let result = TemplateEngine::eval_string("x + y", &ctx).unwrap();
        assert_eq!(result, "5");
    }

    // Filter tests

    #[test]
    fn test_filter_truncate() {
        assert_eq!(filter_truncate("hello world".into(), 5), "hello...");
        assert_eq!(filter_truncate("hi".into(), 5), "hi");
        assert_eq!(filter_truncate("exact".into(), 5), "exact");
    }

    #[test]
    fn test_filter_truncate_in_template() {
        let ctx = json!({"text": "hello world"});
        let result =
            TemplateEngine::render("{{ text | truncate(5) }}", &ctx).unwrap();
        assert_eq!(result, "hello...");
    }

    #[test]
    fn test_filter_slugify() {
        assert_eq!(filter_slugify("Hello World!".into()), "hello-world");
        assert_eq!(filter_slugify("  Hello World!  ".into()), "hello-world");
        assert_eq!(
            filter_slugify("This---is  a TEST".into()),
            "this-is-a-test"
        );
        assert_eq!(filter_slugify("---leading---".into()), "leading");
        assert_eq!(filter_slugify("CamelCase".into()), "camelcase");
    }

    #[test]
    fn test_filter_upper_lower() {
        assert_eq!(filter_upper("hello".into()), "HELLO");
        assert_eq!(filter_lower("HELLO".into()), "hello");
    }

    #[test]
    fn test_filter_join() {
        let items = Value::from(vec![
            Value::from("a"),
            Value::from("b"),
            Value::from("c"),
        ]);
        assert_eq!(filter_join(items, ", ".into()).unwrap(), "a, b, c");
    }

    #[test]
    fn test_filter_length_string() {
        let val = Value::from("hello");
        assert_eq!(filter_length(val).unwrap(), 5);
    }

    #[test]
    fn test_filter_length_array() {
        let val = Value::from(vec![Value::from(1), Value::from(2), Value::from(3)]);
        assert_eq!(filter_length(val).unwrap(), 3);
    }

    #[test]
    fn test_filter_default() {
        let val = Value::UNDEFINED;
        let def = Value::from("fallback");
        assert_eq!(
            filter_default(val, def).to_string(),
            "fallback"
        );

        let val = Value::from("present");
        let def = Value::from("fallback");
        assert_eq!(
            filter_default(val, def).to_string(),
            "present"
        );
    }

    #[test]
    fn test_filter_default_false_bool() {
        let val = Value::from(false);
        let def = Value::from("fallback");
        assert_eq!(
            filter_default(val, def).to_string(),
            "fallback"
        );
    }

    #[test]
    fn test_filter_json_parse_direct() {
        let result = filter_json_parse(r#"{"key": "value"}"#.into()).unwrap();
        assert_eq!(
            result.get_attr("key").unwrap().to_string(),
            "value"
        );
    }

    #[test]
    fn test_filter_json_parse_with_fences() {
        let input = "```json\n{\"key\": \"value\"}\n```";
        let result = filter_json_parse(input.into()).unwrap();
        assert_eq!(
            result.get_attr("key").unwrap().to_string(),
            "value"
        );
    }

    #[test]
    fn test_filter_json_parse_extract_block() {
        let input = "Here is some text {\"key\": \"value\"} and more text";
        let result = filter_json_parse(input.into()).unwrap();
        assert_eq!(
            result.get_attr("key").unwrap().to_string(),
            "value"
        );
    }

    #[test]
    fn test_filter_json_parse_array() {
        let result = filter_json_parse("[1, 2, 3]".into()).unwrap();
        // Check it's a sequence
        assert_eq!(result.len(), Some(3));
    }

    #[test]
    fn test_filter_json_parse_invalid() {
        let result = filter_json_parse("not json at all".into());
        assert!(result.is_err());
    }

    #[test]
    fn test_filter_get_key() {
        let mut map = BTreeMap::new();
        map.insert("foo".to_string(), Value::from("bar"));
        let val = Value::from(map);
        assert_eq!(filter_get_key(val, "foo".into()).to_string(), "bar");
    }

    #[test]
    fn test_filter_get_key_missing() {
        let map = BTreeMap::<String, Value>::new();
        let val = Value::from(map);
        let result = filter_get_key(val, "missing".into());
        assert!(result.is_undefined());
    }

    #[test]
    fn test_filter_regex_match() {
        assert!(filter_regex_match("hello123".into(), r"\d+".into()).unwrap());
        assert!(!filter_regex_match("hello".into(), r"\d+".into()).unwrap());
    }

    #[test]
    fn test_filter_regex_match_invalid_pattern() {
        let result = filter_regex_match("test".into(), r"[invalid".into());
        assert!(result.is_err());
    }

    #[test]
    fn test_filter_human_duration() {
        assert_eq!(filter_human_duration(0.0), "0s");
        assert_eq!(filter_human_duration(45.0), "45s");
        assert_eq!(filter_human_duration(90.0), "1m 30s");
        assert_eq!(filter_human_duration(3661.0), "1h 1m 1s");
        assert_eq!(filter_human_duration(3600.0), "1h");
        assert_eq!(filter_human_duration(60.0), "1m");
    }

    #[test]
    fn test_filter_first_last() {
        let items = Value::from(vec![Value::from(1), Value::from(2), Value::from(3)]);
        assert_eq!(filter_first(items.clone()).to_string(), "1");
        assert_eq!(filter_last(items).to_string(), "3");
    }

    #[test]
    fn test_filter_first_last_empty() {
        let items = Value::from(Vec::<Value>::new());
        assert!(filter_first(items.clone()).is_undefined());
        assert!(filter_last(items).is_undefined());
    }

    #[test]
    fn test_filter_trim() {
        assert_eq!(filter_trim("  hello  ".into()), "hello");
        assert_eq!(filter_trim("\n\thello\t\n".into()), "hello");
    }

    #[test]
    fn test_filter_shell_escape() {
        assert_eq!(filter_shell_escape("hello".into()), "'hello'");
        assert_eq!(
            filter_shell_escape("it's a test".into()),
            "'it'\\''s a test'"
        );
        assert_eq!(
            filter_shell_escape("hello world".into()),
            "'hello world'"
        );
    }

    #[test]
    fn test_filter_shell_escape_in_template() {
        let ctx = json!({"cmd": "echo 'hello'"});
        let result =
            TemplateEngine::render("{{ cmd | shell_escape }}", &ctx).unwrap();
        assert_eq!(result, "'echo '\\''hello'\\'''");
    }

    // Integration tests for filters used in templates

    #[test]
    fn test_filters_in_templates() {
        let ctx = json!({
            "name": "Hello World",
            "items": ["one", "two", "three"],
            "duration": 3723
        });

        assert_eq!(
            TemplateEngine::render("{{ name | slugify }}", &ctx).unwrap(),
            "hello-world"
        );
        assert_eq!(
            TemplateEngine::render("{{ name | upper }}", &ctx).unwrap(),
            "HELLO WORLD"
        );
        assert_eq!(
            TemplateEngine::render("{{ name | lower }}", &ctx).unwrap(),
            "hello world"
        );
        assert_eq!(
            TemplateEngine::render("{{ items | join(', ') }}", &ctx).unwrap(),
            "one, two, three"
        );
        assert_eq!(
            TemplateEngine::render("{{ items | length }}", &ctx).unwrap(),
            "3"
        );
        assert_eq!(
            TemplateEngine::render("{{ duration | human_duration }}", &ctx).unwrap(),
            "1h 2m 3s"
        );
        assert_eq!(
            TemplateEngine::render("{{ items | first }}", &ctx).unwrap(),
            "one"
        );
        assert_eq!(
            TemplateEngine::render("{{ items | last }}", &ctx).unwrap(),
            "three"
        );
    }

    #[test]
    fn test_default_filter_in_template() {
        let ctx = json!({"name": "Alice"});
        assert_eq!(
            TemplateEngine::render("{{ name | default('Unknown') }}", &ctx).unwrap(),
            "Alice"
        );
        assert_eq!(
            TemplateEngine::render("{{ missing | default('Unknown') }}", &ctx).unwrap(),
            "Unknown"
        );
    }

    #[test]
    fn test_regex_filter_in_template() {
        let ctx = json!({"text": "version 2.5.1"});
        assert_eq!(
            TemplateEngine::render(
                "{% if text | regex('\\\\d+\\\\.\\\\d+') %}has version{% else %}no version{% endif %}",
                &ctx
            )
            .unwrap(),
            "has version"
        );
    }

    #[test]
    fn test_chained_filters() {
        let ctx = json!({"text": "  Hello World  "});
        assert_eq!(
            TemplateEngine::render("{{ text | trim | lower | slugify }}", &ctx).unwrap(),
            "hello-world"
        );
    }

    // serde_to_minijinja tests

    #[test]
    fn test_serde_null() {
        let v = serde_to_minijinja(&serde_json::Value::Null);
        assert!(v.is_undefined());
    }

    #[test]
    fn test_serde_bool() {
        let v = serde_to_minijinja(&json!(true));
        assert!(v.is_true());
        let v = serde_to_minijinja(&json!(false));
        assert!(!v.is_true());
    }

    #[test]
    fn test_serde_number() {
        let v = serde_to_minijinja(&json!(42));
        assert_eq!(v.to_string(), "42");
        let v = serde_to_minijinja(&json!(3.14));
        assert!(v.to_string().starts_with("3.14"));
    }

    #[test]
    fn test_serde_string() {
        let v = serde_to_minijinja(&json!("hello"));
        assert_eq!(v.to_string(), "hello");
    }

    #[test]
    fn test_serde_array() {
        let v = serde_to_minijinja(&json!([1, 2, 3]));
        assert_eq!(v.len(), Some(3));
    }

    #[test]
    fn test_serde_object() {
        let v = serde_to_minijinja(&json!({"key": "value"}));
        assert_eq!(v.get_attr("key").unwrap().to_string(), "value");
    }

    #[test]
    fn test_serde_nested() {
        let v = serde_to_minijinja(&json!({
            "user": {
                "name": "Alice",
                "scores": [100, 95, 88]
            }
        }));
        let user = v.get_attr("user").unwrap();
        assert_eq!(user.get_attr("name").unwrap().to_string(), "Alice");
    }

    // Internal helper tests

    #[test]
    fn test_strip_code_fences() {
        assert_eq!(
            strip_code_fences("```json\n{\"a\": 1}\n```"),
            "{\"a\": 1}"
        );
        assert_eq!(
            strip_code_fences("```\n{\"a\": 1}\n```"),
            "{\"a\": 1}"
        );
        assert_eq!(strip_code_fences("no fences"), "no fences");
    }

    #[test]
    fn test_extract_json_block() {
        assert_eq!(
            extract_json_block("text {\"a\": 1} more").unwrap(),
            "{\"a\": 1}"
        );
        assert_eq!(
            extract_json_block("text [1, 2, 3] more").unwrap(),
            "[1, 2, 3]"
        );
        assert_eq!(
            extract_json_block("nested {\"a\": {\"b\": 2}} end").unwrap(),
            "{\"a\": {\"b\": 2}}"
        );
        assert!(extract_json_block("no json here").is_none());
    }

    #[test]
    fn test_extract_json_block_with_strings() {
        // Braces inside strings should not affect balance
        assert_eq!(
            extract_json_block(r#"before {"key": "val{ue}"} after"#).unwrap(),
            r#"{"key": "val{ue}"}"#
        );
    }

    #[test]
    fn test_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<TemplateEngine>();
    }
}
