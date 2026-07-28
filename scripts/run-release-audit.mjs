#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validatePackageInventory } from "./check-pack-contents.mjs";
import {
  auditReleaseInventory,
  auditRepositoryInventory,
} from "./release-audit.mjs";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const argumentList = process.argv.slice(2);
const allowlistOnly =
  argumentList.length === 1 && argumentList[0] === "--allowlist-only";
if (argumentList.length && !allowlistOnly) {
  throw new Error(
    "Usage: node scripts/run-release-audit.mjs [--allowlist-only]",
  );
}

const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "agent-wind-tunnel-pack-"),
);
const npmArguments = [
  "pack",
  "--dry-run",
  "--json",
  "--ignore-scripts",
  "--cache",
  temporaryRoot,
];
const npmCli = process.env.npm_execpath;
const npmCommand = npmCli
  ? process.execPath
  : process.platform === "win32"
    ? "npm.cmd"
    : "npm";
const commandArguments = npmCli
  ? [npmCli, ...npmArguments]
  : npmArguments;

function filesystemInventory(root) {
  const excludedDirectories = new Set([
    ".git",
    ".ci-output",
    ".live-output",
    ".npm-cache",
    ".pages-output",
    ".site-output",
    "coverage",
    "node_modules",
    "wind-tunnel-output",
  ]);
  const files = [];
  function visit(directory, prefix = "") {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix
        ? `${prefix}/${entry.name}`
        : entry.name;
      if (
        entry.isDirectory() &&
        (excludedDirectories.has(entry.name) ||
          entry.name.startsWith(".site-output-staging-"))
      ) {
        continue;
      }
      const resolved = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(resolved, relative);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(relative);
      }
    }
  }
  visit(root);
  return files;
}

function repositoryInventory(root) {
  const result = spawnSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ],
    {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (!result.error && result.status === 0) {
    return result.stdout.split("\0").filter(Boolean);
  }
  return filesystemInventory(root);
}

try {
  const result = spawnSync(
    npmCommand,
    commandArguments,
    {
      cwd: packageRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        npm_config_fund: "false",
        npm_config_update_notifier: "false",
      },
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    },
  );
  if (result.error) {
    throw new Error(
      `Unable to launch npm pack (${result.error.code ?? "unknown error"}).`,
    );
  }
  if (result.status !== 0) {
    throw new Error(`npm pack exited with status ${result.status}.`);
  }

  let packageSummary;
  try {
    [packageSummary] = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`npm pack returned invalid JSON: ${error.message}`);
  }

  const allowlist = validatePackageInventory(packageSummary);
  console.log(
    `package allowlist verified: ${allowlist.fileCount} files, ${allowlist.unpackedSize} unpacked bytes`,
  );

  if (!allowlistOnly) {
    const audit = auditReleaseInventory(packageSummary, {
      root: packageRoot,
    });
    console.log(
      `release audit passed: ${audit.fileCount} publishable files; no forbidden members or recognized credential patterns`,
    );
    const repositoryAudit = auditRepositoryInventory(
      repositoryInventory(packageRoot),
      { root: packageRoot },
    );
    console.log(
      `repository publication audit passed: ${repositoryAudit.fileCount} prospective public files; ignored private/generated material excluded`,
    );
  }
} finally {
  fs.rmSync(temporaryRoot, { force: true, recursive: true });
}
