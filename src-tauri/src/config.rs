use tauri::Manager;

#[tauri::command]
pub async fn config_load(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("sgsql-config.json");

    if !path.exists() {
        return Ok(serde_json::Value::Object(Default::default()));
    }

    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn config_save(
    app: tauri::AppHandle,
    data: serde_json::Value,
) -> Result<(), String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("sgsql-config.json");

    let content = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    std::fs::write(&path, content).map_err(|e| e.to_string())
}
