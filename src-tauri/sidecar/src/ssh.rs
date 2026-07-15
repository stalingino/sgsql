use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::AsyncReadExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::error::SidecarError;
use crate::types::ConnectionProfile;

pub struct SshTunnel {
    pub host: &'static str,
    pub port: u16,
    child: Mutex<Child>,
}

impl SshTunnel {
    pub async fn close(&self) {
        let mut child = self.child.lock().await;
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.try_lock() {
            let _ = child.start_kill();
        }
    }
}

fn ssh_failure(profile: &ConnectionProfile, detail: &str) -> SidecarError {
    let detail = detail.trim();
    let normalized = detail.to_lowercase();
    let endpoint = format!(
        "{}:{}",
        profile.ssh_host.as_deref().unwrap_or(""),
        profile.ssh_port.filter(|p| *p != 0).unwrap_or(22)
    );
    let message = if normalized.contains("permission denied") || normalized.contains("authentication failed") {
        let user = profile
            .ssh_username
            .as_deref()
            .filter(|u| !u.is_empty())
            .map(|u| format!("{u}@"))
            .unwrap_or_default();
        format!("SSH authentication failed for {user}{endpoint}.")
    } else if normalized.contains("could not resolve hostname") || normalized.contains("name or service not known") {
        format!("SSH host not found: {endpoint}.")
    } else if normalized.contains("connection refused") {
        format!("SSH connection refused by {endpoint}.")
    } else if normalized.contains("timed out") || normalized.contains("operation timeout") {
        format!("SSH connection to {endpoint} timed out.")
    } else if detail.is_empty() {
        format!("SSH tunnel to {endpoint} failed.")
    } else {
        format!("SSH tunnel to {endpoint} failed: {detail}")
    };
    SidecarError::Ssh(message)
}

async fn available_port() -> Result<u16, SidecarError> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    Ok(listener.local_addr()?.port())
}

fn expand_home(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest).to_string_lossy().into_owned();
        }
    }
    path.to_string()
}

#[cfg(unix)]
async fn write_private_file(path: &PathBuf, contents: &str, mode: u32) -> Result<(), SidecarError> {
    use std::os::unix::fs::PermissionsExt;
    tokio::fs::write(path, contents).await?;
    tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).await?;
    Ok(())
}

#[cfg(not(unix))]
async fn write_private_file(path: &PathBuf, contents: &str, _mode: u32) -> Result<(), SidecarError> {
    tokio::fs::write(path, contents).await?;
    Ok(())
}

/// Wait until the local forwarded port accepts connections, or the ssh child
/// exits / the 12s deadline passes.
async fn wait_for_port(
    port: u16,
    child: &mut Child,
    stderr_tail: &Arc<std::sync::Mutex<String>>,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(12);
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            let tail = stderr_tail.lock().unwrap().trim().to_string();
            return Err(if tail.is_empty() {
                format!("SSH exited with code {}", status.code().unwrap_or(-1))
            } else {
                tail
            });
        }
        if Instant::now() >= deadline {
            let tail = stderr_tail.lock().unwrap().trim().to_string();
            return Err(if tail.is_empty() { "SSH tunnel timed out".to_string() } else { tail });
        }
        match tokio::time::timeout(Duration::from_millis(300), TcpStream::connect(("127.0.0.1", port))).await {
            Ok(Ok(stream)) => {
                drop(stream);
                return Ok(());
            }
            _ => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }
}

