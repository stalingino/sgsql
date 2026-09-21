import { describe, expect, test } from "bun:test";
import { buildMcpConfig, mcpServerName, redactSnippet, redactToken } from "../src/lib/mcpConfig";

const share = { url: "http://127.0.0.1:45822/mcp/abc123", token: "0123456789abcdef0123456789abcdef" };

describe("MCP config snippets", () => {
  test("derives a server name slug from the profile name", () => {
    expect(mcpServerName("My Prod DB!")).toBe("sgsql-my-prod-db");
    expect(mcpServerName("  ")).toBe("sgsql-db");
    expect(mcpServerName("Ünïcode & stuff")).toBe("sgsql-n-code-stuff");
  });

  test("builds a claude mcp add command with the bearer header", () => {
    const { claudeCommand, serverName } = buildMcpConfig(share, "Local PG");
    expect(serverName).toBe("sgsql-local-pg");
    expect(claudeCommand).toBe(
      `claude mcp add --transport http sgsql-local-pg ${share.url} --header "Authorization: Bearer ${share.token}"`,
    );
  });

  test("builds valid JSON for Claude and Cursor", () => {
    const { claudeJson, cursorJson } = buildMcpConfig(share, "Local PG");
    const claude = JSON.parse(claudeJson);
    expect(claude.mcpServers["sgsql-local-pg"]).toEqual({
      type: "http",
      url: share.url,
      headers: { Authorization: `Bearer ${share.token}` },
    });
    const cursor = JSON.parse(cursorJson);
    expect(cursor.mcpServers["sgsql-local-pg"]).toEqual({
      url: share.url,
      headers: { Authorization: `Bearer ${share.token}` },
    });
  });

  test("redacts tokens for display", () => {
    expect(redactToken(share.token)).toBe("0123…cdef");
    expect(redactToken("short")).toBe("•••••");
    const { claudeCommand } = buildMcpConfig(share, "x");
    expect(redactSnippet(claudeCommand, share.token)).not.toContain(share.token);
    expect(redactSnippet(claudeCommand, share.token)).toContain("0123…cdef");
  });
});
