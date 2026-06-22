import { describe, expect, test } from "bun:test";
import { createDefaultProfile } from "../src/lib/types";
import { formatConnectionUrl, parseConnectionUrl } from "../src/lib/parseConnectionUrl";

describe("connection URL", () => {
  test("parses the dual-authority SSH URL format", () => {
    const url = "mysql+ssh://ssh_user:pass@ip:22/db_user:db_pass@db_host/db_name?statusColor=6D0000&env=staging&name=uat-arohan&tLSMode=0&usePrivateKey=false";
    const parsed = parseConnectionUrl(url, createDefaultProfile());

    expect(parsed).toMatchObject({
      type: "mysql",
      useSsh: true,
      sshUsername: "ssh_user",
      sshPassword: "pass",
      sshHost: "ip",
      sshPort: 22,
      username: "db_user",
      password: "db_pass",
      host: "db_host",
      port: 3306,
      database: "db_name",
      color: "#6D0000",
      env: "staging",
      name: "uat-arohan",
    });
  });

  test("round trips encoded SSH and database credentials", () => {
    const profile = {
      ...createDefaultProfile(),
      type: "postgres" as const,
      name: "Staging DB",
      host: "db.internal",
      port: 5433,
      database: "app/data",
      username: "db:user",
      password: "db@pass/word",
      useSsh: true,
      sshHost: "gateway.example.com",
      sshPort: 2222,
      sshUsername: "ssh user",
      sshPassword: "ssh@pass",
      sshAuthMode: "keychain" as const,
    };

    const roundTripped = { ...createDefaultProfile(), ...parseConnectionUrl(formatConnectionUrl(profile), createDefaultProfile()) };
    expect(roundTripped).toMatchObject(profile);
  });
});
