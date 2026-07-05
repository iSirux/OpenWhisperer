//! Human-friendly duration parsing for sequence delay/loop/wait nodes.
//!
//! The inverse (`human_duration` filter that formats seconds as `"1h 2m 3s"`)
//! lives in [`crate::sequences::template`]; keep the two co-located conceptually.

/// Parse a human-friendly duration string into seconds.
///
/// Supported formats: `"5s"`, `"30s"`, `"1m"`, `"2m30s"`, `"1h"`, `"1h30m"`,
/// `"90"` (plain number = seconds).
pub fn parse_duration_to_secs(s: &str) -> Result<u64, String> {
    let s = s.trim();

    // Plain numeric
    if let Ok(n) = s.parse::<u64>() {
        return Ok(n);
    }

    let mut total: u64 = 0;
    let mut current_num = String::new();

    for ch in s.chars() {
        if ch.is_ascii_digit() {
            current_num.push(ch);
        } else {
            let n: u64 = current_num
                .parse()
                .map_err(|_| format!("Invalid duration: '{}'", s))?;
            current_num.clear();
            match ch {
                'h' | 'H' => total += n * 3600,
                'm' | 'M' => total += n * 60,
                's' | 'S' => total += n,
                _ => return Err(format!("Unknown duration unit '{}' in '{}'", ch, s)),
            }
        }
    }

    // Trailing number without unit treated as seconds
    if !current_num.is_empty() {
        let n: u64 = current_num
            .parse()
            .map_err(|_| format!("Invalid duration: '{}'", s))?;
        total += n;
    }

    if total == 0 && s != "0s" && s != "0" {
        return Err(format!("Could not parse duration from '{}'", s));
    }

    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_duration_seconds() {
        assert_eq!(parse_duration_to_secs("5s").unwrap(), 5);
        assert_eq!(parse_duration_to_secs("30s").unwrap(), 30);
        assert_eq!(parse_duration_to_secs("0s").unwrap(), 0);
    }

    #[test]
    fn test_parse_duration_minutes() {
        assert_eq!(parse_duration_to_secs("1m").unwrap(), 60);
        assert_eq!(parse_duration_to_secs("5m").unwrap(), 300);
    }

    #[test]
    fn test_parse_duration_hours() {
        assert_eq!(parse_duration_to_secs("1h").unwrap(), 3600);
        assert_eq!(parse_duration_to_secs("2h").unwrap(), 7200);
    }

    #[test]
    fn test_parse_duration_combined() {
        assert_eq!(parse_duration_to_secs("1h30m").unwrap(), 5400);
        assert_eq!(parse_duration_to_secs("2m30s").unwrap(), 150);
        assert_eq!(parse_duration_to_secs("1h2m3s").unwrap(), 3723);
    }

    #[test]
    fn test_parse_duration_plain_number() {
        assert_eq!(parse_duration_to_secs("90").unwrap(), 90);
        assert_eq!(parse_duration_to_secs("0").unwrap(), 0);
    }

    #[test]
    fn test_parse_duration_invalid() {
        assert!(parse_duration_to_secs("abc").is_err());
        assert!(parse_duration_to_secs("5x").is_err());
    }
}
