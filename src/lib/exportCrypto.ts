/**
 * Password-based encryption for connection export/import files.
 *
 * Layout: "SGXP1" magic (5 bytes) + salt (16 bytes) + iv (12 bytes) + AES-GCM ciphertext.
 * The key is derived from the user-supplied passphrase via PBKDF2-SHA256, so the
 * exported file is only as strong as the passphrase — never the machine's own
 * OS-keychain key, since the whole point is that it must be portable/decryptable elsewhere.
 */

const MAGIC = new TextEncoder().encode("SGXP1");
const SALT_LEN = 16;
const IV_LEN = 12;
const PBKDF2_ITERATIONS = 210_000;

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function isEncryptedExport(bytes: Uint8Array<ArrayBuffer>): boolean {
  if (bytes.length < MAGIC.length) return false;
  return MAGIC.every((byte, i) => bytes[i] === byte);
}

export async function encryptExport(payload: unknown, password: string): Promise<Uint8Array<ArrayBuffer>> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await deriveKey(password, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));

  const out = new Uint8Array(MAGIC.length + SALT_LEN + IV_LEN + ciphertext.length);
  out.set(MAGIC, 0);
  out.set(salt, MAGIC.length);
  out.set(iv, MAGIC.length + SALT_LEN);
  out.set(ciphertext, MAGIC.length + SALT_LEN + IV_LEN);
  return out;
}

export async function decryptExport(bytes: Uint8Array<ArrayBuffer>, password: string): Promise<unknown> {
  if (!isEncryptedExport(bytes)) throw new Error("Not an encrypted connections file");
  const salt = bytes.slice(MAGIC.length, MAGIC.length + SALT_LEN);
  const iv = bytes.slice(MAGIC.length + SALT_LEN, MAGIC.length + SALT_LEN + IV_LEN);
  const ciphertext = bytes.slice(MAGIC.length + SALT_LEN + IV_LEN);
  const key = await deriveKey(password, salt);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  } catch {
    throw new Error("Wrong password or corrupted file");
  }
  return JSON.parse(new TextDecoder().decode(plaintext));
}
