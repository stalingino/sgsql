export type ConnectionEnv = "production" | "staging" | "testing" | "development" | "local" | "";

export const DEFAULT_CONNECTION_FOLDER = "Connections";

export interface ConnectionProfile {
  id: string;
  name: string;
  type: "postgres" | "mysql" | "sqlite";
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
  env: ConnectionEnv;
  group: string;
  useSsh: boolean;
  sshHost: string;
  sshPort: number;
  sshUsername: string;
  sshPassword: string;
  sshAuthMode: "keychain" | "ask" | "none";
  sshUsePrivateKey: boolean;
  sshPrivateKey: string;
}

export type ConnectionTestResult = {
  ok: boolean;
  error?: string;
  latency?: number;
};

export function createDefaultProfile(): ConnectionProfile {
  return {
    id: "",
    name: "",
    type: "postgres",
    host: "localhost",
    port: 5432,
    database: "",
    username: "",
    password: "",
    ssl: false,
    env: "",
    group: DEFAULT_CONNECTION_FOLDER,
    useSsh: false,
    sshHost: "127.0.0.1",
    sshPort: 22,
    sshUsername: "",
    sshPassword: "",
    sshAuthMode: "keychain",
    sshUsePrivateKey: false,
    sshPrivateKey: "",
  };
}

export const ENV_LABELS: Record<ConnectionEnv, { label: string; dark: string; light: string }> = {
  "":          { label: "",       dark: "",        light: ""        },
  production:  { label: "prod",   dark: "#f87171", light: "#b91c1c" },
  staging:     { label: "stage",  dark: "#fb923c", light: "#c2410c" },
  testing:     { label: "test",   dark: "#facc15", light: "#92400e" },
  development: { label: "dev",    dark: "#60a5fa", light: "#1d4ed8" },
  local:       { label: "local",  dark: "#4ade80", light: "#15803d" },
};

/** Returns the right badge inline styles based on current data-theme */
export function envBadgeStyle(env: ConnectionEnv): { backgroundColor: string; color: string } | undefined {
  const meta = ENV_LABELS[env];
  if (!meta?.label) return undefined;
  const isDark = document.documentElement.getAttribute("data-theme") !== "light";
  const color = isDark ? meta.dark : meta.light;
  return { backgroundColor: `${color}20`, color };
}

/** Convenience: just the resolved color string */
export function envColor(env: ConnectionEnv): string {
  const meta = ENV_LABELS[env];
  if (!meta?.label) return "";
  const isDark = document.documentElement.getAttribute("data-theme") !== "light";
  return isDark ? meta.dark : meta.light;
}

/** Neutral dot color for profiles without an environment. */
export const NO_ENV_COLOR = "#71717a";

/** Indicator color for a profile: fixed per environment, neutral gray when unset. */
export function profileColor(env: ConnectionEnv): string {
  return envColor(env) || NO_ENV_COLOR;
}

export const DB_TYPE_PORTS: Record<ConnectionProfile["type"], number> = {
  postgres: 5432,
  mysql: 3306,
  sqlite: 0,
};

