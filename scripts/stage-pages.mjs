#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureInside } from "../lib/util.mjs";

const PUBLIC_ARTIFACT_FILES = [
  ["report.html", "index.html"],
  ["report.md", "report.md"],
  ["results.json", "results.json"],
  ["manifest.json", "manifest.json"],
  ["blueprints.json", "blueprints.json"],
  ["policy.json", "policy.json"],
  ["fixtures.json", "fixtures.json"],
  ["scenario-pack.json", "scenario-pack.json"],
  ["execution.ndjson", "execution.ndjson"],
  ["trace.ndjson", "trace.ndjson"],
];
const OUTPUT_MARKER = ".agent-wind-tunnel-pages-output";
const OUTPUT_MARKER_CONTENTS =
  "agent-wind-tunnel.pages-output/v1\n";
const RESERVED_OUTPUT_ROOTS = new Set([
  ".git",
  ".github",
  "baselines",
  "docs",
  "examples",
  "lib",
  "node_modules",
  "price-cards",
  "scenarios",
  "schemas",
  "scripts",
  "test",
]);

function fail(message, code = "UNSAFE_STAGE_PATH") {
  throw Object.assign(new Error(message), { code });
}

function resolveManagedPath(workspaceRoot, candidate, label) {
  const resolved = ensureInside(
    workspaceRoot,
    path.resolve(workspaceRoot, String(candidate)),
  );
  if (resolved === workspaceRoot) {
    fail(`${label} must not be the workspace root: ${resolved}`);
  }
  return resolved;
}

function contains(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function pathsOverlap(left, right) {
  return contains(left, right) || contains(right, left);
}

function filesUnder(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const resolved = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...filesUnder(resolved));
    } else if (entry.isFile()) {
      files.push(resolved);
    }
  }
  return files;
}

function localReference(rawReference) {
  const value = rawReference.trim();
  if (
    value.startsWith("//") ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)
  ) {
    return null;
  }
  return value;
}

function anchorSet(html) {
  return new Set(
    [...html.matchAll(/\b(?:id|name)=["']([^"']+)["']/gi)].map(
      (match) => match[1],
    ),
  );
}

