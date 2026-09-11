/**
 * Decryptor for the RNCryptor v3 password-based data format, which TablePlus uses
 * for password-protected `.tableplusconnection` exports.
 *
 * Layout: version (1, = 3) + options (1, bit 0 = password) + encryption salt (8)
 *   + HMAC salt (8) + IV (16) + AES-256-CBC/PKCS7 ciphertext + HMAC-SHA256 (32).
 * Both keys are PBKDF2-SHA1 (10 000 iterations, 32 bytes) over the UTF-8 password.
 * Spec: https://github.com/RNCryptor/RNCryptor-Spec
 */

const VERSION = 3;
const OPTION_PASSWORD = 0x01;
const SALT_LEN = 8;
const IV_LEN = 16;
const HMAC_LEN = 32;
const AES_BLOCK = 16;
const HEADER_LEN = 2 + SALT_LEN * 2 + IV_LEN;
const PBKDF2_ITERATIONS = 10_000;

async function deriveKey(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  algorithm: AesKeyAlgorithm | HmacImportParams,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-1" },
    keyMaterial,
    algorithm,
    false,
    usages,
  );
}

/** True when the bytes carry an RNCryptor v3 password-mode header of a plausible length. */
export function isRNCryptorPasswordFile(bytes: Uint8Array<ArrayBuffer>): boolean {
  if (bytes.length < HEADER_LEN + AES_BLOCK + HMAC_LEN) return false;
  if (bytes[0] !== VERSION || (bytes[1] & OPTION_PASSWORD) === 0) return false;
  return (bytes.length - HEADER_LEN - HMAC_LEN) % AES_BLOCK === 0;
}

export async function decryptRNCryptor(bytes: Uint8Array<ArrayBuffer>, password: string): Promise<Uint8Array<ArrayBuffer>> {
  if (!isRNCryptorPasswordFile(bytes)) throw new Error("Not an RNCryptor password-encrypted file");
  const encSalt = bytes.slice(2, 2 + SALT_LEN);
  const hmacSalt = bytes.slice(2 + SALT_LEN, 2 + SALT_LEN * 2);
  const iv = bytes.slice(2 + SALT_LEN * 2, HEADER_LEN);
  const ciphertext = bytes.slice(HEADER_LEN, bytes.length - HMAC_LEN);
  const mac = bytes.slice(bytes.length - HMAC_LEN);
  const authenticated = bytes.slice(0, bytes.length - HMAC_LEN);

  const [encKey, hmacKey] = await Promise.all([
    deriveKey(password, encSalt, { name: "AES-CBC", length: 256 }, ["decrypt"]),
    deriveKey(password, hmacSalt, { name: "HMAC", hash: "SHA-256", length: 256 }, ["verify"]),
  ]);

  const valid = await crypto.subtle.verify("HMAC", hmacKey, mac, authenticated);
  if (!valid) throw new Error("Wrong password or corrupted file");
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv }, encKey, ciphertext));
  } catch {
    throw new Error("Wrong password or corrupted file");
  }
}
