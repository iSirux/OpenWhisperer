//! Parsing of the `--at` / `--in` / `--every` time grammar into the JSON `when`
//! shapes of the OpenWhisperer schedule schema (`stores/schedules.ts`).
//!
//! Everything here is pure: the "current time" is always passed in, so the
//! grammar is unit-testable without touching the real clock. All wall-clock
//! reasoning happens in the machine's local timezone.

use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, TimeZone, Timelike};
use serde_json::{json, Value};

/// Default time of day used when a form carries a date but no time.
const DEFAULT_HOUR: u32 = 9;
const DEFAULT_MINUTE: u32 = 0;

/// The `--every` flags, grouped so validation can look at them together.
pub struct EverySpec<'a> {
    /// The recurrence rule: `day`, `weekdays`, `week`, `month` or `Nd`.
    pub rule: &'a str,
    /// `--time HH:MM` (defaults to 09:00).
    pub time: Option<&'a str>,
    /// `--on mon,wed` (weekly) or `--on 1..28|last` (monthly).
    pub on: Option<&'a str>,
    /// `--interval N` — only valid for `week` (every N weeks).
    pub interval: Option<u32>,
    /// `--until <when>` — end of the recurrence, in `--at` grammar.
    pub until: Option<&'a str>,
    /// `--max-runs N` — run count limit.
    pub max_runs: Option<u32>,
}

/// `{ "kind": "at", "at": <epoch ms> }`
pub fn when_at(at_ms: i64) -> Value {
    json!({ "kind": "at", "at": at_ms })
}

/// Parse an `--at` value to an epoch-millisecond timestamp.
///
/// Accepts `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM`, `YYYY-MM-DD HH:MM`, `HH:MM`
/// (today, tomorrow if already past), `today HH:MM`, `tomorrow [HH:MM]`,
/// `mon`..`sun [HH:MM]` (next occurrence) and raw epoch milliseconds.
pub fn parse_at(input: &str, now: DateTime<Local>) -> Result<i64, String> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err("empty time value".to_string());
    }

    // Raw epoch milliseconds.
    if raw.len() >= 10 && raw.bytes().all(|b| b.is_ascii_digit()) {
        return raw
            .parse::<i64>()
            .map_err(|_| format!("'{raw}' is not a valid epoch-millisecond timestamp"));
    }

    // Date-prefixed forms: YYYY-MM-DD, optionally followed by T/space and HH:MM.
    if let Some(head) = raw.get(..10) {
        if let Ok(date) = NaiveDate::parse_from_str(head, "%Y-%m-%d") {
            let rest = raw[10..].trim_start_matches(['T', 't', ' ']).trim();
            let (hour, minute) = if rest.is_empty() {
                (DEFAULT_HOUR, DEFAULT_MINUTE)
            } else {
                parse_time_of_day(rest)?
            };
            return local_ms(now, date, hour, minute);
        }
    }

    let lower = raw.to_ascii_lowercase();
    let tokens: Vec<&str> = lower.split_whitespace().collect();
    if tokens.len() > 2 {
        return Err(format!("could not understand the time '{raw}'"));
    }
    let head = tokens[0];
    let tail = tokens.get(1).copied();

    // Bare HH:MM — today, or tomorrow when it has already passed.
    if head.contains(':') && tail.is_none() {
        let (hour, minute) = parse_time_of_day(head)?;
        let today = now.date_naive();
        let candidate = local_ms(now, today, hour, minute)?;
        if candidate > now.timestamp_millis() {
            return Ok(candidate);
        }
        let tomorrow = today
            .succ_opt()
            .ok_or_else(|| "date out of range".to_string())?;
        return local_ms(now, tomorrow, hour, minute);
    }

    let (hour, minute) = match tail {
        Some(t) => parse_time_of_day(t)?,
        None => (DEFAULT_HOUR, DEFAULT_MINUTE),
    };

    match head {
        // Explicit "today" keeps the given day even when the time already passed.
        "today" => local_ms(now, now.date_naive(), hour, minute),
        "tomorrow" => {
            let date = now
                .date_naive()
                .succ_opt()
                .ok_or_else(|| "date out of range".to_string())?;
            local_ms(now, date, hour, minute)
        }
        _ => {
            let weekday = parse_weekday(head)
                .ok_or_else(|| format!("could not understand the time '{raw}'"))?;
            let today = now.date_naive();
            let current = weekday_index(today);
            let mut delta = (weekday + 7 - current) % 7;
            if delta == 0 {
                // Today only counts when the time is still ahead of us.
                let candidate = local_ms(now, today, hour, minute)?;
                if candidate <= now.timestamp_millis() {
                    delta = 7;
                }
            }
            let date = today + Duration::days(delta as i64);
            local_ms(now, date, hour, minute)
        }
    }
}

