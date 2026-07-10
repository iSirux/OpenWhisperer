//! UI-facing configuration: theme, overlay, system tray, session view/list options.

use serde::{Deserialize, Deserializer, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OverlayConfig {
    #[serde(default = "default_show_when_focused")]
    pub show_when_focused: bool,
    #[serde(default)]
    pub position_x: Option<i32>,
    #[serde(default)]
    pub position_y: Option<i32>,
    #[serde(default = "default_show_active_sessions")]
    pub show_active_sessions: bool,
}

fn default_show_when_focused() -> bool {
    true
}

fn default_show_active_sessions() -> bool {
    true
}

impl Default for OverlayConfig {
    fn default() -> Self {
        Self {
            show_when_focused: default_show_when_focused(),
            position_x: None,
            position_y: None,
            show_active_sessions: default_show_active_sessions(),
        }
    }
}

/// Terminal emulator preference for launch profiles (Windows only)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub enum LaunchTerminal {
    #[default]
    Cmd,
    #[serde(alias = "pwsh")]
    PowerShell,
    #[serde(alias = "wt")]
    WindowsTerminal,
}

/// How the app handles application updates on startup.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub enum UpdateCheckMode {
    /// Never check automatically (manual check in Settings → About still works)
    Off,
    /// Check on startup and surface an "update available" indicator
    #[default]
    Notify,
    /// Check on startup and install immediately (app restarts during install)
    Auto,
}

/// System/tray/autostart configuration. All fields default to Rust zero-values
/// (or the field type's own `Default`), so a single `#[derive(Default)]` is the
/// sole source of truth.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct SystemConfig {
    pub minimize_to_tray: bool,
    pub start_minimized: bool,
    pub autostart: bool,
    /// Preferred terminal emulator for launch profiles
    pub launch_terminal: LaunchTerminal,
    /// Developer mode: surfaces debug-only features such as the recordings log.
    pub dev_mode: bool,
    /// Hide all voice/recording features (no-voice mode).
    pub voice_mode_disabled: bool,
    /// Application update behavior on startup
    pub update_check: UpdateCheckMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionPersistenceConfig {
    #[serde(default = "default_persistence_enabled")]
    pub enabled: bool,
    #[serde(default = "default_max_sessions")]
    pub max_sessions: usize,
    #[serde(default = "default_restore_sessions")]
    pub restore_sessions: usize,
    #[serde(default = "default_max_archived_sessions")]
    pub max_archived_sessions: usize,
}

fn default_persistence_enabled() -> bool {
    true
}

fn default_max_sessions() -> usize {
    50
}

fn default_restore_sessions() -> usize {
    10
}

fn default_max_archived_sessions() -> usize {
    500
}

impl Default for SessionPersistenceConfig {
    fn default() -> Self {
        Self {
            enabled: default_persistence_enabled(),
            max_sessions: default_max_sessions(),
            restore_sessions: default_restore_sessions(),
            max_archived_sessions: default_max_archived_sessions(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub enum Theme {
    #[default]
    Midnight,
    Slate,
    Void,
    Ember,
    Forest,
    Ocean,
    Rose,
    Storm,
    Aurora,
    Pearl,
    Latte,
}

impl Theme {
    /// Every theme variant. The exhaustive match makes the compiler flag this
    /// list whenever a variant is added or removed, so it can never drift.
    pub fn all() -> Vec<Theme> {
        // The match below exists solely to force exhaustiveness at compile time.
        fn _assert_exhaustive(t: &Theme) {
            match t {
                Theme::Midnight
                | Theme::Slate
                | Theme::Void
                | Theme::Ember
                | Theme::Forest
                | Theme::Ocean
                | Theme::Rose
                | Theme::Storm
                | Theme::Aurora
                | Theme::Pearl
                | Theme::Latte => {}
            }
        }
        vec![
            Theme::Midnight,
            Theme::Slate,
            Theme::Void,
            Theme::Ember,
            Theme::Forest,
            Theme::Ocean,
            Theme::Rose,
            Theme::Storm,
            Theme::Aurora,
            Theme::Pearl,
            Theme::Latte,
        ]
    }

    /// Serialized names of all valid themes, derived from the enum itself so the
    /// migration/validation list can never fall out of sync with the variants.
    pub fn valid_names() -> Vec<String> {
        Self::all()
            .iter()
            .filter_map(|t| match serde_json::to_value(t) {
                Ok(serde_json::Value::String(s)) => Some(s),
                _ => None,
            })
            .collect()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub enum SessionSortOrder {
    #[default]
    Chronological,
    StatusThenChronological,
}

/// Sessions view layout type
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum SessionsViewLayout {
    #[default]
    List,
    Grid,
}

/// Grid card size options
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum SessionsGridSize {
    Small,
    #[default]
    Medium,
    Large,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionsViewConfig {
    #[serde(default)]
    pub layout: SessionsViewLayout,
    #[serde(default = "default_grid_columns")]
    pub grid_columns: usize,
    #[serde(default)]
    pub card_size: SessionsGridSize,
}

fn default_grid_columns() -> usize {
    3
}

/// Editor-group pane layout for the main session view.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaneLayoutConfig {
    #[serde(default)]
    pub assignments: Vec<Option<String>>,
    #[serde(default)]
    pub focused_index: usize,
}

impl Default for SessionsViewConfig {
    fn default() -> Self {
        Self {
            layout: SessionsViewLayout::default(),
            grid_columns: default_grid_columns(),
            card_size: SessionsGridSize::default(),
        }
    }
}

/// Effort level for reasoning depth control
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum EffortLevel {
    #[default]
    Off,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

/// Resilient deserializer for EffortLevel that maps legacy/unknown values
/// instead of failing the entire config parse.
/// Legacy mappings: "on"/"think" → High, "megathink" → Xhigh, "ultrathink" → Max
impl<'de> Deserialize<'de> for EffortLevel {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        Ok(match s.to_lowercase().as_str() {
            "off" => EffortLevel::Off,
            "low" => EffortLevel::Low,
            "medium" => EffortLevel::Medium,
            "high" => EffortLevel::High,
            "xhigh" => EffortLevel::Xhigh,
            "max" => EffortLevel::Max,
            // Legacy thinking level values
            "on" | "think" => {
                log::error!("[config] Migrating legacy effort value '{}' → High", s);
                EffortLevel::High
            }
            "megathink" => {
                log::error!("[config] Migrating legacy effort value 'megathink' → Xhigh");
                EffortLevel::Xhigh
            }
            "ultrathink" => {
                log::error!("[config] Migrating legacy effort value 'ultrathink' → Max");
                EffortLevel::Max
            }
            other => {
                log::error!(
                    "[config] Unknown effort level '{}', defaulting to Off",
                    other
                );
                EffortLevel::Off
            }
        })
    }
}

/// Tool call display mode in SDK view
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ToolDisplayMode {
    #[default]
    List,
    Grid,
}
