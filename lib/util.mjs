import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

export function stableStringify(value, space = 2) {
  return JSON.stringify(stableValue(value), null, space);
}

export function canonicalHash(value) {
  return sha256(stableStringify(value, 0));
}

export function deepClone(value) {
  return structuredClone(value);
}

export function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function ensureInside(parent, target) {
  const resolvedParent = path.resolve(parent);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedParent, resolvedTarget);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw Object.assign(new Error(`Path must stay inside ${resolvedParent}: ${resolvedTarget}`), {
      code: "PATH_OUTSIDE_WORKSPACE",
    });
  }
  let current = resolvedParent;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      throw Object.assign(
        new Error(
          `Path must not traverse a symbolic link inside ${resolvedParent}: ${current}`,
        ),
        { code: "SYMLINK_PATH_COMPONENT" },
      );
    }
  }
  return resolvedTarget;
}

export function loadEnvValue(filePath, envName = "OPENAI_API_KEY") {
  const contents = fs.readFileSync(filePath, "utf8");
  const pattern = new RegExp(`^(?:export\\s+)?${envName}=([^\\r\\n]+)$`, "m");
  const match = contents.match(pattern);
  if (!match) return null;
  let value = match[1].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value || null;
}

export function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

export function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function invariant(condition, code, message) {
  if (!condition) throw Object.assign(new Error(message), { code });
}