/// Parse an `--in` value (`30m`, `2h`, `1h30m`, `3d`, bare number = minutes)
/// into a duration in milliseconds.
pub fn parse_duration_ms(input: &str) -> Result<i64, String> {
    let raw = input.trim().to_ascii_lowercase();
    if raw.is_empty() {
        return Err("empty duration".to_string());
    }
    if raw.bytes().all(|b| b.is_ascii_digit()) {
        let minutes: i64 = raw
            .parse()
            .map_err(|_| format!("'{input}' is not a valid duration"))?;
        if minutes == 0 {
            return Err(format!("'{input}' is not a positive duration"));
        }
        return Ok(minutes * 60_000);
    }

    let mut total: i64 = 0;
    let mut digits = String::new();
    let mut saw_unit = false;
    for ch in raw.chars() {
        if ch.is_ascii_digit() {
            digits.push(ch);
            continue;
        }
        if digits.is_empty() {
            return Err(format!(
                "'{input}' is not a valid duration (expected e.g. 30m, 2h, 1h30m, 3d)"
            ));
        }
        let value: i64 = digits
            .parse()
            .map_err(|_| format!("'{input}' is not a valid duration"))?;
        digits.clear();
        let unit_ms = match ch {
            's' => 1_000,
            'm' => 60_000,
            'h' => 3_600_000,
            'd' => 86_400_000,
            'w' => 604_800_000,
            other => {
                return Err(format!(
                    "unknown duration unit '{other}' in '{input}' (use s, m, h, d or w)"
                ))
            }
        };
        total += value * unit_ms;
        saw_unit = true;
    }
    if !digits.is_empty() {
        return Err(format!(
            "'{input}' is not a valid duration (trailing number without a unit)"
        ));
    }
    if !saw_unit || total <= 0 {
        return Err(format!("'{input}' is not a positive duration"));
    }
    Ok(total)
}

/// Parse `HH:MM` (also accepts `H:MM` and `HH.MM`) into (hour, minute).
pub fn parse_time_of_day(input: &str) -> Result<(u32, u32), String> {
    let raw = input.trim().replace('.', ":");
    let (h, m) = raw
        .split_once(':')
        .ok_or_else(|| format!("'{input}' is not a time of day (expected HH:MM)"))?;
    let hour: u32 = h
        .trim()
        .parse()
        .map_err(|_| format!("'{input}' is not a time of day (expected HH:MM)"))?;
    let minute: u32 = m
        .trim()
        .parse()
        .map_err(|_| format!("'{input}' is not a time of day (expected HH:MM)"))?;
    if hour > 23 || minute > 59 {
        return Err(format!("'{input}' is not a valid time of day"));
    }
    Ok((hour, minute))
}

/// Weekday name (or 3-letter abbreviation) to the JavaScript weekday index,
/// where 0 is Sunday.
pub fn parse_weekday(name: &str) -> Option<u32> {
    match name.trim().to_ascii_lowercase().as_str() {
        "sun" | "sunday" => Some(0),
        "mon" | "monday" => Some(1),
        "tue" | "tues" | "tuesday" => Some(2),
        "wed" | "weds" | "wednesday" => Some(3),
        "thu" | "thur" | "thurs" | "thursday" => Some(4),
        "fri" | "friday" => Some(5),
        "sat" | "saturday" => Some(6),
        _ => None,
    }
}

