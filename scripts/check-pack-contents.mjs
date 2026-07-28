#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const exact = new Set([
  ".env.example",
  "AI_COLLABORATION.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "agent-wind-tunnel.mjs",
  "index.mjs",
  "package.json",
]);
const prefixes = [
  "baselines/",
  "docs/",
  "evidence/",
  "examples/",
  "lib/",
  "price-cards/",
  "scenarios/",
  "schemas/",
  "scripts/",
  "test/",
];
const required = [
  "AI_COLLABORATION.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "agent-wind-tunnel.mjs",
  "index.mjs",
  "baselines/deterministic-fixture.json",
  "docs/architecture.md",
  "docs/index.md",
  "evidence/README.md",
  "evidence/live-pilot-2026-07-28.json",
  "scripts/check-baseline.mjs",
  "scripts/release-audit.mjs",
  "scripts/run-release-audit.mjs",
  "scripts/test-inventory.mjs",
  "scripts/verify-artifacts.mjs",
  "scripts/verify-public-live-evidence.mjs",
  "schemas/public-live-evidence.schema.json",
];
const forbiddenSegments = new Set([
  ".git",
  ".github",
  ".ci-output",
  ".live-output",
  ".pages-output",
  "node_modules",
  "private",
  "wind-tunnel-output",
]);

export function validatePackageInventory(summary) {
  if (!summary || !Array.isArray(summary.files)) {
    throw new Error("npm pack manifest contains no file inventory.");
  }

  const files = summary.files.map((entry) => entry.path);
  const violations = files.filter((file) => {
    const normalized = file.replaceAll("\\", "/");
    const segments = normalized.split("/");
    return (
      normalized.startsWith("/") ||
      segments.includes("..") ||
      segments.some((segment) => forbiddenSegments.has(segment)) ||
      (!exact.has(normalized) &&
        !prefixes.some((prefix) => normalized.startsWith(prefix)))
    );
  });
  for (const file of required) {
    if (!files.includes(file)) {
      violations.push(`missing required file: ${file}`);
    }
  }
  if (summary.unpackedSize > 5 * 1024 * 1024) {
    violations.push(
      `unpacked package is ${summary.unpackedSize} bytes; limit is 5242880`,
    );
  }
  if (violations.length) {
    throw new Error(
      `Package allowlist check failed:\n- ${violations.join("\n- ")}`,
    );
  }

  return {
    fileCount: files.length,
    unpackedSize: summary.unpackedSize,
  };
}

function readManifest(manifestFile) {
  try {
    const manifest = fs.readFileSync(path.resolve(manifestFile), "utf8");
    const [summary] = JSON.parse(manifest);
    return summary;
  } catch (error) {
    throw new Error(`Cannot read a valid npm pack manifest: ${error.message}`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [manifestFile] = process.argv.slice(2);
  if (!manifestFile) {
    throw new Error(
      "Usage: node scripts/check-pack-contents.mjs <npm-pack-manifest.json>",
    );
  }
  const result = validatePackageInventory(readManifest(manifestFile));
  console.log(
    `package allowlist verified: ${result.fileCount} files, ${result.unpackedSize} unpacked bytes`,
  );
}
