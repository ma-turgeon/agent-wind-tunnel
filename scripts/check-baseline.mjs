#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function fail(message) {
  throw Object.assign(new Error(message), { code: "BASELINE_CHECK_FAILED" });
}

function readJson(file) {
  const resolved = path.resolve(file);
  let value;
  try {
    value = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (error) {
    fail(`Cannot read valid JSON from ${resolved}: ${error.message}`);
  }
  return { resolved, value };
}

function exactKeys(value, expected, context) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${context} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(`${context} must contain exactly: ${wanted.join(", ")}.`);
  }
}

function booleanArgument(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  fail("fail-on-regression must be true or false.");
}

function recommendationValue(value, context) {
  if (typeof value !== "string" || !value.trim()) {
    fail(`${context} must be a non-empty string.`);
  }
  return value;
}

function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFileSync(outputFile, `${name}=${String(value)}\n`, "utf8");
  }
}

const [resultsFile, baselineFile, failArgument = "true"] =
  process.argv.slice(2);

if (!resultsFile || !baselineFile) {
  fail(
    "Usage: node scripts/check-baseline.mjs <results.json> <baseline.json> [true|false]",
  );
}

const failOnRegression = booleanArgument(failArgument);
const results = readJson(resultsFile);
const baseline = readJson(baselineFile);

exactKeys(
  baseline.value,
  ["schemaVersion", "portfolioRecommendation", "scenarioRecommendations"],
  "baseline",
);
if (
  baseline.value.schemaVersion !==
  "agent-wind-tunnel.recommendation-baseline/v1"
) {
  fail("Unsupported recommendation-baseline schema version.");
}
exactKeys(
  baseline.value.scenarioRecommendations,
  Object.keys(baseline.value.scenarioRecommendations),
  "scenarioRecommendations",
);

const actualPortfolio = recommendationValue(
  results.value.portfolioRecommendation?.blueprintId ??
    results.value.portfolioRecommendation?.status,
  "results portfolio recommendation",
);
const actualScenarios = Object.fromEntries(
  (results.value.recommendations ?? []).map((item) => [
    recommendationValue(item.scenarioId, "scenario id"),
    recommendationValue(
      item.blueprintId ?? item.status,
      `${item.scenarioId} recommendation`,
    ),
  ]),
);

const differences = [];
if (actualPortfolio !== baseline.value.portfolioRecommendation) {
  differences.push(
    `portfolio: expected ${baseline.value.portfolioRecommendation}, received ${actualPortfolio}`,
  );
}
for (const [scenarioId, expected] of Object.entries(
  baseline.value.scenarioRecommendations,
)) {
  const actual = actualScenarios[scenarioId];
  if (actual !== expected) {
    differences.push(
      `${scenarioId}: expected ${expected}, received ${actual ?? "missing"}`,
    );
  }
}
for (const scenarioId of Object.keys(actualScenarios)) {
  if (!(scenarioId in baseline.value.scenarioRecommendations)) {
    differences.push(`${scenarioId}: no approved baseline entry`);
  }
}

const status = differences.length ? "drift" : "matched";
setOutput("recommendation", actualPortfolio);
setOutput("baseline-status", status);
setOutput("results-path", results.resolved);
setOutput("report-path", path.join(path.dirname(results.resolved), "report.html"));

if (differences.length) {
  const message = `Recommendation baseline drift:\n- ${differences.join("\n- ")}`;
  if (failOnRegression) fail(message);
  console.warn(message);
} else {
  console.log(
    `recommendation baseline matched: ${actualPortfolio} (${baseline.resolved})`,
  );
}
