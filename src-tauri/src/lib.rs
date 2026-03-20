use tauri::Manager;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandChild;
use std::sync::Mutex;

mod keychain;
mod encrypted_store;

struct SidecarChild(Mutex<Option<CommandChild>>);

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
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Spawn the Bun sidecar
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

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // Kill sidecar when window is destroyed
                if let Some(state) = window.try_state::<SidecarChild>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(child) = guard.take() {
                            log::info!("Killing sidecar on window close");
                            let _ = child.kill();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
