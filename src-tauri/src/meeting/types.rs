//! Wire/disk types for meetings (snake_case JSON, see docs/meeting-mode-spec.md).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MeetingStatus {
    Recording,
    Paused,
    Finalizing,
    Done,
    Interrupted,
}

impl MeetingStatus {
    /// A status that only a live process can hold; seen on startup it means the
    /// app died mid-meeting.
    pub fn is_live(self) -> bool {
        matches!(
            self,
            MeetingStatus::Recording | MeetingStatus::Paused | MeetingStatus::Finalizing
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingSources {
    pub mic: bool,
    pub system: bool,
    /// `"all"` | `"process"`
    pub system_target: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingMeta {
    pub id: String,
    pub title: String,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    pub status: MeetingStatus,
    pub repo_id: Option<String>,
    pub auto_repo: bool,
    pub context: Option<String>,
    pub summary: Option<String>,
    pub sources: MeetingSources,
    pub segment_count: u32,
    pub pending_segments: u32,
    pub failed_segments: u32,
    pub duration_secs: f64,
    /// Transcription vocabulary given at start (kept so finalize/retry after a
    /// restart can still prompt with it). Additive to the spec'd shape.
    #[serde(default)]
    pub vocabulary: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LineStatus {
    Pending,
    Ok,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptLine {
    pub seg_id: String,
    pub t0: f64,
    pub t1: f64,
    /// `me` | `them` | `them:<label>`
    pub speaker: String,
    pub text: String,
    pub status: LineStatus,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MeetingStartOpts {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub repo_id: Option<String>,
    #[serde(default)]
    pub auto_repo: bool,
    #[serde(default)]
    pub context: Option<String>,
    #[serde(default)]
    pub vocabulary: Option<Vec<String>>,
}

/// `meeting_update` patch. A present key with `null` clears optional fields.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct MeetingPatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub summary: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub repo_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub context: Option<Option<String>>,
}

fn double_option<'de, D>(d: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(d).map(Some)
}

#[derive(Debug, Clone, Serialize)]
pub struct MeetingDetail {
    pub meta: MeetingMeta,
    pub transcript: Vec<TranscriptLine>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AudioProcess {
    pub pid: u32,
    pub name: String,
}

// ---- event payloads ----

#[derive(Debug, Clone, Serialize)]
pub struct TranscriptEvent<'a> {
    pub meeting_id: &'a str,
    pub line: &'a TranscriptLine,
}

#[derive(Debug, Clone, Serialize)]
pub struct LevelEvent<'a> {
    pub meeting_id: &'a str,
    pub mic: f32,
    pub system: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct ErrorEvent<'a> {
    pub meeting_id: &'a str,
    pub message: String,
    pub seg_id: Option<&'a str>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patch_distinguishes_missing_and_null() {
        let p: MeetingPatch = serde_json::from_str(r#"{"summary": null, "title": "x"}"#).unwrap();
        assert_eq!(p.title.as_deref(), Some("x"));
        assert_eq!(p.summary, Some(None));
        assert_eq!(p.repo_id, None);
    }

    #[test]
    fn status_serializes_lowercase() {
        assert_eq!(serde_json::to_string(&MeetingStatus::Interrupted).unwrap(), "\"interrupted\"");
    }
}
