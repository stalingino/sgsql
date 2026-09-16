use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;

#[tauri::command]
pub async fn export_write(path: String, content: String, append: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(path);
        if !path.is_absolute() {
            return Err("Export path must be absolute".to_string());
        }
        let mut options = OpenOptions::new();
        options.create(true).write(true);
        if append {
            options.append(true);
        } else {
            options.truncate(true);
        }
        let mut file = options.open(path).map_err(|error| error.to_string())?;
        file.write_all(content.as_bytes())
            .map_err(|error| error.to_string())?;
        file.flush().map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}
