use serde::Deserialize;

fn default_port() -> u16 {
    0
}

// name/color/env are part of the wire profile but unused by the sidecar itself.
#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(rename = "type", default)]
    pub db_type: String,
    #[serde(default)]
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub ssl: bool,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub env: Option<String>,
    #[serde(default)]
    pub use_ssh: bool,
    #[serde(default)]
    pub ssh_host: Option<String>,
    #[serde(default)]
    pub ssh_port: Option<u16>,
    #[serde(default)]
    pub ssh_username: Option<String>,
    #[serde(default)]
    pub ssh_password: Option<String>,
    #[serde(default)]
    pub ssh_auth_mode: Option<String>,
    #[serde(default)]
    pub ssh_use_private_key: bool,
    #[serde(default)]
    pub ssh_private_key: Option<String>,
}
