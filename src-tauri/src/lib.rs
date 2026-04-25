mod archive;
mod commands;
mod config;
mod git;
mod launch;
mod llm;
mod realtime;
mod sequences;
mod session_persistence;
mod sidecar;
mod terminal;
mod whisper;

use commands::{
    archive_cmds, audio_cmds, git_cmds, input_cmds, launch_cmds, llm_cmds, log_cmds, mcp_cmds,
    realtime_cmds, sdk_cmds, sequence_cmds, session_cmds, settings_cmds, terminal_cmds, usage_cmds,
};
use config::{AppConfig, UsageStats};
use parking_lot::Mutex;
use realtime::RealtimeSessionManager;
use sequences::SequenceManager;
use sidecar::SidecarManager;
use std::sync::Arc;

/// Tracks whether config was successfully loaded from disk.
/// When false, saves are blocked to prevent overwriting valid config with defaults.
pub struct ConfigLoadStatus(pub Mutex<bool>);
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    Manager, WindowEvent,
};
use tauri_plugin_autostart::MacosLauncher;
use terminal::TerminalManager;

#[cfg(target_os = "windows")]
fn set_windows_app_user_model_id(app_id: &str) {
    use std::ffi::OsStr;
    use std::iter;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;

    let app_id_wide: Vec<u16> = OsStr::new(app_id)
        .encode_wide()
        .chain(iter::once(0))
        .collect();

    // Best-effort call: failing here should not block app startup.
    unsafe {
        let _ = SetCurrentProcessExplicitAppUserModelID(app_id_wide.as_ptr());
    }
}

#[tauri::command]
fn get_autostart_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch()
        .is_enabled()
        .map_err(|e| format!("Failed to get autostart status: {}", e))
}

