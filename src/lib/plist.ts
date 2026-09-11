/**
 * Minimal Apple property-list reader (XML and binary "bplist00") used for
 * TablePlus connection exports. Produces plain JS values: dict → object,
 * array → array, integer/real → number, date → Date, data → Uint8Array.
 * Runs without a DOM so it can be unit tested under bun.
 */

export type PlistValue =
  | null
  | boolean
  | number
  | string
  | Date
  | Uint8Array
  | PlistValue[]
  | { [key: string]: PlistValue };

const BPLIST_MAGIC = "bplist";

export function isBinaryPlist(bytes: Uint8Array): boolean {
  if (bytes.length < BPLIST_MAGIC.length + 32) return false;
  for (let i = 0; i < BPLIST_MAGIC.length; i++) {
    if (bytes[i] !== BPLIST_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

export function isXmlPlist(text: string): boolean {
  return /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!DOCTYPE[^>]*>\s*)?<plist\b/i.test(text);
}

export function parsePlist(bytes: Uint8Array): PlistValue {
  if (isBinaryPlist(bytes)) return parseBinaryPlist(bytes);
  const text = new TextDecoder().decode(bytes);
  if (isXmlPlist(text)) return parseXmlPlist(text);
  throw new Error("Not a property list");
}

// ---------------------------------------------------------------------------
// XML plist
// ---------------------------------------------------------------------------

interface XmlToken {
  kind: "open" | "close" | "empty" | "text";
  name: string;
  text: string;
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "amp") return "&";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    const code = lower.startsWith("#x") ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : match;
  });
}

function tokenizeXml(text: string): XmlToken[] {
  const tokens: XmlToken[] = [];
  const pattern = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([A-Za-z][\w.-]*)\s*>|<([A-Za-z][\w.-]*)(?:\s[^>]*?)?(\/?)>|([^<]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const [, closeName, openName, selfClose, body] = match;
    if (closeName) tokens.push({ kind: "close", name: closeName.toLowerCase(), text: "" });
    else if (openName) tokens.push({ kind: selfClose ? "empty" : "open", name: openName.toLowerCase(), text: "" });
    else if (body !== undefined) tokens.push({ kind: "text", name: "", text: body });
  }
  return tokens;
}

