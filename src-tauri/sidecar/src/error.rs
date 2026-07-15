use std::io;

#[derive(Debug, thiserror::Error)]
pub enum SidecarError {
    /// SSH tunnel errors carry a pre-normalized, user-facing message.
    #[error("{0}")]
    Ssh(String),
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error("{0}")]
    Msg(String),
}

impl SidecarError {
    pub fn msg(message: impl Into<String>) -> Self {
        SidecarError::Msg(message.into())
    }

    /// Concatenated messages of the whole error chain, plus Node-style codes
    /// synthesized from io error kinds and database error codes so the
    /// original friendlyError matching keeps working.
    fn parts(&self) -> (String, String) {
        let mut msgs: Vec<String> = Vec::new();
        let mut codes: Vec<String> = Vec::new();

        fn walk(err: &(dyn std::error::Error + 'static), msgs: &mut Vec<String>, codes: &mut Vec<String>) {
            msgs.push(err.to_string());
            if let Some(io_err) = err.downcast_ref::<io::Error>() {
                if let Some(code) = io_code(io_err) {
                    codes.push(code.to_string());
                }
            }
            if let Some(db_err) = err.downcast_ref::<sqlx::Error>() {
                if let sqlx::Error::Database(dbe) = db_err {
                    if let Some(code) = dbe.code() {
                        codes.push(code.to_string());
                    }
                }
            }
            if let Some(source) = err.source() {
                walk(source, msgs, codes);
            }
        }

        match self {
            SidecarError::Ssh(m) | SidecarError::Msg(m) => msgs.push(m.clone()),
            SidecarError::Sqlx(e) => walk(e, &mut msgs, &mut codes),
            SidecarError::Io(e) => walk(e, &mut msgs, &mut codes),
        }
        (msgs.join(" "), codes.join(" "))
    }

    pub fn friendly(&self) -> String {
        let (msgs, codes) = self.parts();
        friendly_from_parts(self, &msgs, &codes)
    }

    pub fn is_connection_error(&self) -> bool {
        if let SidecarError::Sqlx(e) = self {
            match e {
                sqlx::Error::Io(_) | sqlx::Error::PoolClosed | sqlx::Error::WorkerCrashed => return true,
                sqlx::Error::Protocol(_) => return true,
                _ => {}
            }
        }
        let (msgs, codes) = self.parts();
        let all = format!("{} {}", msgs.to_lowercase(), codes.to_lowercase());
        [
            "econnreset",
            "epipe",
            "closed state",
            "closed connection",
            "connection lost",
            "connection closed",
            "connection was closed",
            "has been closed",
            "can't add new command",
            "cannot execute",
            "connection terminated",
            "connection unexpectedly",
            "socket has been ended",
            "socket hang up",
            "broken pipe",
            "read econnreset",
            "etimedout",
            "connection reset",
        ]
        .iter()
        .any(|needle| all.contains(needle))
    }
}

fn io_code(err: &io::Error) -> Option<&'static str> {
    use io::ErrorKind::*;
    match err.kind() {
        ConnectionRefused => Some("ECONNREFUSED"),
        ConnectionReset => Some("ECONNRESET"),
        ConnectionAborted => Some("ECONNRESET"),
        TimedOut => Some("ETIMEDOUT"),
        BrokenPipe => Some("EPIPE"),
        NotFound => Some("ENOENT"),
        _ => None,
    }
}

fn friendly_from_parts(err: &SidecarError, msgs: &str, codes: &str) -> String {
    let has = |s: &str| msgs.contains(s) || codes.contains(s);

    // SSH tunnel errors already identify the failing layer and endpoint. Do not
    // collapse them into a generic database/network timeout.
    if msgs.starts_with("SSH ") {
        return err.to_string();
    }

    if has("ETIMEDOUT") || has("ETIMEOUT") || has("connect timeout") || has("timed out") {
        return "Connection timed out. The host is unreachable or not responding.".into();
    }
    if has("ECONNREFUSED") || msgs.to_lowercase().contains("connection refused") {
        return "Connection refused. Make sure the database server is running and the port is correct.".into();
    }
    if has("ENOTFOUND")
        || (has("ENOENT") && msgs.contains("getaddrinfo"))
        || msgs.contains("failed to lookup address")
    {
        return "Host not found. Check the hostname or IP address.".into();
    }
    if has("ECONNRESET") {
        return "Connection was reset by the server.".into();
    }
    if has("password authentication failed") || has("Access denied for user") {
        return "Authentication failed. Check your username and password.".into();
    }
    if has("does not exist") && (has("database") || has("role")) {
        return "Database not found. Check the database name.".into();
    }
    if has("SSL") || has("ssl") {
        return "SSL/TLS error. Try toggling the SSL setting.".into();
    }
    if has("certificate") {
        return "SSL certificate error. The server's certificate could not be verified.".into();
    }

    err.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_errors_pass_through_untouched() {
        let e = SidecarError::Ssh("SSH authentication failed for user@host:22.".into());
        assert_eq!(e.friendly(), "SSH authentication failed for user@host:22.");
    }

    #[test]
    fn refused_maps_to_friendly_message() {
        let e = SidecarError::Io(io::Error::new(io::ErrorKind::ConnectionRefused, "connect failed"));
        assert_eq!(
            e.friendly(),
            "Connection refused. Make sure the database server is running and the port is correct."
        );
    }

    #[test]
    fn timeout_maps_to_friendly_message() {
        let e = SidecarError::msg("PostgreSQL connection health check timed out");
        assert_eq!(e.friendly(), "Connection timed out. The host is unreachable or not responding.");
        assert!(e.is_connection_error() == false);
    }

    #[test]
    fn auth_failure_maps_to_friendly_message() {
        let e = SidecarError::msg("FATAL: password authentication failed for user \"x\"");
        assert_eq!(e.friendly(), "Authentication failed. Check your username and password.");
    }

    #[test]
    fn connection_reset_is_connection_error() {
        let e = SidecarError::msg("read ECONNRESET");
        assert!(e.is_connection_error());
    }

    #[test]
    fn unknown_errors_pass_through() {
        let e = SidecarError::msg("syntax error at or near \"FRM\"");
        assert_eq!(e.friendly(), "syntax error at or near \"FRM\"");
        assert!(!e.is_connection_error());
    }
}
