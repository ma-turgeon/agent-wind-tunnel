#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function inventoryNamedTests(root = packageRoot) {
  const testDirectory = path.join(root, "test");
  const files = fs
    .readdirSync(testDirectory)
    .filter((name) => name.endsWith(".test.mjs"))
    .sort();
  const modules = files.map((name) => {
    const source = fs.readFileSync(path.join(testDirectory, name), "utf8");
    return {
      file: `test/${name}`,
      namedCases: [...source.matchAll(/^test\(/gm)].length,
    };
  });
  return {
    schemaVersion: "agent-wind-tunnel.test-inventory/v1",
    moduleCount: modules.length,
    namedCaseCount: modules.reduce(
      (total, module) => total + module.namedCases,
      0,
    ),
    modules,
  };
}

function expectedCount(argv) {
  const index = argv.indexOf("--expect");
  if (index < 0 || !/^[1-9]\d*$/.test(argv[index + 1] ?? "")) {
    throw Object.assign(
      new Error(
        "Usage: node scripts/test-inventory.mjs --expect <positive-integer>",
      ),
      { code: "INVALID_TEST_INVENTORY_ARGUMENT" },
    );
  }
  if (argv.length !== 2) {
    throw Object.assign(
      new Error("Unknown test-inventory argument."),
      { code: "INVALID_TEST_INVENTORY_ARGUMENT" },
    );
  }
  return Number(argv[index + 1]);
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
  const expected = expectedCount(process.argv.slice(2));
  const inventory = inventoryNamedTests();
  if (inventory.namedCaseCount !== expected) {
    throw Object.assign(
      new Error(
        `Named test inventory drifted: expected ${expected}, found ${inventory.namedCaseCount}. Review the suite and update the verified claim deliberately.`,
      ),
      { code: "TEST_INVENTORY_DRIFT" },
    );
  }
  console.log(
    `test inventory verified: ${inventory.namedCaseCount} named test cases across ${inventory.moduleCount} modules`,
  );
}