/// Build the recurring `when` shape from the `--every` family of flags.
pub fn build_recurring_when(spec: &EverySpec<'_>, now: DateTime<Local>) -> Result<Value, String> {
    let (hour, minute) = match spec.time {
        Some(t) => parse_time_of_day(t)?,
        None => (DEFAULT_HOUR, DEFAULT_MINUTE),
    };
    let rule = spec.rule.trim().to_ascii_lowercase();

    let pattern = match rule.as_str() {
        "day" | "daily" => {
            reject_on(spec, &rule)?;
            reject_interval(spec, &rule)?;
            json!({ "kind": "daily" })
        }
        "weekdays" | "weekday" => {
            reject_on(spec, &rule)?;
            reject_interval(spec, &rule)?;
            json!({ "kind": "weekly", "days": [1, 2, 3, 4, 5] })
        }
        "week" | "weekly" => {
            let days = match spec.on {
                Some(on) => parse_weekday_list(on)?,
                None => vec![weekday_index(now.date_naive())],
            };
            let mut pattern = json!({ "kind": "weekly", "days": days });
            if let Some(interval) = spec.interval {
                if interval == 0 {
                    return Err("--interval must be at least 1".to_string());
                }
                pattern["everyNWeeks"] = json!(interval);
            }
            pattern
        }
        "month" | "monthly" => {
            reject_interval(spec, &rule)?;
            let day = match spec.on {
                Some(on) => parse_month_day(on)?,
                None => json!(1),
            };
            json!({ "kind": "monthly", "day": day })
        }
        other => {
            let every_n_days = parse_day_interval(other).ok_or_else(|| {
                format!(
                    "unknown recurrence '{}' (expected day, weekdays, week, month or Nd)",
                    spec.rule
                )
            })?;
            reject_on(spec, &rule)?;
            reject_interval(spec, &rule)?;
            json!({ "kind": "interval", "everyNDays": every_n_days })
        }
    };

    let mut rule_json = json!({
        "time": { "hour": hour, "minute": minute },
        "pattern": pattern,
    });
    if let Some(until) = spec.until {
        rule_json["endAt"] = json!(parse_at(until, now)?);
    }
    if let Some(max_runs) = spec.max_runs {
        if max_runs == 0 {
            return Err("--max-runs must be at least 1".to_string());
        }
        rule_json["maxRuns"] = json!(max_runs);
    }

    Ok(json!({ "kind": "recurring", "rule": rule_json }))
}

fn reject_on(spec: &EverySpec<'_>, rule: &str) -> Result<(), String> {
    if spec.on.is_some() {
        return Err(format!(
            "--on is not valid with --every {rule} (only with week or month)"
        ));
    }
    Ok(())
}

fn reject_interval(spec: &EverySpec<'_>, rule: &str) -> Result<(), String> {
    if spec.interval.is_some() {
        return Err(format!(
            "--interval is not valid with --every {rule} (only with week)"
        ));
    }
    Ok(())
}

/// `mon,wed` -> `[1, 3]` (sorted, de-duplicated).
fn parse_weekday_list(input: &str) -> Result<Vec<u32>, String> {
    let mut days: Vec<u32> = Vec::new();
    for part in input.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let day = parse_weekday(part)
            .ok_or_else(|| format!("'{part}' is not a weekday (use mon, tue, … sun)"))?;
        if !days.contains(&day) {
            days.push(day);
        }
    }
    if days.is_empty() {
        return Err("--on needs at least one weekday for --every week".to_string());
    }
    days.sort_unstable();
    Ok(days)
}

/// `1`..`28` or `last`.
fn parse_month_day(input: &str) -> Result<Value, String> {
    let raw = input.trim().to_ascii_lowercase();
    if raw == "last" {
        return Ok(json!("last"));
    }
    let day: u32 = raw
        .parse()
        .map_err(|_| format!("'{input}' is not a day of month (use 1..28 or 'last')"))?;
    if !(1..=28).contains(&day) {
        return Err(format!(
            "'{input}' is out of range for --every month (use 1..28 or 'last')"
        ));
    }
    Ok(json!(day))
}

/// `3d` -> `Some(3)`.
fn parse_day_interval(input: &str) -> Option<u32> {
    let digits = input.strip_suffix('d')?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: u32 = digits.parse().ok()?;
    if n == 0 {
        return None;
    }
    Some(n)
}

/// JavaScript weekday index (0 = Sunday) of a date.
fn weekday_index(date: NaiveDate) -> u32 {
    date.weekday().num_days_from_sunday()
}

/// Resolve a local wall-clock date/time to epoch milliseconds, tolerating DST
/// transitions (ambiguous times take the earlier offset, skipped times step
/// forward until they exist).
fn local_ms(now: DateTime<Local>, date: NaiveDate, hour: u32, minute: u32) -> Result<i64, String> {
    let tz = now.timezone();
    for extra in 0..4 {
        let naive = date
            .and_hms_opt(hour, minute, 0)
            .ok_or_else(|| format!("{hour:02}:{minute:02} is not a valid time"))?
            + Duration::minutes(extra * 30);
        match tz.from_local_datetime(&naive) {
            chrono::LocalResult::Single(dt) => return Ok(dt.timestamp_millis()),
            chrono::LocalResult::Ambiguous(earlier, _) => return Ok(earlier.timestamp_millis()),
            chrono::LocalResult::None => continue,
        }
    }
    Err(format!(
        "{date} {hour:02}:{minute:02} does not exist in the local timezone"
    ))
}

