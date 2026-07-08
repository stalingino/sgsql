use tauri::Manager;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandChild;
use std::sync::Mutex;

mod keychain;
mod encrypted_store;
mod config;
#[cfg(target_os = "macos")]
mod macos_icon;

struct SidecarChild(Mutex<Option<CommandChild>>);
struct AppExiting(Mutex<bool>);

fn stop_managed_sidecar(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<SidecarChild>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(child) = guard.take() {
                log::info!("Application exiting — killing sidecar PID {}", child.pid());
                let _ = child.kill();
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        // tauri-plugin-store removed — using encrypted_store via keychain + AES-256-GCM
        .invoke_handler(tauri::generate_handler![
            keychain::keychain_set,
            keychain::keychain_get,
            keychain::keychain_delete,
            encrypted_store::encrypted_store_save,
            encrypted_store::encrypted_store_load,
            config::config_load,
            config::config_save,
        ])
        .setup(|app| {
            app.manage(AppExiting(Mutex::new(false)));

            #[cfg(target_os = "macos")]
            macos_icon::init(app.handle());

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // In dev mode, check if a sidecar is already running (e.g. `bun run sidecar/index.ts`)
            let dev_sidecar_running = if cfg!(debug_assertions) {
                match std::net::TcpStream::connect("127.0.0.1:45821") {
                    Ok(_) => {
                        log::info!("Dev sidecar already running on port 45821 — skipping spawn");
                        true
                    }
                    Err(_) => false,
                }
            } else {
                false
            };

            if dev_sidecar_running {
                // No child to manage — store None
                app.manage(SidecarChild(Mutex::new(None)));
            } else {
                // Spawn the compiled sidecar binary
                let sidecar_command = app.shell().sidecar("dbsidecar").unwrap();
                let (mut rx, child) = sidecar_command.spawn()
                    .expect("Failed to spawn sidecar");

                log::info!("Sidecar spawned with PID: {}", child.pid());

                // Store child handle so we can kill it on shutdown
                app.manage(SidecarChild(Mutex::new(Some(child))));

                // Log sidecar stdout/stderr in background
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    use tauri_plugin_shell::process::CommandEvent;
                    while let Some(event) = rx.recv().await {
                        match event {
                            CommandEvent::Stdout(line) => {
                                let line_str = String::from_utf8_lossy(&line);
                                log::info!("sidecar: {}", line_str);
                            }
                            CommandEvent::Stderr(line) => {
                                let line_str = String::from_utf8_lossy(&line);
                                log::warn!("sidecar stderr: {}", line_str);
                            }
                            CommandEvent::Terminated(status) => {
                                log::info!("sidecar terminated: {:?}", status);
                                break;
                            }
                            CommandEvent::Error(err) => {
                                log::error!("sidecar error: {}", err);
                                break;
                            }
                            _ => {}
                        }
                    }
                    let _ = app_handle;
                });
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // When the main window is closed, don't quit — open the connection manager instead.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let app = window.app_handle();

                    // If we're in the process of exiting, allow the close
                    if let Some(state) = app.try_state::<AppExiting>() {
                        if *state.0.lock().unwrap() {
                            return;
                        }
                    }

                    api.prevent_close();

                    // Show or create the connection-manager window
                    if let Some(cm) = app.webview_windows().get("connection-manager") {
                        let _ = cm.show();
                        let _ = cm.set_focus();
                    } else {
                        // Create connection-manager window
                        let _cm = tauri::WebviewWindowBuilder::new(
                            app,
                            "connection-manager",
                            tauri::WebviewUrl::App("connection-manager.html".into()),
                        )
                        .title("SGSql Connections")
                        .inner_size(740.0, 560.0)
                        .center()
                        .resizable(true)
                        .build();
                    }

                    let _ = window.hide();
                    return;
                }
            }

            if let tauri::WindowEvent::Destroyed = event {
                let app = window.app_handle();
                let windows = app.webview_windows();

                if windows.is_empty() {
                    // All windows gone — kill sidecar.
                    stop_managed_sidecar(app);
                } else {
                    // If every remaining window is hidden the user effectively quit
                    let all_hidden = windows
                        .values()
                        .all(|w| !w.is_visible().unwrap_or(true));
                    if all_hidden {
                        log::info!("Only hidden windows remain — exiting");
                        // Set the exiting flag so CloseRequested doesn't reopen conn manager
                        if let Some(state) = app.try_state::<AppExiting>() {
                            *state.0.lock().unwrap() = true;
                        }
                        for w in windows.values() {
                            let _ = w.destroy();
                        }
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::RunEvent::Ready) {
                macos_icon::refresh(app);
            }

            if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
                stop_managed_sidecar(app);
            }
        });
}
