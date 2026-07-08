import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lightSource = join(root, "src-tauri/icons/icon.png");
const darkSource = join(root, "public/dark-flash.png");
const darkIconPng = join(root, "src-tauri/icons/icon-dark.png");
const outputIcns = join(root, "src-tauri/icons/icon.icns");
const sizes = [16, 32, 128, 256, 512];

// Apple stores the dark appearance as a nested ICNS record. The payload is the
// child ICNS without its 8-byte header; this is the same record type used by
// system icons such as GenericFolderIcon.icns on macOS 26.
const DARK_RECORD_TYPE = Buffer.from([0xfd, 0xd9, 0x2f, 0xa8]);

if (process.platform !== "darwin") {
  console.warn("Skipping macOS icon generation: sips/actool are only available on macOS.");
  process.exit(0);
}

for (const path of [lightSource, darkSource]) {
  if (!existsSync(path)) {
    throw new Error(`Missing icon source: ${path}`);
  }
}

const tempDir = mkdtempSync(join(tmpdir(), "sgsql-icons-"));

try {
  resizePng(darkSource, darkIconPng, 1024);

  const lightIconset = join(tempDir, "light.iconset");
  const darkIconset = join(tempDir, "dark.iconset");

  createIconset(lightSource, lightIconset);
  createIconset(darkIconPng, darkIconset);

  const lightIcns = compileIconset(lightIconset, join(tempDir, "light"));
  const darkIcns = compileIconset(darkIconset, join(tempDir, "dark"));

  writeFileSync(outputIcns, combineLightAndDarkIcns(lightIcns, darkIcns));
  console.log(`Generated ${relative(outputIcns)} with light and dark macOS appearances.`);
} finally {
  rmSync(tempDir, { force: true, recursive: true });
}

function createIconset(source, iconsetDir) {
  mkdirSync(iconsetDir, { recursive: true });
  const images = [];

  for (const size of sizes) {
    for (const scale of [1, 2]) {
      const pixels = size * scale;
      const suffix = scale === 2 ? "@2x" : "";
      const filename = `icon_${size}x${size}${suffix}.png`;
      resizePng(source, join(iconsetDir, filename), pixels);
      images.push({
        filename,
        idiom: "mac",
        scale: `${scale}x`,
        size: `${size}x${size}`,
      });
    }
  }

  writeFileSync(
    join(iconsetDir, "Contents.json"),
    `${JSON.stringify({ images, info: { author: "xcode", version: 1 } }, null, 2)}\n`,
  );
}

function resizePng(source, destination, pixels) {
  execFileSync("sips", ["-z", String(pixels), String(pixels), source, "--out", destination], {
    stdio: "ignore",
  });
}

function readIcns(path) {
  const bytes = readFileSync(path);
  if (bytes.subarray(0, 4).toString("ascii") !== "icns") {
    throw new Error(`${path} is not an ICNS file`);
  }

  const declaredLength = bytes.readUInt32BE(4);
  if (declaredLength !== bytes.length) {
    throw new Error(`${path} has an invalid ICNS length`);
  }

  return bytes;
}

function compileIconset(iconsetDir, workDir) {
  const catalogDir = join(workDir, "Assets.xcassets");
  const appIconsetDir = join(catalogDir, "AppIcon.appiconset");
  const outputDir = join(workDir, "out");
  const partialInfoPlist = join(workDir, "partial-info.plist");

  mkdirSync(catalogDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });
  cpSync(iconsetDir, appIconsetDir, { recursive: true });

  const result = spawnSync(
    "xcrun",
    [
      "actool",
      "--compile",
      outputDir,
      "--platform",
      "macosx",
      "--minimum-deployment-target",
      "10.14",
      "--app-icon",
      "AppIcon",
      "--output-partial-info-plist",
      partialInfoPlist,
      catalogDir,
    ],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    throw new Error(`actool failed:\n${result.stdout}\n${result.stderr}`);
  }

  return readIcns(join(outputDir, "AppIcon.icns"));
}

function combineLightAndDarkIcns(lightIcns, darkIcns) {
  const records = parseRecords(lightIcns).filter(
    (record) => !record.type.equals(DARK_RECORD_TYPE),
  );
  const darkPayload = darkIcns.subarray(8);
  const totalLength =
    8 + records.reduce((total, record) => total + record.bytes.length, 0) + 8 + darkPayload.length;
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(totalLength, 4);

  return Buffer.concat([
    header,
    ...records.map((record) => record.bytes),
    makeRecord(DARK_RECORD_TYPE, darkPayload),
  ]);
}

function parseRecords(icns) {
  const records = [];
  let offset = 8;

  while (offset < icns.length) {
    if (offset + 8 > icns.length) {
      throw new Error("Invalid ICNS record header");
    }

    const type = icns.subarray(offset, offset + 4);
    const length = icns.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > icns.length) {
      throw new Error("Invalid ICNS record length");
    }

    records.push({ type, bytes: icns.subarray(offset, offset + length) });
    offset += length;
  }

  return records;
}

function makeRecord(type, payload) {
  const header = Buffer.alloc(8);
  type.copy(header, 0);
  header.writeUInt32BE(payload.length + 8, 4);
  return Buffer.concat([header, payload]);
}

function relative(path) {
  return path.replace(`${root}/`, "");
}
