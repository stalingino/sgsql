/* ── MCP client configuration snippets for an agent share ── */

export interface McpSnippets {
  serverName: string;
  /** `claude mcp add ...` one-liner. */
  claudeCommand: string;
  /** `.mcp.json` / `claude_desktop_config.json` style. */
  claudeJson: string;
  /** `~/.cursor/mcp.json` style (no `type` field). */
  cursorJson: string;
}

/** `sgsql-<slug>` from a profile name, e.g. "My Prod DB!" → "sgsql-my-prod-db". */
export function mcpServerName(profileName: string): string {
  const slug = profileName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return `sgsql-${slug || "db"}`;
}

export function buildMcpConfig(share: { url: string; token: string }, profileName: string): McpSnippets {
  const serverName = mcpServerName(profileName);
  const authorization = `Bearer ${share.token}`;
  return {
    serverName,
    claudeCommand: `claude mcp add --transport http ${serverName} ${share.url} --header "Authorization: ${authorization}"`,
    claudeJson: JSON.stringify(
      { mcpServers: { [serverName]: { type: "http", url: share.url, headers: { Authorization: authorization } } } },
      null,
      2,
    ),
    cursorJson: JSON.stringify(
      { mcpServers: { [serverName]: { url: share.url, headers: { Authorization: authorization } } } },
      null,
      2,
    ),
  };
}

/** `abcd…wxyz` for display; the real token is only used when copying. */
export function redactToken(token: string): string {
  if (token.length <= 12) return "•".repeat(token.length);
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

/** Same snippet with the token masked, for on-screen display. */
export function redactSnippet(snippet: string, token: string): string {
  return token ? snippet.split(token).join(redactToken(token)) : snippet;
}
