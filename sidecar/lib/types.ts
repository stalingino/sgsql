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
  env?: string;
  useSsh?: boolean;
  sshHost?: string;
  sshPort?: number;
  sshUsername?: string;
  sshPassword?: string;
  sshAuthMode?: "keychain" | "ask" | "none";
  sshUsePrivateKey?: boolean;
  sshPrivateKey?: string;
}
