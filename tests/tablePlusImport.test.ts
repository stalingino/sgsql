import { describe, expect, test } from "bun:test";
import { decryptRNCryptor, isRNCryptorPasswordFile } from "../src/lib/rncryptor";
import { parseBinaryPlist, parseXmlPlist } from "../src/lib/plist";
import {
  convertTablePlusConnection,
  decodeTablePlusDocument,
  isTablePlusDocument,
  parseTablePlusDocument,
} from "../src/lib/tablePlusImport";

function hex(value: string): Uint8Array<ArrayBuffer> {
  const clean = value.replace(/\s+/g, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Vectors from https://github.com/RNCryptor/RNCryptor-Spec/blob/master/vectors/v3/password
const RNCRYPTOR_VECTORS = [
  {
    title: "All fields empty or zero (with one-byte password)",
    password: "a",
    plaintext: "",
    ciphertext: "03010000 00000000 00000000 00000000 00000000 00000000 00000000 00000000 0000b303 9be31cd7 ece5e754 f5c8da17 00366631 3ae8a89d dcf8e3cb 41fdc130 b2329dbe 07d6f4d3 2c34e050 c8bd7e93 3b12",
  },
  {
    title: "One byte",
    password: "thepassword",
    plaintext: "01",
    ciphertext: "03010001 02030405 06070102 03040506 07080203 04050607 08090a0b 0c0d0e0f 0001a1f8 730e0bf4 80eb7b70 f690abf2 1e029514 164ad3c4 74a51b30 c7eaa1ca 545b7de3 de5b010a cbad0a9a 13857df6 96a8",
  },
  {
    title: "Exactly one block",
    password: "thepassword",
    plaintext: "0123456789abcdef",
    ciphertext: "03010102 03040506 07000203 04050607 08010304 05060708 090a0b0c 0d0e0f00 01020e43 7fe80930 9c03fd53 a475131e 9a1978b8 eaef576f 60adb8ce 2320849b a32d7429 00438ba8 97d22210 c76c35c8 49df",
  },
  {
    title: "More than one block",
    password: "thepassword",
    plaintext: "0123456789abcdef01234567",
    ciphertext: "03010203 04050607 00010304 05060708 01020405 06070809 0a0b0c0d 0e0f0001 0203e01b bda5df2c a8adace3 8f6c588d 291e03f9 51b78d34 17bc2816 581dc6b7 67f1a2e5 7597512b 18e1638f 21235fa5 928c",
  },
  {
    title: "Multibyte password",
    password: "中文密码",
    plaintext: "23456789abcdef0123456701",
    ciphertext: "03010304 05060700 01020405 06070801 02030506 0708090a 0b0c0d0e 0f000102 03048a9e 08bdec1c 4bfe13e8 1fb85f00 9ab3ddb9 1387e809 c4ad86d9 e8a60145 57716657 bd317d4b b6a76446 15b3de40 2341",
  },
];

describe("RNCryptor v3 password format", () => {
  for (const vector of RNCRYPTOR_VECTORS) {
    test(vector.title, async () => {
      const bytes = hex(vector.ciphertext);
      expect(isRNCryptorPasswordFile(bytes)).toBe(true);
      expect(toHex(await decryptRNCryptor(bytes, vector.password))).toBe(vector.plaintext);
    });
  }

  test("rejects a wrong password via HMAC before decrypting", async () => {
    await expect(decryptRNCryptor(hex(RNCRYPTOR_VECTORS[1].ciphertext), "nope")).rejects.toThrow("Wrong password");
  });

  test("does not mistake SGSql exports or JSON for RNCryptor", () => {
    expect(isRNCryptorPasswordFile(new TextEncoder().encode("SGXP1" + "x".repeat(80)))).toBe(false);
    expect(isRNCryptorPasswordFile(new TextEncoder().encode("[" + " ".repeat(80) + "]"))).toBe(false);
    // Right header, but the body is not a whole number of AES blocks.
    expect(isRNCryptorPasswordFile(new Uint8Array([3, 1, ...new Array(81).fill(0)]))).toBe(false);
  });
});

const XML_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
	<dict>
		<key>ConnectionName</key>
		<string>Prod &amp; Co — 中文</string>
		<key>Driver</key>
		<string>MySQL</string>
		<key>DatabasePort</key>
		<string>3306</string>
		<key>isOverSSH</key>
		<integer>1</integer>
		<key>tLSMode</key>
		<string>1</string>
		<key>Enabled</key>
		<true/>
		<key>Ratio</key>
		<real>1.5</real>
		<key>Blob</key>
		<data>aGVsbG8=</data>
		<key>Empty</key>
		<string></string>
	</dict>
</array>
</plist>`;

// `plutil -convert binary1` of XML_PLIST.
const BINARY_PLIST_B64 = "YnBsaXN0MDChAdkCAwQFBgcICQoLDA0ODxAREhNVUmF0aW9WRHJpdmVyVEJsb2JcRGF0YWJhc2VQb3J0WWlzT3ZlclNTSF5Db25uZWN0aW9uTmFtZVdFbmFibGVkV3RMU01vZGVVRW1wdHkjP/gAAAAAAABVTXlTUUxFaGVsbG9UMzMwNhABbgBQAHIAbwBkACAAJgAgAEMAbwAgIBQAIE4tZYcJUTFQCAodIyovPEZVXWVrdHqAhYekpacAAAAAAAABAQAAAAAAAAAUAAAAAAAAAAAAAAAAAAAAqA==";

const EXPECTED_PLIST = [{
  ConnectionName: "Prod & Co — 中文",
  Driver: "MySQL",
  DatabasePort: "3306",
  isOverSSH: 1,
  tLSMode: "1",
  Enabled: true,
  Ratio: 1.5,
  Blob: new TextEncoder().encode("hello"),
  Empty: "",
}];

describe("plist parsing", () => {
  test("parses XML plists", () => {
    expect(parseXmlPlist(XML_PLIST)).toEqual(EXPECTED_PLIST);
  });

  test("parses binary plists", () => {
    const bytes = Uint8Array.from(atob(BINARY_PLIST_B64), (c) => c.charCodeAt(0));
    expect(parseBinaryPlist(bytes)).toEqual(EXPECTED_PLIST);
  });

  test("decodeTablePlusDocument picks plist or JSON by content", () => {
    expect(decodeTablePlusDocument(new TextEncoder().encode(XML_PLIST))).toEqual(EXPECTED_PLIST);
    expect(decodeTablePlusDocument(new TextEncoder().encode('{"connections":[]}'))).toEqual({ connections: [] });
  });
});

const TP_GROUPS = [
  { ID: "G1", GroupID: "", Name: "Clients", IsExpaned: true, items: [] },
];

const TP_MYSQL_SSH = {
  ID: "C1",
  GroupID: "G1",
  ConnectionName: "uat-arohan",
  Driver: "MySQL",
  DatabaseHost: "db.internal",
  DatabasePort: "13306",
  DatabaseName: "arohan",
  DatabaseUser: "db_user",
  DatabasePassword: "db_pass",
  Enviroment: "staging",
  tLSMode: "0",
  isOverSSH: 1,
  ServerAddress: "bastion.example.com",
  ServerPort: "25499",
  ServerUser: "ssh_user",
  ServerPassword: "ssh_pass",
  isUsePrivateKey: 0,
  ServerPrivateKeyData: "",
};

describe("TablePlus connection mapping", () => {
  test("maps MySQL over SSH with group and passwords", () => {
    const groups = new Map([["G1", "Clients"]]);
    expect(convertTablePlusConnection(TP_MYSQL_SSH, groups)).toMatchObject({
      type: "mysql",
      name: "uat-arohan",
      host: "db.internal",
      port: 13306,
      database: "arohan",
      username: "db_user",
      password: "db_pass",
      ssl: false,
      env: "staging",
      group: "Clients",
      useSsh: true,
      sshHost: "bastion.example.com",
      sshPort: 25499,
      sshUsername: "ssh_user",
      sshPassword: "ssh_pass",
      sshAuthMode: "keychain",
      sshUsePrivateKey: false,
    });
  });

  test("maps PostgreSQL with TLS and a private key, no SSH password", () => {
    const profile = convertTablePlusConnection({
      ConnectionName: "pg-prod",
      Driver: "PostgreSQL",
      DatabaseHost: "pg.example.com",
      DatabasePort: "",
      DatabaseName: "app",
      DatabaseUser: "postgres",
      Enviroment: "production",
      tLSMode: 1,
      isOverSSH: true,
      ServerAddress: "jump",
      ServerUser: "ops",
      isUsePrivateKey: 1,
      ServerPrivateKeyData: new TextEncoder().encode("-----BEGIN KEY-----"),
    }, new Map());
    expect(profile).toMatchObject({
      type: "postgres",
      port: 5432,
      ssl: true,
      env: "production",
      group: "Connections",
      useSsh: true,
      sshPort: 22,
      sshUsePrivateKey: true,
      sshPrivateKey: "-----BEGIN KEY-----",
      sshAuthMode: "none",
      password: "",
    });
  });

  test("maps SQLite paths and ignores SSH", () => {
    expect(convertTablePlusConnection({
      ConnectionName: "local db",
      Driver: "SQLite",
      DatabasePath: "/tmp/app.sqlite",
      isOverSSH: 1,
    }, new Map())).toMatchObject({ type: "sqlite", database: "/tmp/app.sqlite", useSsh: false });
  });

  test("returns null for unsupported drivers", () => {
    expect(convertTablePlusConnection({ ConnectionName: "cache", Driver: "Redis" }, new Map())).toBeNull();
  });

  test("parses a whole export, resolving groups and reporting skipped drivers", () => {
    const doc = [...TP_GROUPS, TP_MYSQL_SSH, { ConnectionName: "ch", Driver: "ClickHouse", DatabaseHost: "x" }];
    expect(isTablePlusDocument(doc)).toBe(true);
    const result = parseTablePlusDocument(doc);
    expect(result.profiles.map((p) => p.name)).toEqual(["uat-arohan"]);
    expect(result.folders).toEqual(["Clients"]);
    expect(result.skipped).toEqual(["ch"]);
  });

  test("finds connections nested under a wrapper object", () => {
    const doc = { Connections: [TP_MYSQL_SSH], ConnectionGroups: TP_GROUPS };
    expect(parseTablePlusDocument(doc).profiles[0]?.group).toBe("Clients");
  });

  test("assigns folders from the nested group layout of real exports", () => {
    const { ID: _id, GroupID: _gid, ...conn } = TP_MYSQL_SSH;
    const doc = [
      { Name: "KGFS", IsExpaned: true, connections: [conn, { ...conn, ConnectionName: "second" }], groups: [] },
      { Name: "Parent", IsExpaned: false, connections: [], groups: [
        { Name: "Child", IsExpaned: true, connections: [{ ...conn, ConnectionName: "nested" }], groups: [] },
      ] },
      { Name: "Empty", IsExpaned: true, connections: [], groups: [] },
    ];
    const result = parseTablePlusDocument(doc);
    expect(result.profiles.map((p) => [p.name, p.group])).toEqual([
      ["uat-arohan", "KGFS"],
      ["second", "KGFS"],
      ["nested", "Child"],
    ]);
    expect(result.folders).toEqual(["KGFS", "Child"]);
  });

  test("does not treat SGSql exports as TablePlus documents", () => {
    expect(isTablePlusDocument({ version: 1, connections: [{ name: "x", type: "mysql" }] })).toBe(false);
  });
});