#[tauri::command]
fn toggle_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let autostart = app.autolaunch();
    if enabled {
        autostart
            .enable()
            .map_err(|e| format!("Failed to enable autostart: {}", e))
    } else {
        autostart
            .disable()
            .map_err(|e| format!("Failed to disable autostart: {}", e))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let (config, config_loaded_ok) = AppConfig::load();
    let usage_stats = UsageStats::load();
    let start_minimized = config.system.start_minimized;
    let terminal_manager = Arc::new(TerminalManager::new());
    let sidecar_manager = Arc::new(SidecarManager::new());
    let realtime_manager = Arc::new(RealtimeSessionManager::new());
    let launch_manager = Arc::new(launch::LaunchManager::new());
    let config_load_status = ConfigLoadStatus(Mutex::new(config_loaded_ok));

    // Set up backend file logging via tauri-plugin-log (date-stamped, 7-day rolling)
    let log_dir = commands::log_cmds::logs_dir();
    let _ = std::fs::create_dir_all(&log_dir);
    // Cleanup is also done inside init_frontend_logger(); calling it here ensures
    // backend-side old files are pruned even before the FrontendLogger is initialised.
    commands::log_cmds::cleanup_old_logs(&log_dir);
    let today = chrono::Local::now().format("%Y-%m-%d");
    let backend_log_name: String = if cfg!(debug_assertions) {
        format!("backend-dev-{}", today)
    } else {
        format!("backend-{}", today)
    };

    let builder = tauri::Builder::default();

    // Register the log plugin first so all subsequent plugin/setup logs are captured
    let builder = builder.plugin(
        tauri_plugin_log::Builder::new()
            .level(log::LevelFilter::Info)
            .target(tauri_plugin_log::Target::new(
                tauri_plugin_log::TargetKind::Folder {
                    path: log_dir,
                    file_name: Some(backend_log_name),
                },
            ))
            // Size cap per-file just in case the app runs for many days without a restart
            .max_file_size(50_000_000)
            .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
            .build(),
    );

    // Only enforce single instance in release builds - allows running debug and release simultaneously
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        // Another instance tried to start - focus the existing window
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }));

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_keyring::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_denylist(&["overlay"])
                // Use separate window state files for dev and production to allow different layouts
                .with_filename(if cfg!(debug_assertions) {
                    ".window-state-dev.json"
                } else {
                    ".window-state.json"
                })
                .build(),
        )
        .manage(Mutex::new(config))
        .manage(Mutex::new(usage_stats))
        .manage(config_load_status)
        .manage(terminal_manager)
        .manage(sidecar_manager)
        .manage(realtime_manager)
        .manage(launch_manager)
        .manage(log_cmds::init_frontend_logger())
        .setup(move |app| {
            #[cfg(target_os = "windows")]
            set_windows_app_user_model_id(&app.config().identifier);

            // Explicitly set the main window icon so the taskbar icon survives
            // icon-cache invalidation, explorer.exe restarts, and dev rebuilds.
            if let Some(main_window) = app.get_webview_window("main") {
                if let Ok(win_icon) = Image::from_bytes(include_bytes!("../icons/icon.ico"))
                    .or_else(|_| Image::from_bytes(include_bytes!("../icons/128x128.png")))
                {
                    let _ = main_window.set_icon(win_icon);
                }
            }

            // Build tray menu
            let show_item = MenuItemBuilder::new("Show").id("show").build(app)?;
            let quit_item = MenuItemBuilder::new("Quit").id("quit").build(app)?;

            let menu = MenuBuilder::new(app)
                .item(&show_item)
                .separator()
                .item(&quit_item)
                .build()?;

            // Load tray icon from embedded bytes
            let icon = Image::from_bytes(include_bytes!("../icons/icon.ico"))
                .or_else(|_| Image::from_bytes(include_bytes!("../icons/32x32.png")))
                .map_err(|e| format!("Failed to load tray icon: {}", e))?;

            // Create tray icon with ID for cleanup
            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(icon)
                .menu(&menu)
                .tooltip("Claude Whisperer")
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            // Properly shutdown before quitting
                            let sidecar: tauri::State<Arc<SidecarManager>> = app.state();
                            sidecar.shutdown();
                            let launch_mgr: tauri::State<Arc<launch::LaunchManager>> = app.state();
                            launch_mgr.stop_all_repos();
                            // Remove tray icon before exit to prevent orphaned icon on Windows
                            if let Some(tray) = app.tray_by_id("main-tray") {
                                let _ = tray.set_visible(false);
                            }
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click { button, .. } = event {
                        if button == tauri::tray::MouseButton::Left {
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            // Start minimized only when launched via autostart (--minimized flag)
            let args: Vec<String> = std::env::args().collect();
            let should_minimize = start_minimized && args.contains(&"--minimized".to_string());

            if should_minimize {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }

            // Initialize sequence manager
            let sidecar_for_seq: tauri::State<Arc<SidecarManager>> = app.state();
            let (max_prompts, provider_rpm) = {
                let cfg: tauri::State<parking_lot::Mutex<AppConfig>> = app.state();
                let c = cfg.lock();
                (
                    c.sequences.max_concurrent_prompts,
                    c.sequences.default_provider_rpm,
                )
            };
            let sequence_manager = Arc::new(SequenceManager::new(
                app.handle().clone(),
                sidecar_for_seq.inner().clone(),
                max_prompts,
                provider_rpm,
            ));
            // Load sequence definitions
            if let Err(e) = sequence_manager.load_definitions() {
                log::error!("[sequences] Failed to load definitions: {}", e);
            }
            let sequence_manager_for_scheduler = sequence_manager.clone();
            let sequence_manager_for_triggers = sequence_manager.clone();
            app.manage(sequence_manager);

            // Initialize sequence scheduler
            let scheduler = Arc::new(sequences::scheduler::SequenceScheduler::new());
            scheduler.start(sequence_manager_for_scheduler);
            // Start event trigger listeners
            sequence_manager_for_triggers
                .event_trigger_manager
                .start(app.handle(), sequence_manager_for_triggers.clone());
            app.manage(scheduler);

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let config: tauri::State<Mutex<AppConfig>> = app.state();
                let minimize_to_tray = config.lock().system.minimize_to_tray;

                if window.label() == "main" {
                    if minimize_to_tray {
                        // Prevent the window from closing, just hide it
                        api.prevent_close();
                        let _ = window.hide();
                    } else {
                        // Actually quit the app when closing and not minimizing to tray
                        let sidecar: tauri::State<Arc<SidecarManager>> = app.state();
                        sidecar.shutdown();
                        let launch_mgr: tauri::State<Arc<launch::LaunchManager>> = app.state();
                        launch_mgr.stop_all_repos();
                        // Remove tray icon before exit to prevent orphaned icon on Windows
                        if let Some(tray) = app.tray_by_id("main-tray") {
                            let _ = tray.set_visible(false);
                        }
                        app.exit(0);
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            settings_cmds::get_config,
            settings_cmds::get_config_load_status,
            settings_cmds::get_config_paths,
            settings_cmds::open_config_file,
            settings_cmds::open_config_folder,
            settings_cmds::save_config,
            settings_cmds::add_repo,
            settings_cmds::remove_repo,
            settings_cmds::set_active_repo,
            settings_cmds::set_repo_active,
            settings_cmds::set_auto_repo_mode,
            settings_cmds::get_active_repo,
            settings_cmds::get_git_branch,
            settings_cmds::run_in_terminal,
            git_cmds::list_git_worktrees,
            git_cmds::create_git_worktree_with_setup,
            git_cmds::create_git_worktree_only,
            git_cmds::run_worktree_post_setup,
            git_cmds::generate_worktree_branch_name,
            git_cmds::open_in_vscode,
            git_cmds::open_in_terminal,
            terminal_cmds::create_terminal_session,
            terminal_cmds::create_interactive_session,
            terminal_cmds::write_to_terminal,
            terminal_cmds::resize_terminal,
            terminal_cmds::close_terminal,
            terminal_cmds::get_terminal_sessions,
            terminal_cmds::get_terminal_session,
            audio_cmds::transcribe_audio,
            audio_cmds::test_whisper_connection,
            sdk_cmds::start_sidecar,
            sdk_cmds::create_sdk_session,
            sdk_cmds::send_sdk_prompt,
            sdk_cmds::stop_sdk_query,
            sdk_cmds::update_sdk_model,
            sdk_cmds::update_sdk_effort,
            sdk_cmds::update_sdk_autocompact_pct,
            sdk_cmds::close_sdk_session,
            sdk_cmds::answer_ask_user_question,
            sdk_cmds::answer_plan_approval,
            sdk_cmds::generate_repo_description_with_claude,
            sdk_cmds::generate_repo_description_with_codex,
            sdk_cmds::generate_launch_profile_with_claude,
            sdk_cmds::generate_launch_profile_with_codex,
            sdk_cmds::check_openai_codex_auth,
            sdk_cmds::run_codex_login,
            sdk_cmds::save_openai_api_key,
            sdk_cmds::has_openai_api_key,
            sdk_cmds::delete_openai_api_key,
            sdk_cmds::check_claude_auth,
            sdk_cmds::save_claude_api_key,
            sdk_cmds::has_claude_api_key,
            sdk_cmds::delete_claude_api_key,
            sdk_cmds::fetch_claude_rate_limits,
            sdk_cmds::fetch_codex_rate_limits,
            session_cmds::get_persisted_sessions,
            session_cmds::save_persisted_sessions,
            session_cmds::clear_persisted_sessions,
            archive_cmds::get_archive_entries,
            archive_cmds::get_archive_entry_data,
            archive_cmds::archive_sdk_session,
            archive_cmds::archive_terminal_session,
            archive_cmds::archive_sequence_execution,
            archive_cmds::unarchive_entry,
            archive_cmds::delete_archive_entry,
            archive_cmds::clear_archive,
            archive_cmds::trim_archive,
            archive_cmds::get_archive_count,
            usage_cmds::get_usage_stats,
            usage_cmds::track_session,
            usage_cmds::track_prompt,
            usage_cmds::track_tool_call,
            usage_cmds::track_recording,
            usage_cmds::track_transcription,
            usage_cmds::track_token_usage,
            usage_cmds::track_llm_token_usage,
            usage_cmds::reset_usage_stats,
            get_autostart_enabled,
            toggle_autostart,
            input_cmds::paste_text,
            input_cmds::copy_selection,
            llm_cmds::test_gemini_connection,
            llm_cmds::generate_session_name,
            llm_cmds::generate_session_outcome,
            llm_cmds::analyze_interaction_needed,
            llm_cmds::clean_transcription,
            llm_cmds::recommend_model,
            llm_cmds::save_gemini_api_key,
            llm_cmds::has_gemini_api_key,
            llm_cmds::delete_gemini_api_key,
            llm_cmds::recommend_repo,
            llm_cmds::generate_quick_actions,
            realtime_cmds::test_realtime_connection,
            realtime_cmds::start_realtime_session,
            realtime_cmds::send_realtime_audio,
            realtime_cmds::stop_realtime_session,
            launch_cmds::scan_repo_launch_commands,
            launch_cmds::launch_profile,
            launch_cmds::launch_commands,
            launch_cmds::stop_launch_profile,
            launch_cmds::get_launch_status,
            mcp_cmds::test_mcp_server,
            mcp_cmds::save_mcp_bearer_token,
            mcp_cmds::get_mcp_bearer_token,
            mcp_cmds::delete_mcp_bearer_token,
            mcp_cmds::has_mcp_token,
            mcp_cmds::start_mcp_oauth_flow,
            mcp_cmds::exchange_mcp_oauth_code,
            mcp_cmds::refresh_mcp_oauth_tokens,
            mcp_cmds::get_mcp_oauth_tokens,
            mcp_cmds::delete_mcp_oauth_tokens,
            mcp_cmds::get_mcp_auth_header,
            sequence_cmds::list_sequences,
            sequence_cmds::get_sequence,
            sequence_cmds::save_sequence,
            sequence_cmds::delete_sequence,
            sequence_cmds::import_sequence,
            sequence_cmds::export_sequence,
            sequence_cmds::validate_sequence,
            sequence_cmds::start_execution,
            sequence_cmds::get_execution,
            sequence_cmds::list_executions,
            sequence_cmds::dismiss_execution,
            sequence_cmds::pause_execution,
            sequence_cmds::resume_execution,
            sequence_cmds::cancel_execution,
            sequence_cmds::approve_node,
            sequence_cmds::reject_node,
            sequence_cmds::retry_node,
            sequence_cmds::test_notification_channel,
            sequence_cmds::list_schedules,
            sequence_cmds::toggle_schedule,
            sequence_cmds::list_event_triggers,
            sequence_cmds::generate_sequence_yaml,
            sequence_cmds::generate_node_config,
            log_cmds::write_frontend_log,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