export function parseXmlPlist(text: string): PlistValue {
  const tokens = tokenizeXml(text);
  let index = 0;

  const skipWhitespace = () => {
    while (index < tokens.length && tokens[index].kind === "text" && tokens[index].text.trim() === "") index++;
  };

  const readText = (): string => {
    let out = "";
    while (index < tokens.length && tokens[index].kind === "text") out += tokens[index++].text;
    return decodeEntities(out);
  };

  const expectClose = (name: string) => {
    skipWhitespace();
    const token = tokens[index++];
    if (!token || token.kind !== "close" || token.name !== name) throw new Error(`Malformed plist: expected </${name}>`);
  };

  const parseValue = (): PlistValue => {
    skipWhitespace();
    const token = tokens[index++];
    if (!token || (token.kind !== "open" && token.kind !== "empty")) throw new Error("Malformed plist: expected a value");
    const empty = token.kind === "empty";
    switch (token.name) {
      case "true": if (!empty) expectClose("true"); return true;
      case "false": if (!empty) expectClose("false"); return false;
      case "string": { if (empty) return ""; const value = readText(); expectClose("string"); return value; }
      case "integer": { if (empty) return 0; const value = readText(); expectClose("integer"); return parseInt(value.trim(), 10); }
      case "real": { if (empty) return 0; const value = readText(); expectClose("real"); return parseFloat(value.trim()); }
      case "date": { if (empty) return new Date(NaN); const value = readText(); expectClose("date"); return new Date(value.trim()); }
      case "data": {
        if (empty) return new Uint8Array(0);
        const value = readText();
        expectClose("data");
        return base64ToBytes(value.replace(/\s+/g, ""));
      }
      case "array": {
        const items: PlistValue[] = [];
        if (empty) return items;
        for (;;) {
          skipWhitespace();
          const next = tokens[index];
          if (!next) throw new Error("Malformed plist: unterminated <array>");
          if (next.kind === "close") { index++; return items; }
          items.push(parseValue());
        }
      }
      case "dict": {
        const dict: { [key: string]: PlistValue } = {};
        if (empty) return dict;
        for (;;) {
          skipWhitespace();
          const next = tokens[index];
          if (!next) throw new Error("Malformed plist: unterminated <dict>");
          if (next.kind === "close") { index++; return dict; }
          index++;
          if (next.name !== "key") throw new Error("Malformed plist: expected <key>");
          const key = next.kind === "empty" ? "" : readText();
          if (next.kind !== "empty") expectClose("key");
          dict[key] = parseValue();
        }
      }
      default:
        throw new Error(`Malformed plist: unsupported element <${token.name}>`);
    }
  };

  skipWhitespace();
  const root = tokens[index];
  if (!root || root.kind !== "open" || root.name !== "plist") throw new Error("Malformed plist: missing <plist> root");
  index++;
  const value = parseValue();
  expectClose("plist");
  return value;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// Binary plist (bplist00)
// ---------------------------------------------------------------------------

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

export function parseBinaryPlist(bytes: Uint8Array): PlistValue {
  if (!isBinaryPlist(bytes)) throw new Error("Not a binary plist");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const trailer = bytes.length - 32;
  const offsetIntSize = bytes[trailer + 6];
  const objectRefSize = bytes[trailer + 7];
  const numObjects = Number(view.getBigUint64(trailer + 8));
  const topObject = Number(view.getBigUint64(trailer + 16));
  const offsetTableOffset = Number(view.getBigUint64(trailer + 24));

  const readUint = (offset: number, size: number): number => {
    let value = 0;
    for (let i = 0; i < size; i++) value = value * 256 + bytes[offset + i];
    return value;
  };

  const offsets: number[] = [];
  for (let i = 0; i < numObjects; i++) {
    offsets.push(readUint(offsetTableOffset + i * offsetIntSize, offsetIntSize));
  }

  const readInt = (offset: number, size: number): number => {
    if (size === 8) return Number(view.getBigInt64(offset));
    if (size === 16) return Number(view.getBigInt64(offset + 8)); // low 64 bits; high bits are sign extension
    return readUint(offset, size);
  };

  /** Reads the element count for a collection/string marker; returns [count, offsetAfterCount]. */
  const readCount = (offset: number, info: number): [number, number] => {
    if (info !== 0x0f) return [info, offset + 1];
    const marker = bytes[offset + 1];
    if ((marker & 0xf0) !== 0x10) throw new Error("Malformed binary plist: bad count marker");
    const size = 1 << (marker & 0x0f);
    return [readUint(offset + 2, size), offset + 2 + size];
  };

  const cache = new Map<number, PlistValue>();

  const readObject = (ref: number): PlistValue => {
    if (cache.has(ref)) return cache.get(ref)!;
    const offset = offsets[ref];
    if (offset === undefined) throw new Error("Malformed binary plist: object reference out of range");
    const marker = bytes[offset];
    const type = marker >> 4;
    const info = marker & 0x0f;
    let value: PlistValue;

    switch (type) {
      case 0x0:
        if (info === 0x00) value = null;
        else if (info === 0x08) value = false;
        else if (info === 0x09) value = true;
        else throw new Error("Malformed binary plist: unknown singleton");
        break;
      case 0x1:
        value = readInt(offset + 1, 1 << info);
        break;
      case 0x2:
        value = info === 2 ? view.getFloat32(offset + 1) : view.getFloat64(offset + 1);
        break;
      case 0x3:
        value = new Date(APPLE_EPOCH_MS + view.getFloat64(offset + 1) * 1000);
        break;
      case 0x4: {
        const [count, start] = readCount(offset, info);
        value = bytes.slice(start, start + count);
        break;
      }
      case 0x5: {
        const [count, start] = readCount(offset, info);
        value = new TextDecoder("latin1").decode(bytes.subarray(start, start + count));
        break;
      }
      case 0x6: {
        const [count, start] = readCount(offset, info);
        value = new TextDecoder("utf-16be").decode(bytes.subarray(start, start + count * 2));
        break;
      }
      case 0x7: {
        const [count, start] = readCount(offset, info);
        value = new TextDecoder("utf-8").decode(bytes.subarray(start, start + count));
        break;
      }
      case 0x8:
        value = readUint(offset + 1, info + 1);
        break;
      case 0xa:
      case 0xc: {
        const [count, start] = readCount(offset, info);
        const items: PlistValue[] = [];
        cache.set(ref, items);
        for (let i = 0; i < count; i++) items.push(readObject(readUint(start + i * objectRefSize, objectRefSize)));
        value = items;
        break;
      }
      case 0xd: {
        const [count, start] = readCount(offset, info);
        const dict: { [key: string]: PlistValue } = {};
        cache.set(ref, dict);
        for (let i = 0; i < count; i++) {
          const key = readObject(readUint(start + i * objectRefSize, objectRefSize));
          const item = readObject(readUint(start + (count + i) * objectRefSize, objectRefSize));
          dict[String(key)] = item;
        }
        value = dict;
        break;
      }
      default:
        throw new Error(`Malformed binary plist: unsupported object type 0x${type.toString(16)}`);
    }

    cache.set(ref, value);
    return value;
  };

  return readObject(topObject);
}