export function validateLocalSiteLinks(siteRoot) {
  const root = path.resolve(siteRoot);
  const allFiles = filesUnder(root);
  const htmlFiles = allFiles.filter((file) => file.endsWith(".html"));
  const errors = [];
  let localLinkCount = 0;
  const htmlCache = new Map();

  function htmlAt(file) {
    if (!htmlCache.has(file)) {
      htmlCache.set(file, fs.readFileSync(file, "utf8"));
    }
    return htmlCache.get(file);
  }

  for (const htmlFile of htmlFiles) {
    const html = htmlAt(htmlFile);
    if (!/<html\b[^>]*\blang=["'][^"']+["']/i.test(html)) {
      errors.push(`${path.relative(root, htmlFile)}: missing html lang`);
    }
    if (!/<title>\s*[^<\s][^<]*<\/title>/i.test(html)) {
      errors.push(`${path.relative(root, htmlFile)}: missing non-empty title`);
    }

    const references = [
      ...html.matchAll(/\b(?:href|src)=["']([^"']*)["']/gi),
    ].map((match) => match[1]);
    for (const rawReference of references) {
      const reference = localReference(rawReference);
      if (reference == null) continue;
      localLinkCount += 1;

      const hashIndex = reference.indexOf("#");
      const beforeHash =
        hashIndex >= 0 ? reference.slice(0, hashIndex) : reference;
      const fragment =
        hashIndex >= 0 ? reference.slice(hashIndex + 1) : "";
      const pathname = beforeHash.split("?", 1)[0];
      let decodedPathname;
      let decodedFragment;
      try {
        decodedPathname = decodeURIComponent(pathname);
        decodedFragment = decodeURIComponent(fragment);
      } catch {
        errors.push(
          `${path.relative(root, htmlFile)}: invalid URI encoding ${JSON.stringify(reference)}`,
        );
        continue;
      }
      if (decodedPathname.startsWith("/")) {
        errors.push(
          `${path.relative(root, htmlFile)}: root-relative link is not portable on a project Pages site: ${reference}`,
        );
        continue;
      }

      let target = decodedPathname
        ? path.resolve(path.dirname(htmlFile), decodedPathname)
        : htmlFile;
      try {
        target = ensureInside(root, target);
      } catch {
        errors.push(
          `${path.relative(root, htmlFile)}: link escapes the staged site: ${reference}`,
        );
        continue;
      }
      if (fs.statSync(target, { throwIfNoEntry: false })?.isDirectory()) {
        target = path.join(target, "index.html");
      }
      if (!fs.statSync(target, { throwIfNoEntry: false })?.isFile()) {
        errors.push(
          `${path.relative(root, htmlFile)}: missing target for ${reference}`,
        );
        continue;
      }
      if (
        decodedFragment &&
        target.endsWith(".html") &&
        !anchorSet(htmlAt(target)).has(decodedFragment)
      ) {
        errors.push(
          `${path.relative(root, htmlFile)}: missing fragment #${decodedFragment} in ${path.relative(root, target)}`,
        );
      }
    }
  }

  for (const cssFile of allFiles.filter((file) => file.endsWith(".css"))) {
    const css = fs.readFileSync(cssFile, "utf8");
    for (const match of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
      const reference = localReference(match[1]);
      if (reference == null || reference.startsWith("data:")) continue;
      localLinkCount += 1;
      const pathname = reference.split(/[?#]/, 1)[0];
      let target;
      try {
        target = ensureInside(
          root,
          path.resolve(path.dirname(cssFile), decodeURIComponent(pathname)),
        );
      } catch {
        errors.push(
          `${path.relative(root, cssFile)}: invalid or escaping CSS URL ${reference}`,
        );
        continue;
      }
      if (!fs.statSync(target, { throwIfNoEntry: false })?.isFile()) {
        errors.push(
          `${path.relative(root, cssFile)}: missing target for ${reference}`,
        );
      }
    }
  }

  if (errors.length) {
    fail(
      `Staged site validation failed:\n${errors.map((item) => `- ${item}`).join("\n")}`,
      "BROKEN_SITE_LINK",
    );
  }
  return { htmlFileCount: htmlFiles.length, localLinkCount };
}

export function stagePages({
  siteSource,
  reportSource,
  output,
  workspaceRoot = process.cwd(),
}) {
  const root = path.resolve(workspaceRoot);
  const site = resolveManagedPath(root, siteSource, "Site source");
  const reportDirectory = resolveManagedPath(
    root,
    reportSource,
    "Report source",
  );
  const target = resolveManagedPath(root, output, "Pages output");
  const [outputRoot] = path.relative(root, target).split(path.sep);
  if (RESERVED_OUTPUT_ROOTS.has(outputRoot)) {
    fail(
      `Pages output cannot be staged inside reserved project directory ${outputRoot}.`,
      "RESERVED_STAGE_PATH",
    );
  }

  if (
    pathsOverlap(target, site) ||
    pathsOverlap(target, reportDirectory)
  ) {
    fail(
      "Pages output must not equal, contain, or be contained by either source directory.",
      "OVERLAPPING_STAGE_PATH",
    );
  }
  const existingTarget = fs.lstatSync(target, { throwIfNoEntry: false });
  if (existingTarget) {
    const marker = path.join(target, OUTPUT_MARKER);
    let markerContents = null;
    try {
      markerContents = fs.readFileSync(marker, "utf8");
    } catch {
      markerContents = null;
    }
    if (
      !existingTarget.isDirectory() ||
      existingTarget.isSymbolicLink() ||
      markerContents !== OUTPUT_MARKER_CONTENTS
    ) {
      fail(
        `Refusing to replace an output directory not owned by this staging tool: ${target}`,
        "UNOWNED_STAGE_OUTPUT",
      );
    }
  }

  const landing = path.join(site, "index.html");
  const report = path.join(reportDirectory, "report.html");
  if (!fs.statSync(landing, { throwIfNoEntry: false })?.isFile()) {
    fail(`Project site landing page not found: ${landing}`, "MISSING_SITE_SOURCE");
  }
  if (!fs.statSync(report, { throwIfNoEntry: false })?.isFile()) {
    fail(
      `Deterministic report not found: ${report}`,
      "MISSING_REPORT_SOURCE",
    );
  }

  const targetParent = path.dirname(target);
  fs.mkdirSync(targetParent, { recursive: true });
  const staging = fs.mkdtempSync(
    path.join(targetParent, `.${path.basename(target)}-staging-`),
  );
  let stagingExists = true;
  try {
    fs.cpSync(site, staging, { recursive: true });

    const reportOutput = path.join(staging, "report");
    fs.mkdirSync(reportOutput, { recursive: true });
    for (const [sourceName, outputName] of PUBLIC_ARTIFACT_FILES) {
      const source = path.join(reportDirectory, sourceName);
      if (fs.statSync(source, { throwIfNoEntry: false })?.isFile()) {
        fs.copyFileSync(source, path.join(reportOutput, outputName));
      }
    }

    fs.writeFileSync(path.join(staging, ".nojekyll"), "", "utf8");
    fs.writeFileSync(
      path.join(staging, OUTPUT_MARKER),
      OUTPUT_MARKER_CONTENTS,
      "utf8",
    );
    validateLocalSiteLinks(staging);
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
    stagingExists = false;
  } finally {
    if (stagingExists) {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  return target;
}

function argument(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0 || !argv[index + 1]) {
    fail(`Missing required ${name} argument.`, "MISSING_ARGUMENT");
  }
  return argv[index + 1];
}

function isMainModule(invokedPath) {
  if (!invokedPath) return false;
  try {
    return (
      fs.realpathSync(invokedPath) ===
      fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isMainModule(process.argv[1])) {
  const argv = process.argv.slice(2);
  const output = stagePages({
    siteSource: argument(argv, "--site"),
    reportSource: argument(argv, "--report"),
    output: argument(argv, "--output"),
  });
  console.log(`Pages staged: ${output}`);
}
