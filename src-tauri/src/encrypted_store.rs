use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use keyring::Entry;
use rand::RngCore;
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

const SERVICE_NAME: &str = "com.sgsql.desktop";
const ENC_KEY_ACCOUNT: &str = "__store_encryption_key__";
const STORE_FILENAME: &str = "connections.sgsqlconnection";

/// Get or create the AES-256 encryption key in the OS keychain.
fn get_or_create_key() -> Result<[u8; 32], String> {
    let entry =
        Entry::new(SERVICE_NAME, ENC_KEY_ACCOUNT).map_err(|e| format!("Keychain error: {e}"))?;

    match entry.get_password() {
        Ok(b64_key) => {
            let bytes = B64
                .decode(&b64_key)
                .map_err(|e| format!("Bad key encoding: {e}"))?;
            if bytes.len() != 32 {
                return Err("Stored key has wrong length".into());
            }
            let mut key = [0u8; 32];
            key.copy_from_slice(&bytes);
            Ok(key)
        }
        Err(keyring::Error::NoEntry) => {
            // Generate a new random key
            let mut key = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut key);
            let b64_key = B64.encode(key);
            entry
                .set_password(&b64_key)
                .map_err(|e| format!("Failed to store encryption key: {e}"))?;
            log::info!("Generated new store encryption key");
            Ok(key)
        }
        Err(e) => Err(format!("Failed to read encryption key: {e}")),
    }
}

fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("No app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create dir: {e}"))?;
    Ok(dir.join(STORE_FILENAME))
}

/// Encrypt JSON string → nonce(12 bytes) + ciphertext, then base64 the whole thing.
fn encrypt(plaintext: &str, key: &[u8; 32]) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("Cipher init: {e}"))?;
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| format!("Encrypt failed: {e}"))?;

    // Prepend nonce to ciphertext
    let mut combined = Vec::with_capacity(12 + ciphertext.len());
    combined.extend_from_slice(&nonce_bytes);
    combined.extend_from_slice(&ciphertext);
    Ok(B64.encode(combined))
}

/// Decrypt base64 → split nonce + ciphertext → plaintext JSON.
fn decrypt(encoded: &str, key: &[u8; 32]) -> Result<String, String> {
    let combined = B64
        .decode(encoded.trim())
        .map_err(|e| format!("Base64 decode: {e}"))?;
    if combined.len() < 13 {
        return Err("Encrypted data too short".into());
    }
    let (nonce_bytes, ciphertext) = combined.split_at(12);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("Cipher init: {e}"))?;
    let nonce = Nonce::from_slice(nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| "Decryption failed — wrong key or corrupted data".to_string())?;

    String::from_utf8(plaintext).map_err(|e| format!("UTF-8 decode: {e}"))
}

#[tauri::command]
pub fn encrypted_store_save(
    app: tauri::AppHandle,
    data: serde_json::Value,
) -> Result<(), String> {
    let key = get_or_create_key()?;
    let json = serde_json::to_string(&data).map_err(|e| format!("JSON serialize: {e}"))?;
    let encrypted = encrypt(&json, &key)?;
    let path = store_path(&app)?;
    fs::write(&path, encrypted).map_err(|e| format!("Write failed: {e}"))?;
    log::info!("Encrypted store saved to {:?}", path);
    Ok(())
}

#[tauri::command]
pub fn encrypted_store_load(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let path = store_path(&app)?;
    if !path.exists() {
        return Ok(serde_json::json!([]));
    }
    let key = get_or_create_key()?;
    let encrypted = fs::read_to_string(&path).map_err(|e| format!("Read failed: {e}"))?;
    let json_str = decrypt(&encrypted, &key)?;
    let value: serde_json::Value =
        serde_json::from_str(&json_str).map_err(|e| format!("JSON parse: {e}"))?;
    Ok(value)
}