/// Parse a `--since` value to the epoch-millisecond start of the window: a
/// look-back duration (`7d`, `24h`, `2w`, `90m`), `today` / `yesterday`
/// (local midnight), a date (`YYYY-MM-DD`, local midnight), a local date-time
/// (`YYYY-MM-DDTHH:MM[:SS]` or with a space), an RFC 3339 timestamp with an
/// offset, or raw epoch milliseconds.
pub fn parse_since(input: &str, now: DateTime<Local>) -> Result<i64, String> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err("empty --since value".to_string());
    }
    if raw.len() >= 10 && raw.bytes().all(|b| b.is_ascii_digit()) {
        return parse_at(raw, now);
    }
    if !raw.bytes().all(|b| b.is_ascii_digit()) {
        if let Ok(delta) = parse_duration_ms(raw) {
            return Ok(now.timestamp_millis() - delta);
        }
    }
    match raw.to_ascii_lowercase().as_str() {
        "today" => return local_ms(now, now.date_naive(), 0, 0),
        "yesterday" => {
            let date = now
                .date_naive()
                .pred_opt()
                .ok_or_else(|| "date out of range".to_string())?;
            return local_ms(now, date, 0, 0);
        }
        _ => {}
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(raw) {
        return Ok(dt.timestamp_millis());
    }
    for format in ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S"] {
        if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(raw, format) {
            let ms = local_ms(now, naive.date(), naive.hour(), naive.minute())?;
            return Ok(ms + i64::from(naive.second()) * 1000);
        }
    }
    if let Ok(date) = NaiveDate::parse_from_str(raw, "%Y-%m-%d") {
        return local_ms(now, date, 0, 0);
    }
    if raw.get(..10).and_then(|head| NaiveDate::parse_from_str(head, "%Y-%m-%d").ok()).is_some() {
        return parse_at(raw, now);
    }
    Err(format!(
        "could not understand --since '{raw}' (use e.g. 7d, 24h, today, yesterday, 2026-10-27, 2026-10-27T09:00)"
    ))
}

