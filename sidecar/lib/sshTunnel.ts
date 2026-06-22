import { createServer, connect as connectSocket } from "node:net";
import { chmod, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectionProfile } from "./types";

export interface SshTunnel {
  host: "127.0.0.1";
  port: number;
  close: () => Promise<void>;
}

function sshFailure(profile: ConnectionProfile, error: unknown): Error {
  const detail = error instanceof Error ? error.message.trim() : String(error);
  const normalized = detail.toLowerCase();
  const endpoint = `${profile.sshHost}:${profile.sshPort || 22}`;
  if (normalized.includes("permission denied") || normalized.includes("authentication failed")) {
    return new Error(`SSH authentication failed for ${profile.sshUsername ? `${profile.sshUsername}@` : ""}${endpoint}.`);
  }
  if (normalized.includes("could not resolve hostname") || normalized.includes("name or service not known")) {
    return new Error(`SSH host not found: ${endpoint}.`);
  }
  if (normalized.includes("connection refused")) {
    return new Error(`SSH connection refused by ${endpoint}.`);
  }
  if (normalized.includes("timed out") || normalized.includes("operation timeout")) {
    return new Error(`SSH connection to ${endpoint} timed out.`);
  }
  return new Error(`SSH tunnel to ${endpoint} failed${detail ? `: ${detail}` : "."}`);
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function waitForPort(port: number, exited: Promise<number>, stderr: () => string): Promise<void> {
  const deadline = Date.now() + 12_000;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      error ? reject(error) : resolve();
    };
    exited.then((code) => finish(new Error(stderr().trim() || `SSH exited with code ${code}`)));
    const probe = () => {
      if (settled) return;
      if (Date.now() >= deadline) {
        finish(new Error(stderr().trim() || "SSH tunnel timed out"));
        return;
      }
      const socket = connectSocket({ host: "127.0.0.1", port });
      socket.setTimeout(300);
      socket.once("connect", () => { socket.destroy(); finish(); });
      socket.once("error", () => { socket.destroy(); setTimeout(probe, 100); });
      socket.once("timeout", () => { socket.destroy(); setTimeout(probe, 100); });
    };
    probe();
  });
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export async function createSshTunnel(profile: ConnectionProfile): Promise<SshTunnel | null> {
  if (!profile.useSsh || profile.type === "sqlite") return null;
  if (!profile.sshHost) throw new Error("SSH server or config host is required");
  if (profile.sshUsePrivateKey && !profile.sshPrivateKey) throw new Error("SSH private key file is required");

  const localPort = await availablePort();
  let askpassPath = "";
  let privateKeyPath = "";
  const cleanupTemporaryFiles = async () => {
    if (askpassPath) await unlink(askpassPath).catch(() => {});
    if (privateKeyPath.startsWith(join(tmpdir(), "sgsql-key-"))) {
      await unlink(privateKeyPath).catch(() => {});
    }
  };
  const password = profile.sshAuthMode === "none" ? "" : profile.sshPassword ?? "";
  if (profile.sshAuthMode === "ask" && !password) {
    throw new Error(profile.sshUsePrivateKey ? "SSH key passphrase is required" : "SSH password is required");
  }
  const args = [
    "ssh", "-N", "-T",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "TCPKeepAlive=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=8",
    "-L", `127.0.0.1:${localPort}:${profile.host}:${profile.port}`,
  ];
  // Let ~/.ssh/config provide Port for Host aliases when the form retains the
  // default. Non-default form values are explicit command-line overrides.
  if (profile.sshPort && profile.sshPort !== 22) args.push("-p", String(profile.sshPort));
  if (!password) args.push("-o", "BatchMode=yes");
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    if (password) {
      askpassPath = join(tmpdir(), `sgsql-askpass-${crypto.randomUUID()}.sh`);
      await writeFile(askpassPath, "#!/bin/sh\nprintf '%s' \"$SGSQL_SSH_PASSWORD\"\n", { mode: 0o700 });
      await chmod(askpassPath, 0o700);
    }
    if (profile.sshUsePrivateKey) {
      if (profile.sshPrivateKey.includes("PRIVATE KEY")) {
        privateKeyPath = join(tmpdir(), `sgsql-key-${crypto.randomUUID()}`);
        await writeFile(privateKeyPath, profile.sshPrivateKey, { mode: 0o600 });
        await chmod(privateKeyPath, 0o600);
      } else {
        privateKeyPath = expandHome(profile.sshPrivateKey);
      }
      args.push("-i", privateKeyPath);
    }
    args.push(profile.sshUsername ? `${profile.sshUsername}@${profile.sshHost}` : profile.sshHost);

    proc = Bun.spawn(args, {
      stdout: "ignore",
      stderr: "pipe",
      env: {
        ...process.env,
        ...(askpassPath ? {
          SSH_ASKPASS: askpassPath,
          SSH_ASKPASS_REQUIRE: "force",
          DISPLAY: process.env.DISPLAY || "sgsql",
          SGSQL_SSH_PASSWORD: password,
        } : {}),
      },
    });
  } catch (error) {
    await cleanupTemporaryFiles();
    throw sshFailure(profile, error);
  }
  let errorOutput = "";
  const stderrTask = (async () => {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      errorOutput = (errorOutput + decoder.decode(value, { stream: true })).slice(-16_000);
    }
  })();

  try {
    await waitForPort(localPort, proc.exited, () => errorOutput);
  } catch (error) {
    proc.kill();
    await proc.exited.catch(() => 0);
    throw sshFailure(profile, error);
  } finally {
    await cleanupTemporaryFiles();
  }

  return {
    host: "127.0.0.1",
    port: localPort,
    close: async () => {
      proc.kill();
      await proc.exited.catch(() => 0);
      await stderrTask.catch(() => {});
    },
  };
}
