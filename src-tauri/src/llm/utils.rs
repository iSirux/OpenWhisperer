/// Extract JSON from text that might be wrapped in markdown code blocks
pub fn extract_json(text: &str) -> String {
    let trimmed = text.trim();

    // Check for ```json ... ``` or ``` ... ```
    if trimmed.starts_with("```") {
        let without_prefix = if trimmed.starts_with("```json") {
            &trimmed[7..]
        } else {
            &trimmed[3..]
        };

        if let Some(end) = without_prefix.rfind("```") {
            return without_prefix[..end].trim().to_string();
        }
    }

    // Return as-is if no code block
    trimmed.to_string()
}

/// Truncate text to a maximum number of characters, adding an ellipsis if
/// truncated. Delegates to the shared char-safe implementation so it never
/// panics on multibyte UTF-8 boundaries (the previous byte-index slice did).
pub fn truncate_text(text: &str, max_len: usize) -> String {
    crate::util::truncate_chars(text, max_len)
}

#[cfg(test)]
mod tests {
    use super::truncate_text;

    #[test]
    fn truncate_multibyte_at_boundary_does_not_panic() {
        // Each emoji is 4 bytes; truncating at a char count that lands
        // mid-multibyte-byte would panic with the old byte-index slice.
        let s = "😀😀😀😀😀"; // 5 chars, 20 bytes
        let out = truncate_text(s, 3);
        assert_eq!(out, "😀😀😀...");

        // Non-breaking spaces (2 bytes each) interleaved with ascii.
        let s2 = "a\u{00a0}b\u{00a0}c\u{00a0}d";
        let out2 = truncate_text(s2, 3);
        assert_eq!(out2, "a\u{00a0}b...");
    }

    #[test]
    fn truncate_shorter_than_limit_returns_unchanged() {
        assert_eq!(truncate_text("hello", 100), "hello");
        assert_eq!(truncate_text("😀", 100), "😀");
    }
}
