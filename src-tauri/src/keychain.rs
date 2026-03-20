use keyring::Entry;

const SERVICE_NAME: &str = "com.sgsql.desktop";

fn entry_for(connection_id: &str) -> Result<Entry, String> {
    Entry::new(SERVICE_NAME, connection_id).map_err(|e| format!("Keychain error: {e}"))
}

#[tauri::command]
pub fn keychain_set(connection_id: String, password: String) -> Result<(), String> {
    let entry = entry_for(&connection_id)?;
    entry
        .set_password(&password)
        .map_err(|e| format!("Failed to store password: {e}"))
}

#[tauri::command]
pub fn keychain_get(connection_id: String) -> Result<String, String> {
    let entry = entry_for(&connection_id)?;
    match entry.get_password() {
        Ok(pw) => Ok(pw),
        Err(keyring::Error::NoEntry) => Ok(String::new()),
        Err(e) => Err(format!("Failed to read password: {e}")),
    }
}

#[tauri::command]
pub fn keychain_delete(connection_id: String) -> Result<(), String> {
    let entry = entry_for(&connection_id)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // already gone
        Err(e) => Err(format!("Failed to delete password: {e}")),
    }
}
