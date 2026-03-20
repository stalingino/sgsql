/** Collect all messages + codes from the full error cause chain. */
function collectParts(e: unknown): { msgs: string; codes: string } {
  const msgs: string[] = [];
  const codes: string[] = [];
  let cur: unknown = e;
  while (cur) {
    if (cur instanceof Error) {
      msgs.push(cur.message);
      const code = (cur as NodeJS.ErrnoException).code;
      if (code) codes.push(code);
      cur = (cur as Error & { cause?: unknown }).cause;
    } else {
      msgs.push(String(cur));
      break;
    }
  }
  return { msgs: msgs.join(" "), codes: codes.join(" ") };
}

export function friendlyError(e: unknown): string {
  const { msgs, codes } = collectParts(e);
  const has = (s: string) => msgs.includes(s) || codes.includes(s);

  if (has("ETIMEDOUT") || has("ETIMEOUT") || has("connect timeout") || has("timed out"))
    return "Connection timed out. The host is unreachable or not responding.";
  if (has("ECONNREFUSED"))
    return "Connection refused. Make sure the database server is running and the port is correct.";
  if (has("ENOTFOUND") || has("ENOENT") && msgs.includes("getaddrinfo"))
    return "Host not found. Check the hostname or IP address.";
  if (has("ECONNRESET"))
    return "Connection was reset by the server.";
  if (has("password authentication failed") || has("Access denied for user"))
    return "Authentication failed. Check your username and password.";
  if (has("does not exist") && (has("database") || has("role")))
    return "Database not found. Check the database name.";
  if (has("SSL") || has("ssl"))
    return "SSL/TLS error. Try toggling the SSL setting.";
  if (has("certificate"))
    return "SSL certificate error. The server's certificate could not be verified.";

  return e instanceof Error ? e.message : String(e);
}