/// Format an epoch-millisecond timestamp as local `YYYY-MM-DD HH:MM`.
pub fn format_local(at_ms: i64) -> String {
    match Local.timestamp_millis_opt(at_ms).single() {
        Some(dt) => dt.format("%Y-%m-%d %H:%M").to_string(),
        None => at_ms.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Timelike;

    /// Local hour/minute of an epoch-millisecond timestamp.
    fn hm(at_ms: i64) -> (u32, u32) {
        let dt = Local
            .timestamp_millis_opt(at_ms)
            .single()
            .expect("valid timestamp");
        (dt.hour(), dt.minute())
    }

    /// Fixed reference point: Thursday 2026-09-03, 14:30 local time.
    fn now() -> DateTime<Local> {
        Local
            .with_ymd_and_hms(2026, 9, 3, 14, 30, 0)
            .single()
            .expect("unambiguous local time")
    }

    fn ymd(at_ms: i64) -> (i32, u32, u32) {
        let dt = Local
            .timestamp_millis_opt(at_ms)
            .single()
            .expect("valid timestamp");
        (dt.year(), dt.month(), dt.day())
    }

    #[test]
    fn reference_now_is_a_thursday() {
        assert_eq!(weekday_index(now().date_naive()), 4);
    }

    #[test]
    fn parses_iso_date_with_default_time() {
        let at = parse_at("2026-09-10", now()).expect("parses");
        assert_eq!(ymd(at), (2026, 9, 10));
        assert_eq!(hm(at), (9, 0));
    }

    #[test]
    fn parses_iso_datetime_forms() {
        for input in ["2026-09-10T17:45", "2026-09-10 17:45", "2026-09-10t17:45"] {
            let at = parse_at(input, now()).expect("parses");
            assert_eq!(ymd(at), (2026, 9, 10), "{input}");
            assert_eq!(hm(at), (17, 45), "{input}");
        }
    }

    #[test]
    fn bare_time_in_the_future_is_today() {
        let at = parse_at("17:30", now()).expect("parses");
        assert_eq!(ymd(at), (2026, 9, 3));
        assert_eq!(hm(at), (17, 30));
    }

    #[test]
    fn bare_time_in_the_past_rolls_to_tomorrow() {
        let at = parse_at("09:00", now()).expect("parses");
        assert_eq!(ymd(at), (2026, 9, 4));
        assert_eq!(hm(at), (9, 0));
    }

    #[test]
    fn today_keyword_keeps_the_day_even_when_past() {
        let at = parse_at("today 09:00", now()).expect("parses");
        assert_eq!(ymd(at), (2026, 9, 3));
        assert_eq!(hm(at), (9, 0));
    }

    #[test]
    fn tomorrow_defaults_to_nine() {
        let at = parse_at("tomorrow", now()).expect("parses");
        assert_eq!(ymd(at), (2026, 9, 4));
        assert_eq!(hm(at), (9, 0));

        let at = parse_at("Tomorrow 06:15", now()).expect("parses");
        assert_eq!(ymd(at), (2026, 9, 4));
        assert_eq!(hm(at), (6, 15));
    }

    #[test]
    fn weekday_picks_the_next_occurrence() {
        // Thursday -> next Friday is tomorrow.
        let at = parse_at("fri 17:30", now()).expect("parses");
        assert_eq!(ymd(at), (2026, 9, 4));
        assert_eq!(hm(at), (17, 30));

        // Monday is next week.
        let at = parse_at("monday", now()).expect("parses");
        assert_eq!(ymd(at), (2026, 9, 7));
    }

    #[test]
    fn weekday_today_uses_today_when_time_is_ahead() {
        let at = parse_at("thu 23:00", now()).expect("parses");
        assert_eq!(ymd(at), (2026, 9, 3));

        // …and next week when it already passed.
        let at = parse_at("thu 09:00", now()).expect("parses");
        assert_eq!(ymd(at), (2026, 9, 10));
    }

    #[test]
    fn parses_epoch_millis() {
        let reference = now().timestamp_millis();
        let at = parse_at(&reference.to_string(), now()).expect("parses");
        assert_eq!(at, reference);
    }

    #[test]
    fn rejects_garbage_times() {
        for input in ["", "later", "25:00", "2026-13-01", "mon tue wed"] {
            assert!(parse_at(input, now()).is_err(), "{input} should not parse");
        }
    }

    #[test]
    fn parses_durations() {
        assert_eq!(parse_duration_ms("30m").expect("parses"), 30 * 60_000);
        assert_eq!(parse_duration_ms("2h").expect("parses"), 2 * 3_600_000);
        assert_eq!(parse_duration_ms("1h30m").expect("parses"), 90 * 60_000);
        assert_eq!(parse_duration_ms("3d").expect("parses"), 3 * 86_400_000);
        assert_eq!(parse_duration_ms("45").expect("parses"), 45 * 60_000);
    }

    #[test]
    fn rejects_bad_durations() {
        for input in ["", "h", "2x", "1h30", "0", "-5m"] {
            assert!(
                parse_duration_ms(input).is_err(),
                "{input} should not parse"
            );
        }
    }

    #[test]
    fn every_day_is_daily() {
        let spec = EverySpec {
            rule: "day",
            time: None,
            on: None,
            interval: None,
            until: None,
            max_runs: None,
        };
        let when = build_recurring_when(&spec, now()).expect("builds");
        assert_eq!(
            when,
            json!({
                "kind": "recurring",
                "rule": { "time": { "hour": 9, "minute": 0 }, "pattern": { "kind": "daily" } }
            })
        );
    }

    #[test]
    fn every_weekdays_is_monday_to_friday() {
        let spec = EverySpec {
            rule: "weekdays",
            time: Some("08:00"),
            on: None,
            interval: None,
            until: None,
            max_runs: None,
        };
        let when = build_recurring_when(&spec, now()).expect("builds");
        assert_eq!(when["rule"]["time"], json!({ "hour": 8, "minute": 0 }));
        assert_eq!(
            when["rule"]["pattern"],
            json!({ "kind": "weekly", "days": [1, 2, 3, 4, 5] })
        );
    }

    #[test]
    fn every_week_defaults_to_todays_weekday() {
        let spec = EverySpec {
            rule: "week",
            time: None,
            on: None,
            interval: None,
            until: None,
            max_runs: None,
        };
        let when = build_recurring_when(&spec, now()).expect("builds");
        // Reference now is a Thursday -> 4.
        assert_eq!(
            when["rule"]["pattern"],
            json!({ "kind": "weekly", "days": [4] })
        );
    }

    #[test]
    fn every_week_with_days_and_interval() {
        let spec = EverySpec {
            rule: "week",
            time: Some("10:00"),
            on: Some("wed,mon"),
            interval: Some(2),
            until: None,
            max_runs: Some(5),
        };
        let when = build_recurring_when(&spec, now()).expect("builds");
        assert_eq!(
            when["rule"]["pattern"],
            json!({ "kind": "weekly", "days": [1, 3], "everyNWeeks": 2 })
        );
        assert_eq!(when["rule"]["maxRuns"], json!(5));
    }

    #[test]
    fn every_month_accepts_last_and_numbers() {
        let base = EverySpec {
            rule: "month",
            time: Some("18:00"),
            on: Some("last"),
            interval: None,
            until: None,
            max_runs: None,
        };
        let when = build_recurring_when(&base, now()).expect("builds");
        assert_eq!(
            when["rule"]["pattern"],
            json!({ "kind": "monthly", "day": "last" })
        );

        let spec = EverySpec {
            on: Some("28"),
            ..base
        };
        let when = build_recurring_when(&spec, now()).expect("builds");
        assert_eq!(
            when["rule"]["pattern"],
            json!({ "kind": "monthly", "day": 28 })
        );

        let spec = EverySpec {
            on: Some("29"),
            ..base
        };
        assert!(build_recurring_when(&spec, now()).is_err());
    }

    #[test]
    fn every_n_days_is_an_interval() {
        let spec = EverySpec {
            rule: "3d",
            time: None,
            on: None,
            interval: None,
            until: Some("2026-10-01"),
            max_runs: None,
        };
        let when = build_recurring_when(&spec, now()).expect("builds");
        assert_eq!(
            when["rule"]["pattern"],
            json!({ "kind": "interval", "everyNDays": 3 })
        );
        let end_at = when["rule"]["endAt"].as_i64().expect("endAt is a number");
        assert_eq!(ymd(end_at), (2026, 10, 1));
    }

    #[test]
    fn interval_and_on_are_rejected_for_the_wrong_rules() {
        let spec = EverySpec {
            rule: "day",
            time: None,
            on: Some("mon"),
            interval: None,
            until: None,
            max_runs: None,
        };
        assert!(build_recurring_when(&spec, now()).is_err());

        let spec = EverySpec {
            rule: "month",
            time: None,
            on: None,
            interval: Some(2),
            until: None,
            max_runs: None,
        };
        assert!(build_recurring_when(&spec, now()).is_err());
    }

    #[test]
    fn unknown_recurrence_is_rejected() {
        let spec = EverySpec {
            rule: "fortnight",
            time: None,
            on: None,
            interval: None,
            until: None,
            max_runs: None,
        };
        assert!(build_recurring_when(&spec, now()).is_err());
    }

    #[test]
    fn since_accepts_durations_days_and_dates() {
        let n = now();
        assert_eq!(parse_since("7d", n).unwrap(), n.timestamp_millis() - 7 * 86_400_000);
        assert_eq!(parse_since("24h", n).unwrap(), n.timestamp_millis() - 86_400_000);
        let today = parse_since("today", n).unwrap();
        assert_eq!((ymd(today), hm(today)), ((2026, 9, 3), (0, 0)));
        let yesterday = parse_since("yesterday", n).unwrap();
        assert_eq!((ymd(yesterday), hm(yesterday)), ((2026, 9, 2), (0, 0)));
        let date = parse_since("2026-08-27", n).unwrap();
        assert_eq!((ymd(date), hm(date)), ((2026, 8, 27), (0, 0)));
        let datetime = parse_since("2026-08-27T13:45", n).unwrap();
        assert_eq!((ymd(datetime), hm(datetime)), ((2026, 8, 27), (13, 45)));
        let seconds = parse_since("2026-08-27T13:45:30", n).unwrap();
        assert_eq!(seconds - datetime, 30_000);
        assert_eq!(
            parse_since("2026-08-27T00:00:00Z", n).unwrap(),
            chrono::Utc
                .with_ymd_and_hms(2026, 8, 27, 0, 0, 0)
                .unwrap()
                .timestamp_millis()
        );
        assert!(parse_since("whenever", n).is_err());
    }

    #[test]
    fn when_at_shape() {
        assert_eq!(when_at(1756976400000), json!({ "kind": "at", "at": 1756976400000i64 }));
    }
}