pub async fn create_ssh_tunnel(profile: &ConnectionProfile) -> Result<Option<SshTunnel>, SidecarError> {
    if !profile.use_ssh || profile.db_type == "sqlite" {
        return Ok(None);
    }
    let ssh_host = profile
        .ssh_host
        .as_deref()
        .filter(|h| !h.is_empty())
        .ok_or_else(|| SidecarError::msg("SSH server or config host is required"))?;
    let inline_key = profile.ssh_private_key.as_deref().unwrap_or("");
    if profile.ssh_use_private_key && inline_key.is_empty() {
        return Err(SidecarError::msg("SSH private key file is required"));
    }

    let local_port = available_port().await?;
    let tmp = std::env::temp_dir();
    let mut askpass_path: Option<PathBuf> = None;
    let mut temp_key_path: Option<PathBuf> = None;

    let password = if profile.ssh_auth_mode.as_deref() == Some("none") {
        String::new()
    } else {
        profile.ssh_password.clone().unwrap_or_default()
    };
    if profile.ssh_auth_mode.as_deref() == Some("ask") && password.is_empty() {
        return Err(SidecarError::msg(if profile.ssh_use_private_key {
            "SSH key passphrase is required"
        } else {
            "SSH password is required"
        }));
    }

    let mut args: Vec<String> = vec![
        "-N".into(),
        "-T".into(),
        "-o".into(),
        "ExitOnForwardFailure=yes".into(),
        "-o".into(),
        "ServerAliveInterval=15".into(),
        "-o".into(),
        "ServerAliveCountMax=3".into(),
        "-o".into(),
        "TCPKeepAlive=yes".into(),
        "-o".into(),
        "StrictHostKeyChecking=accept-new".into(),
        "-o".into(),
        "ConnectTimeout=8".into(),
        "-L".into(),
        format!("127.0.0.1:{local_port}:{}:{}", profile.host, profile.port),
    ];
    // Let ~/.ssh/config provide Port for Host aliases when the form retains the
    // default. Non-default form values are explicit command-line overrides.
    if let Some(ssh_port) = profile.ssh_port {
        if ssh_port != 0 && ssh_port != 22 {
            args.push("-p".into());
            args.push(ssh_port.to_string());
        }
    }
    if password.is_empty() {
        args.push("-o".into());
        args.push("BatchMode=yes".into());
    }

    let cleanup = |askpass: &Option<PathBuf>, key: &Option<PathBuf>| {
        let askpass = askpass.clone();
        let key = key.clone();
        async move {
            if let Some(p) = askpass {
                let _ = tokio::fs::remove_file(p).await;
            }
            if let Some(p) = key {
                let _ = tokio::fs::remove_file(p).await;
            }
        }
    };

    let spawn_result: Result<Child, SidecarError> = async {
        if !password.is_empty() {
            let path = tmp.join(format!("sgsql-askpass-{}.sh", uuid::Uuid::new_v4()));
            write_private_file(&path, "#!/bin/sh\nprintf '%s' \"$SGSQL_SSH_PASSWORD\"\n", 0o700).await?;
            askpass_path = Some(path);
        }
        let mut key_arg: Option<String> = None;
        if profile.ssh_use_private_key {
            if inline_key.contains("PRIVATE KEY") {
                let path = tmp.join(format!("sgsql-key-{}", uuid::Uuid::new_v4()));
                write_private_file(&path, inline_key, 0o600).await?;
                key_arg = Some(path.to_string_lossy().into_owned());
                temp_key_path = Some(path);
            } else {
                key_arg = Some(expand_home(inline_key));
            }
        }
        if let Some(key) = key_arg {
            args.push("-i".into());
            args.push(key);
        }
        let destination = match profile.ssh_username.as_deref().filter(|u| !u.is_empty()) {
            Some(user) => format!("{user}@{ssh_host}"),
            None => ssh_host.to_string(),
        };
        args.push(destination);

        let mut cmd = Command::new("ssh");
        cmd.args(&args).stdout(Stdio::null()).stderr(Stdio::piped()).stdin(Stdio::null());
        if let Some(askpass) = &askpass_path {
            cmd.env("SSH_ASKPASS", askpass)
                .env("SSH_ASKPASS_REQUIRE", "force")
                .env("DISPLAY", std::env::var("DISPLAY").unwrap_or_else(|_| "sgsql".into()))
                .env("SGSQL_SSH_PASSWORD", &password);
        }
        cmd.kill_on_drop(true);
        Ok(cmd.spawn()?)
    }
    .await;

    let mut child = match spawn_result {
        Ok(child) => child,
        Err(error) => {
            cleanup(&askpass_path, &temp_key_path).await;
            return Err(ssh_failure(profile, &error.to_string()));
        }
    };

    // Capture a bounded tail of stderr for error normalization.
    let stderr_tail = Arc::new(std::sync::Mutex::new(String::new()));
    if let Some(mut stderr) = child.stderr.take() {
        let tail = Arc::clone(&stderr_tail);
        tokio::spawn(async move {
            let mut buf = [0u8; 4096];
            while let Ok(n) = stderr.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                let mut guard = tail.lock().unwrap();
                guard.push_str(&String::from_utf8_lossy(&buf[..n]));
                if guard.len() > 16_000 {
                    let cut = guard.len() - 16_000;
                    guard.drain(..cut);
                }
            }
        });
    }

    let waited = wait_for_port(local_port, &mut child, &stderr_tail).await;
    cleanup(&askpass_path, &temp_key_path).await;
    if let Err(detail) = waited {
        let _ = child.start_kill();
        let _ = child.wait().await;
        return Err(ssh_failure(profile, &detail));
    }

    Ok(Some(SshTunnel {
        host: "127.0.0.1",
        port: local_port,
        child: Mutex::new(child),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> ConnectionProfile {
        serde_json::from_value(serde_json::json!({
            "id": "x", "type": "postgres", "host": "db.internal", "port": 5432,
            "useSsh": true, "sshHost": "bastion", "sshPort": 22, "sshUsername": "deploy"
        }))
        .unwrap()
    }

    #[test]
    fn ssh_failure_normalizes_auth_errors() {
        let e = ssh_failure(&profile(), "deploy@bastion: Permission denied (publickey,password).");
        assert_eq!(e.to_string(), "SSH authentication failed for deploy@bastion:22.");
    }

    #[test]
    fn ssh_failure_normalizes_dns_errors() {
        let e = ssh_failure(&profile(), "ssh: Could not resolve hostname bastion");
        assert_eq!(e.to_string(), "SSH host not found: bastion:22.");
    }

    #[test]
    fn ssh_failure_keeps_detail_for_unknown_errors() {
        let e = ssh_failure(&profile(), "kex_exchange_identification: read: reset");
        assert_eq!(e.to_string(), "SSH tunnel to bastion:22 failed: kex_exchange_identification: read: reset");
    }
}
