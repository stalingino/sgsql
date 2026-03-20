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
  color: string;
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
    color: "#ff4d4d",
  };
}

export const DB_TYPE_PORTS: Record<ConnectionProfile["type"], number> = {
  postgres: 5432,
  mysql: 3306,
  sqlite: 0,
};

export const CONNECTION_COLORS = [
  "#ff4d4d", // orange
  "#4ade80", // green
  "#60a5fa", // blue
  "#f87171", // red
  "#c084fc", // purple
  "#facc15", // yellow
  "#2dd4bf", // teal
  "#fb923c", // amber
  "#f472b6", // pink
  "#94a3b8", // slate
];
