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
