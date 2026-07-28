#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const forbiddenSegments = new Set([
  ".git",
  ".github",
  ".ci-output",
  ".live-output",
  ".pages-output",
  ".site-output",
  "node_modules",
  "private",
  "wind-tunnel-output",
]);
const forbiddenNames = new Set([
  ".pack-manifest.json",
  "execution.ndjson",
  "trace.ndjson",
]);
const repositoryForbiddenSegments = new Set([
  ".git",
  ".ci-output",
  ".live-output",
  ".npm-cache",
  ".pages-output",
  ".site-output",
  "coverage",
  "node_modules",
  "private",
  "wind-tunnel-output",
]);
const secretRules = [
  {
    id: "OPENAI_OR_GENERIC_SK_KEY",
    pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: "ANTHROPIC_KEY",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: "AWS_ACCESS_KEY_ID",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  },
  {
    id: "GITHUB_TOKEN",
    pattern:
      /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g,
  },
  {
    id: "GOOGLE_API_KEY",
    pattern: /\bAIza[A-Za-z0-9_-]{30,}\b/g,
  },
  {
    id: "SLACK_TOKEN",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    id: "PRIVATE_KEY_BLOCK",
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
];

export function auditReleaseInventory(
  packageSummary,
  { root = packageRoot } = {},
) {
  if (!packageSummary || !Array.isArray(packageSummary.files)) {
    throw new Error("npm pack manifest contains no file inventory.");
  }

  const findings = [];
  for (const entry of packageSummary.files) {
    const relative = entry.path.replaceAll("\\", "/");
    const segments = relative.split("/");
    if (
      segments.some((segment) => forbiddenSegments.has(segment)) ||
      forbiddenNames.has(path.posix.basename(relative)) ||
      (path.posix.basename(relative).startsWith(".env") &&
        relative !== ".env.example")
    ) {
      findings.push({ file: relative, rule: "FORBIDDEN_PUBLICATION_MEMBER" });
      continue;
    }

    const resolved = path.resolve(root, relative);
    if (
      !resolved.startsWith(`${root}${path.sep}`) ||
      !fs.statSync(resolved, { throwIfNoEntry: false })?.isFile()
    ) {
      findings.push({ file: relative, rule: "INVALID_PUBLICATION_PATH" });
      continue;
    }
    if (entry.size > 2 * 1024 * 1024) {
      findings.push({ file: relative, rule: "UNREVIEWABLY_LARGE_FILE" });
      continue;
    }

    const buffer = fs.readFileSync(resolved);
    if (buffer.includes(0)) continue;
    const text = buffer.toString("utf8");
    for (const rule of secretRules) {
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(text)) {
        findings.push({ file: relative, rule: rule.id });
      }
    }
    if (
      relative.startsWith(".github/") &&
      /\.(?:ya?ml)$/i.test(relative)
    ) {
      for (const match of text.matchAll(/^\s*uses:\s*([^\s#]+).*$/gm)) {
        const action = match[1];
        if (action.startsWith("./") || action.startsWith("docker://")) {
          continue;
        }
        const separator = action.lastIndexOf("@");
        const revision =
          separator >= 0 ? action.slice(separator + 1) : "";
        if (!/^[0-9a-f]{40}$/i.test(revision)) {
          findings.push({
            file: relative,
            rule: "MUTABLE_GITHUB_ACTION_REFERENCE",
          });
        }
      }
    }
  }

  if (findings.length) {
    const safeList = findings
      .map(({ file, rule }) => `- ${file}: ${rule}`)
      .join("\n");
    throw new Error(
      `Release audit found ${findings.length} publication risk(s). Matched values are intentionally suppressed:\n${safeList}`,
    );
  }

  return { fileCount: packageSummary.files.length };
}

export function auditRepositoryInventory(
  relativeFiles,
  { root = packageRoot } = {},
) {
  if (!Array.isArray(relativeFiles)) {
    throw new Error("Repository audit requires an explicit file inventory.");
  }

  const findings = [];
  const normalizedFiles = [...new Set(relativeFiles)]
    .map((file) => file.replaceAll("\\", "/"))
    .filter(Boolean)
    .sort();
  for (const relative of normalizedFiles) {
    const segments = relative.split("/");
    const basename = path.posix.basename(relative);
    if (
      relative.startsWith("/") ||
      segments.includes("..") ||
      segments.some((segment) => repositoryForbiddenSegments.has(segment)) ||
      forbiddenNames.has(basename) ||
      basename.endsWith(".tgz") ||
      basename.startsWith(".site-output-staging-") ||
      (basename.startsWith(".env") && relative !== ".env.example")
    ) {
      findings.push({
        file: relative,
        rule: "FORBIDDEN_REPOSITORY_MEMBER",
      });
      continue;
    }

    const resolved = path.resolve(root, relative);
    if (!resolved.startsWith(`${root}${path.sep}`)) {
      findings.push({ file: relative, rule: "INVALID_REPOSITORY_PATH" });
      continue;
    }
    const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      findings.push({ file: relative, rule: "INVALID_REPOSITORY_MEMBER" });
      continue;
    }
    if (stat.size > 2 * 1024 * 1024) {
      findings.push({ file: relative, rule: "UNREVIEWABLY_LARGE_FILE" });
      continue;
    }

    const buffer = fs.readFileSync(resolved);
    if (buffer.includes(0)) continue;
    const text = buffer.toString("utf8");
    for (const rule of secretRules) {
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(text)) {
        findings.push({ file: relative, rule: rule.id });
      }
    }
  }

  const ignoreFile = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  for (const requiredRule of [
    /^\.env\s*$/m,
    /^\.site-output-staging-\*\/\s*$/m,
  ]) {
    if (!requiredRule.test(ignoreFile)) {
      findings.push({
        file: ".gitignore",
        rule: "REQUIRED_PUBLICATION_IGNORE_MISSING",
      });
    }
  }

  if (findings.length) {
    const safeList = findings
      .map(({ file, rule }) => `- ${file}: ${rule}`)
      .join("\n");
    throw new Error(
      `Repository audit found ${findings.length} publication risk(s). Matched values are intentionally suppressed:\n${safeList}`,
    );
  }

  return { fileCount: normalizedFiles.length };
}

function readManifest(manifestArgument) {
  const manifestPath = path.resolve(packageRoot, manifestArgument);
  try {
    const [summary] = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return summary;
  } catch (error) {
    throw new Error(`Cannot read npm pack manifest: ${error.message}`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [manifestArgument] = process.argv.slice(2);
  if (!manifestArgument) {
    throw new Error(
      "Usage: node scripts/release-audit.mjs <npm-pack-manifest.json>",
    );
  }
  const result = auditReleaseInventory(readManifest(manifestArgument));
  console.log(
    `release audit passed: ${result.fileCount} publishable files; no forbidden members or recognized credential patterns`,
  );
}
