mod api_server;
mod clip_server;
mod commands;
mod panic_guard;
mod proxy;
mod types;

use panic_guard::run_guarded;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;

const APP_STATE_FILE_NAME: &str = "app-state.json";
const LEGACY_BUNDLE_ID: &str = "com.llmwiki.app";
const LEGACY_PRODUCT_NAME: &str = "LLM Wiki";
const CLOSE_BEHAVIOR_KEY: &str = "closeBehavior";
const LANGUAGE_KEY: &str = "language";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CloseBehavior {
    Hide,
    Quit,
}

impl CloseBehavior {
    fn as_str(self) -> &'static str {
        match self {
            CloseBehavior::Hide => "hide",
            CloseBehavior::Quit => "quit",
        }
    }
}

struct CloseBehaviorState(Mutex<CloseBehavior>);

impl CloseBehaviorState {
    fn new(initial: CloseBehavior) -> Self {
        Self(Mutex::new(initial))
    }

    fn get(&self) -> CloseBehavior {
        self.0
            .lock()
            .map(|behavior| *behavior)
            .unwrap_or(CloseBehavior::Hide)
    }

    fn set(&self, behavior: CloseBehavior) {
        if let Ok(mut current) = self.0.lock() {
            *current = behavior;
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TrayMenuLabels {
    show: &'static str,
    quit: &'static str,
}

#[tauri::command]
fn clip_server_status() -> String {
    run_guarded("clip_server_status", || {
        Ok(clip_server::get_daemon_status().to_string())
    })
    .unwrap_or_else(|e| format!("error: {e}"))
}

#[tauri::command]
fn api_server_status() -> String {
    run_guarded("api_server_status", || {
        Ok(api_server::get_api_status().to_string())
    })
    .unwrap_or_else(|e| format!("error: {e}"))
}

#[tauri::command]
fn api_server_reload_config() -> String {
    run_guarded("api_server_reload_config", || {
        api_server::invalidate_config_cache();
        Ok("ok".to_string())
    })
    .unwrap_or_else(|e| format!("error: {e}"))
}

#[tauri::command]
fn mcp_server_entry_path(app: tauri::AppHandle) -> Result<String, String> {
    run_guarded("mcp_server_entry_path", || {
        let relative = std::path::Path::new("mcp-server")
            .join("dist")
            .join("src")
            .join("index.js");
        let mut candidates = Vec::new();

        let mut push_repo_candidates = |base: std::path::PathBuf| {
            candidates.push(base.join(&relative));
            candidates.push(base.join("..").join(&relative));
            candidates.push(base.join("..").join("..").join(&relative));
        };

        push_repo_candidates(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")));
        if let Ok(cwd) = std::env::current_dir() {
            push_repo_candidates(cwd);
        }
        if let Ok(resource_dir) = app.path().resource_dir() {
            candidates.push(resource_dir.join(&relative));
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(exe_dir) = exe.parent() {
                candidates.push(exe_dir.join(&relative));
                candidates.push(exe_dir.join("..").join("Resources").join(&relative));
            }
        }

        for candidate in &candidates {
            if candidate.is_file() {
                return Ok(candidate
                    .canonicalize()
                    .unwrap_or_else(|_| candidate.clone())
                    .to_string_lossy()
                    .into_owned());
            }
        }

        Err("MCP server entry was not found. Run `npm run mcp:build` from the LLM Wiki repository, then reopen Settings.".to_string())
    })
}

/// Apply a proxy configuration to the process env immediately, so the
/// next outbound HTTP request picks it up without needing the user to
/// restart the app. tauri-plugin-http builds a fresh
/// `reqwest::ClientBuilder` per fetch and reqwest's `auto_sys_proxy`
/// re-reads HTTP_PROXY / HTTPS_PROXY / NO_PROXY each time, so updating
/// these env vars is sufficient to flip the proxy on/off live.
///
/// Returns the same human-readable summary `apply_proxy_env` produces
/// for logging.
#[tauri::command]
fn set_proxy_env(config: proxy::ProxyConfig) -> String {
    let summary = proxy::apply_proxy_env(&config);
    eprintln!("[proxy] live update: {summary}");
    summary
}

fn close_behavior_from_str(value: Option<&str>) -> CloseBehavior {
    match value {
        Some("quit") => CloseBehavior::Quit,
        _ => CloseBehavior::Hide,
    }
}

fn close_behavior_from_value(value: Option<&serde_json::Value>) -> CloseBehavior {
    close_behavior_from_str(value.and_then(serde_json::Value::as_str))
}

fn read_close_behavior_from_store(store_path: &Path) -> CloseBehavior {
    let Ok(raw) = std::fs::read_to_string(store_path) else {
        return CloseBehavior::Hide;
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return CloseBehavior::Hide;
    };
    close_behavior_from_value(parsed.get(CLOSE_BEHAVIOR_KEY))
}

fn normalize_tray_language(value: Option<&str>) -> &'static str {
    let Some(value) = value else {
        return "en";
    };
    let normalized = value.trim().to_ascii_lowercase();
    if normalized == "zh" || normalized.starts_with("zh-") {
        "zh"
    } else {
        "en"
    }
}

fn tray_menu_labels_for_language(value: Option<&str>) -> TrayMenuLabels {
    match normalize_tray_language(value) {
        "zh" => TrayMenuLabels {
            show: "显示",
            quit: "退出",
        },
        _ => TrayMenuLabels {
            show: "Show",
            quit: "Quit",
        },
    }
}

fn read_tray_labels_from_store(store_path: &Path) -> TrayMenuLabels {
    let Ok(raw) = std::fs::read_to_string(store_path) else {
        return tray_menu_labels_for_language(None);
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return tray_menu_labels_for_language(None);
    };
    tray_menu_labels_for_language(parsed.get(LANGUAGE_KEY).and_then(serde_json::Value::as_str))
}

#[tauri::command]
fn set_close_behavior(
    state: tauri::State<'_, CloseBehaviorState>,
    behavior: String,
) -> Result<String, String> {
    let normalized = close_behavior_from_str(Some(behavior.as_str()));
    state.set(normalized);
    Ok(normalized.as_str().to_string())
}

#[tauri::command]
fn set_tray_language(app: tauri::AppHandle, language: String) -> Result<String, String> {
    let normalized = normalize_tray_language(Some(language.as_str())).to_string();
    #[cfg(target_os = "macos")]
    update_macos_tray_language(&app, normalized.as_str()).map_err(|err| err.to_string())?;
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    Ok(normalized)
}

#[cfg(target_os = "macos")]
fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(target_os = "macos")]
fn build_macos_tray_menu<R, M>(
    manager: &M,
    labels: TrayMenuLabels,
) -> tauri::Result<tauri::menu::Menu<R>>
where
    R: tauri::Runtime,
    M: tauri::Manager<R>,
{
    use tauri::menu::{Menu, MenuItem};

    let show = MenuItem::with_id(manager, "show", labels.show, true, None::<&str>)?;
    let quit = MenuItem::with_id(manager, "quit", labels.quit, true, None::<&str>)?;
    Menu::with_items(manager, &[&show, &quit])
}

#[cfg(target_os = "macos")]
fn update_macos_tray_language<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    language: &str,
) -> tauri::Result<()> {
    if let Some(tray) = app.tray_by_id("main") {
        let menu = build_macos_tray_menu(app, tray_menu_labels_for_language(Some(language)))?;
        tray.set_menu(Some(menu))?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn setup_macos_tray(app: &mut tauri::App) -> tauri::Result<()> {
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let labels = app
        .path()
        .app_data_dir()
        .ok()
        .map(|dir| read_tray_labels_from_store(&dir.join(APP_STATE_FILE_NAME)))
        .unwrap_or_else(|| tray_menu_labels_for_language(None));
    let menu = build_macos_tray_menu(app, labels)?;

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("LLM Wiki Agent")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            if event.id() == "show" {
                show_main_window(app);
            } else if event.id() == "quit" {
                app.exit(0);
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon).icon_as_template(true);
    }

    tray.build(app)?;
    Ok(())
}

fn legacy_app_state_candidates(current_app_data_dir: &Path) -> Vec<PathBuf> {
    let Some(parent) = current_app_data_dir.parent() else {
        return Vec::new();
    };
    let mut candidates = vec![
        parent.join(LEGACY_BUNDLE_ID).join(APP_STATE_FILE_NAME),
        parent.join(LEGACY_PRODUCT_NAME).join(APP_STATE_FILE_NAME),
    ];
    candidates.dedup();
    candidates
}

fn migrate_legacy_app_state(current_app_data_dir: &Path) {
    let current_store = current_app_data_dir.join(APP_STATE_FILE_NAME);
    if current_store.exists() {
        return;
    }

    for legacy_store in legacy_app_state_candidates(current_app_data_dir) {
        if !legacy_store.is_file() {
            continue;
        }
        if let Err(err) = std::fs::create_dir_all(current_app_data_dir) {
            eprintln!("[app-state] could not create app data dir for migration: {err}");
            return;
        }
        match std::fs::copy(&legacy_store, &current_store) {
            Ok(_) => {
                eprintln!(
                    "[app-state] migrated legacy settings from {}",
                    legacy_store.display()
                );
            }
            Err(err) => {
                eprintln!(
                    "[app-state] could not migrate legacy settings from {}: {err}",
                    legacy_store.display()
                );
            }
        }
        return;
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    clip_server::start_clip_server();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        // Rust-backed fetch so third-party LLM APIs that reject
        // browser-origin headers via CORS preflight (MiniMax, Volcengine
        // Ark's api/coding/v3, etc.) still work. Requests leave the app
        // from Rust, never the webview.
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            // Let the PDF extractor find the bundled pdfium dynamic
            // library via Tauri's platform-correct resource path.
            use tauri::Manager;
            #[cfg(debug_assertions)]
            {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.set_title("[DEV] LLM Wiki Agent");
                }
            }
            if let Ok(dir) = app.path().resource_dir() {
                commands::fs::set_resource_dir_hint(dir);
            }
            // Apply user-configured global HTTP proxy by setting
            // HTTP_PROXY / HTTPS_PROXY / NO_PROXY env vars BEFORE
            // any HTTP request is made. tauri-plugin-http's reqwest
            // client reads these on first construction. Lives next
            // to the resource-dir hint so the proxy applies to
            // everything: LLM, embedding, update check, deep
            // research, captioning. See src-tauri/src/proxy.rs.
            let app_state_path = if let Ok(dir) = app.path().app_data_dir() {
                migrate_legacy_app_state(&dir);
                let store_path = dir.join(APP_STATE_FILE_NAME);
                eprintln!("[proxy] reading from {}", store_path.display());
                if let Some(cfg) = proxy::read_proxy_config_from_store(&store_path) {
                    let summary = proxy::apply_proxy_env(&cfg);
                    eprintln!("[proxy] {summary}");
                } else {
                    eprintln!("[proxy] no proxyConfig in store, requests go direct");
                }
                Some(store_path)
            } else {
                eprintln!("[proxy] could not resolve app_data_dir");
                None
            };
            let initial_close_behavior = app_state_path
                .as_deref()
                .map(read_close_behavior_from_store)
                .unwrap_or(CloseBehavior::Hide);
            app.manage(CloseBehaviorState::new(initial_close_behavior));
            // Registry of running `claude` subprocesses, keyed by the
            // frontend-generated stream id. Populated by claude_cli_spawn,
            // drained on process exit or by claude_cli_kill.
            app.manage(commands::claude_cli::ClaudeCliState::default());
            app.manage(commands::codex_cli::CodexCliState::default());
            app.manage(commands::file_sync::FileSyncState::default());
            app.manage(commands::file_sync::ProjectRootState::default());
            app.manage(commands::agent::AgentState::default());
            api_server::start_api_server(app.handle().clone());
            // Core-runtime background scheduler: reclaims runtime jobs stuck
            // `running` after their active lease expired (crashed worker,
            // stalled heartbeat). See SPEC-5-FIX PR3 /
            // commands::runtime_db::start_lease_reclaim_scheduler for why
            // this lives here rather than as a frontend timer.
            commands::runtime_db::start_lease_reclaim_scheduler(app.handle().clone());
            #[cfg(target_os = "macos")]
            if let Err(err) = setup_macos_tray(app) {
                eprintln!("[tray] could not initialize macOS tray; continuing without tray: {err}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::fs::read_file,
            commands::fs::write_file,
            commands::fs::write_file_base64,
            commands::fs::write_file_atomic,
            commands::fs::list_directory,
            commands::fs::copy_file,
            commands::fs::copy_directory,
            commands::fs::preprocess_file,
            commands::fs::delete_file,
            commands::fs::find_related_wiki_pages,
            commands::fs::create_directory,
            commands::fs::file_exists,
            commands::fs::canonicalize_path,
            commands::fs::get_file_modified_time,
            commands::fs::get_file_size,
            commands::fs::get_file_md5,
            commands::fs::read_file_as_base64,
            commands::project::create_project,
            commands::project::open_project,
            commands::project::open_project_folder,
            commands::runtime_db::runtime_commit_budget_claim,
            commands::runtime_db::runtime_commit_budget_list,
            commands::runtime_db::runtime_commit_budget_release,
            commands::runtime_db::runtime_db_health,
            commands::runtime_db::runtime_derived_stale_marker_list,
            commands::runtime_db::runtime_derived_stale_marker_record,
            commands::runtime_db::runtime_event_append,
            commands::runtime_db::runtime_job_cancel,
            commands::runtime_db::runtime_job_claim,
            commands::runtime_db::runtime_job_claim_by_kind,
            commands::runtime_db::runtime_job_complete,
            commands::runtime_db::runtime_job_create,
            commands::runtime_db::runtime_job_fail,
            commands::runtime_db::runtime_job_heartbeat,
            commands::runtime_db::runtime_job_list,
            commands::runtime_db::runtime_job_pause,
            commands::runtime_db::runtime_job_retry,
            commands::runtime_db::runtime_job_resume,
            commands::runtime_db::runtime_model_call_forward,
            commands::runtime_db::runtime_profile_create,
            commands::runtime_db::runtime_profile_delete,
            commands::runtime_db::runtime_profile_list,
            commands::runtime_db::runtime_profile_pool_claim,
            commands::runtime_db::runtime_profile_pool_list,
            commands::runtime_db::runtime_profile_pool_release,
            commands::runtime_db::runtime_profile_pool_renew,
            commands::runtime_db::runtime_profile_probe,
            commands::runtime_db::runtime_profile_status,
            commands::runtime_db::runtime_profile_update,
            commands::profile_secrets::profile_secret_delete,
            commands::profile_secrets::profile_secret_write,
            commands::runtime_db::runtime_progress_append,
            commands::runtime_db::runtime_progress_list,
            commands::runtime_db::runtime_staging_artifact_store,
            commands::runtime_db::runtime_staging_artifact_read_body,
            commands::runtime_db::runtime_staging_artifacts_clear_pending_for_job,
            commands::runtime_db::runtime_staging_artifact_commit_success,
            commands::runtime_db::runtime_staging_artifact_gc,
            commands::runtime_db::runtime_staging_artifact_list,
            commands::runtime_db::runtime_staging_artifact_record,
            commands::runtime_db::runtime_timeline_list,
            commands::search::search_project,
            clip_server_status,
            api_server_status,
            api_server_reload_config,
            mcp_server_entry_path,
            set_close_behavior,
            set_tray_language,
            commands::vectorstore::vector_upsert,
            commands::vectorstore::vector_search,
            commands::vectorstore::vector_delete,
            commands::vectorstore::vector_count,
            commands::vectorstore::vector_upsert_chunks,
            commands::vectorstore::vector_replace_all_chunks,
            commands::vectorstore::vector_search_chunks,
            commands::vectorstore::vector_delete_page,
            commands::vectorstore::vector_count_chunks,
            commands::vectorstore::vector_clear_chunks,
            commands::vectorstore::vector_optimize_chunks,
            commands::vectorstore::vector_legacy_row_count,
            commands::vectorstore::vector_drop_legacy,
            commands::claude_cli::claude_cli_detect,
            commands::claude_cli::claude_cli_spawn,
            commands::claude_cli::claude_cli_kill,
            commands::codex_cli::codex_cli_detect,
            commands::codex_cli::codex_cli_spawn,
            commands::codex_cli::codex_cli_kill,
            commands::agent::agent_detect,
            commands::agent::agent_spawn,
            commands::agent::agent_kill,
            commands::agent::agent_tool_response,
            commands::agent::agent_permission_response,
            commands::agent::agent_rewind_files,
            commands::extract_images::extract_pdf_images_cmd,
            commands::extract_images::extract_office_images_cmd,
            commands::extract_images::extract_and_save_pdf_images_cmd,
            commands::extract_images::extract_and_save_office_images_cmd,
            commands::file_sync::start_project_file_watcher,
            commands::file_sync::stop_project_file_watcher,
            commands::file_sync::rescan_project_files,
            commands::file_sync::get_file_change_queue,
            commands::file_sync::retry_file_change_task,
            commands::file_sync::ignore_file_change_task,
            set_proxy_env,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                #[cfg(target_os = "macos")]
                {
                    match window.app_handle().state::<CloseBehaviorState>().get() {
                        CloseBehavior::Quit => {
                            api.prevent_close();
                            window.app_handle().exit(0);
                        }
                        CloseBehavior::Hide => {
                            let _ = window.hide();
                            api.prevent_close();
                        }
                    }
                }

                #[cfg(not(target_os = "macos"))]
                {
                    use tauri::Manager;
                    api.prevent_close();
                    let win = window.clone();
                    let app = window.app_handle().clone();
                    tauri::async_runtime::spawn(async move {
                        use tauri_plugin_dialog::DialogExt;
                        let confirmed = app
                            .dialog()
                            .message("Are you sure you want to quit LLM Wiki Agent?")
                            .title("Confirm Exit")
                            .kind(tauri_plugin_dialog::MessageDialogKind::Warning)
                            .blocking_show();

                        if confirmed {
                            let _ = win.destroy();
                        }
                    });
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } = event
            {
                if !has_visible_windows {
                    use tauri::Manager;
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
            let _ = (app, event); // suppress unused warnings on non-macOS
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_store_path(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before Unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "llm-wiki-close-behavior-{label}-{}-{nanos}.json",
            std::process::id()
        ))
    }

    #[test]
    fn legacy_app_state_candidates_use_current_parent() {
        let current =
            Path::new("/Users/example/Library/Application Support/com.6tizer.llmwiki.agent");

        assert_eq!(
            legacy_app_state_candidates(current),
            vec![
                PathBuf::from(
                    "/Users/example/Library/Application Support/com.llmwiki.app/app-state.json"
                ),
                PathBuf::from("/Users/example/Library/Application Support/LLM Wiki/app-state.json"),
            ]
        );
    }

    #[test]
    fn close_behavior_defaults_to_hide_for_absent_or_invalid_values() {
        assert_eq!(close_behavior_from_value(None), CloseBehavior::Hide);
        assert_eq!(
            close_behavior_from_value(Some(&serde_json::json!("ask"))),
            CloseBehavior::Hide
        );
        assert_eq!(
            close_behavior_from_value(Some(&serde_json::json!("minimize"))),
            CloseBehavior::Hide
        );
    }

    #[test]
    fn close_behavior_accepts_hide_and_quit_only() {
        assert_eq!(
            close_behavior_from_value(Some(&serde_json::json!("hide"))),
            CloseBehavior::Hide
        );
        assert_eq!(
            close_behavior_from_value(Some(&serde_json::json!("quit"))),
            CloseBehavior::Quit
        );
    }

    #[test]
    fn read_close_behavior_from_store_defaults_to_hide_for_absent_or_invalid_store() {
        let missing = temp_store_path("missing");
        assert_eq!(
            read_close_behavior_from_store(&missing),
            CloseBehavior::Hide
        );

        let invalid_json = temp_store_path("invalid-json");
        fs::write(&invalid_json, "{").expect("write invalid json store");
        assert_eq!(
            read_close_behavior_from_store(&invalid_json),
            CloseBehavior::Hide
        );
        let _ = fs::remove_file(invalid_json);

        let invalid_value = temp_store_path("invalid-value");
        fs::write(&invalid_value, r#"{"closeBehavior":"ask"}"#)
            .expect("write invalid close behavior store");
        assert_eq!(
            read_close_behavior_from_store(&invalid_value),
            CloseBehavior::Hide
        );
        let _ = fs::remove_file(invalid_value);
    }

    #[test]
    fn read_close_behavior_from_store_accepts_hide_and_quit() {
        let hide = temp_store_path("hide");
        fs::write(&hide, r#"{"closeBehavior":"hide"}"#).expect("write hide store");
        assert_eq!(read_close_behavior_from_store(&hide), CloseBehavior::Hide);
        let _ = fs::remove_file(hide);

        let quit = temp_store_path("quit");
        fs::write(&quit, r#"{"closeBehavior":"quit"}"#).expect("write quit store");
        assert_eq!(read_close_behavior_from_store(&quit), CloseBehavior::Quit);
        let _ = fs::remove_file(quit);
    }

    #[test]
    fn close_behavior_state_caches_and_updates_value() {
        let state = CloseBehaviorState::new(CloseBehavior::Hide);
        assert_eq!(state.get(), CloseBehavior::Hide);
        state.set(CloseBehavior::Quit);
        assert_eq!(state.get(), CloseBehavior::Quit);
    }

    #[test]
    fn tray_language_normalization_accepts_zh_family_only() {
        assert_eq!(normalize_tray_language(Some("zh")), "zh");
        assert_eq!(normalize_tray_language(Some("zh-CN")), "zh");
        assert_eq!(normalize_tray_language(Some("ZH-Hant")), "zh");
        assert_eq!(normalize_tray_language(Some("en")), "en");
        assert_eq!(normalize_tray_language(Some("ja")), "en");
        assert_eq!(normalize_tray_language(Some("")), "en");
        assert_eq!(normalize_tray_language(None), "en");
    }

    #[test]
    fn tray_labels_follow_normalized_language() {
        assert_eq!(
            tray_menu_labels_for_language(Some("zh-CN")),
            TrayMenuLabels {
                show: "显示",
                quit: "退出",
            }
        );
        assert_eq!(
            tray_menu_labels_for_language(Some("en")),
            TrayMenuLabels {
                show: "Show",
                quit: "Quit",
            }
        );
    }

    #[test]
    fn read_tray_labels_from_store_defaults_to_english_for_missing_or_invalid_store() {
        let missing = temp_store_path("tray-missing");
        assert_eq!(
            read_tray_labels_from_store(&missing),
            TrayMenuLabels {
                show: "Show",
                quit: "Quit",
            }
        );

        let invalid_json = temp_store_path("tray-invalid-json");
        fs::write(&invalid_json, "{").expect("write invalid json store");
        assert_eq!(
            read_tray_labels_from_store(&invalid_json),
            TrayMenuLabels {
                show: "Show",
                quit: "Quit",
            }
        );
        let _ = fs::remove_file(invalid_json);
    }

    #[test]
    fn read_tray_labels_from_store_uses_persisted_language() {
        let zh = temp_store_path("tray-zh");
        fs::write(&zh, r#"{"language":"zh-CN"}"#).expect("write zh store");
        assert_eq!(
            read_tray_labels_from_store(&zh),
            TrayMenuLabels {
                show: "显示",
                quit: "退出",
            }
        );
        let _ = fs::remove_file(zh);

        let en = temp_store_path("tray-en");
        fs::write(&en, r#"{"language":"en"}"#).expect("write en store");
        assert_eq!(
            read_tray_labels_from_store(&en),
            TrayMenuLabels {
                show: "Show",
                quit: "Quit",
            }
        );
        let _ = fs::remove_file(en);
    }
}
