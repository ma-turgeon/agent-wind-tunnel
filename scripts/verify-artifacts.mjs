#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const target = path.resolve(
  process.cwd(),
  process.argv[2] ?? "wind-tunnel-output/fixture",
);
const manifestPath = path.join(target, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

if (manifest.schemaVersion !== "agent-wind-tunnel.manifest/v1") {
  throw new Error("unsupported artifact manifest schema");
}
if (typeof manifest.harnessVersion !== "string" || !manifest.harnessVersion) {
  throw new Error("manifest has no harnessVersion");
}
if (!manifest.files || typeof manifest.files !== "object") {
  throw new Error("manifest has no files map");
}

const expectedNames = ["manifest.json", ...Object.keys(manifest.files)].sort();
const entries = fs.readdirSync(target, { withFileTypes: true });
const actualNames = entries.map((entry) => entry.name).sort();
if (
  actualNames.length !== expectedNames.length ||
  actualNames.some((name, index) => name !== expectedNames[index])
) {
  throw new Error(
    `artifact membership mismatch; expected ${expectedNames.join(", ")}, found ${actualNames.join(", ")}`,
  );
}
if (entries.some((entry) => !entry.isFile())) {
  throw new Error("artifact package contains a non-file entry");
}

for (const [name, metadata] of Object.entries(manifest.files)) {
  const contents = fs.readFileSync(path.join(target, name));
  const digest = crypto.createHash("sha256").update(contents).digest("hex");
  if (digest !== metadata.sha256) {
    throw new Error(`hash mismatch: ${name}`);
  }
  if (contents.byteLength !== metadata.bytes) {
    throw new Error(`byte-count mismatch: ${name}`);
  }
}

console.log(
  `manifest hashes, byte counts, and membership verified: ${target}`,
);
