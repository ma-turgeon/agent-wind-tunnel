#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  estimateUsageCost,
  validatePriceCard,
} from "../lib/experiment-inputs.mjs";
import {
  canonicalHash,
  ensureInside,
  mean,
  percentile,
  sha256,
} from "../lib/util.mjs";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const defaultEvidencePath = path.join(
  packageRoot,
  "evidence",
  "live-pilot-2026-07-28.json",
);
const MAX_EVIDENCE_BYTES = 512 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SOURCE_VERSION_PATTERN =
  /^agent-wind-tunnel@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const UNSAFE_KEY_NAMES = new Set([
  "accesskey",
  "accesstoken",
  "apikey",
  "apisecret",
  "authorizationheader",
  "bearertoken",
  "credential",
  "credentialfile",
  "credentialpath",
  "credentials",
  "credentialsource",
  "envfile",
  "githubtoken",
  "keyenvfile",
  "openaiapikey",
  "password",
  "privatekey",
  "secret",
  "secrets",
  "sessiontoken",
]);
const SECRET_PATTERNS = [
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
  /\b(?:OPENAI|ANTHROPIC|GITHUB|AWS)_[A-Z0-9_]*(?:KEY|SECRET|TOKEN)\s*=/i,
];
const ABSOLUTE_PATH_PATTERNS = [
  /^(?:\/|~[\\/]|[A-Za-z]:[\\/]|\\\\|file:\/\/)/,
  /(?:^|[\s("'`])\/(?:etc|home|private|root|tmp|Users|var)(?:\/|\\)/i,
];

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function isPlainObject(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null),
  );
}

function exactKeys(value, keys, location) {
  if (!isPlainObject(value)) {
    fail("INVALID_EVIDENCE_SHAPE", `${location} must be a plain object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(
      "INVALID_EVIDENCE_SHAPE",
      `${location} must contain exactly: ${expected.join(", ")}.`,
    );
  }
}

function assertSafeProjection(value, location = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertSafeProjection(item, `${location}[${index}]`),
    );
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
      if (UNSAFE_KEY_NAMES.has(normalizedKey)) {
        fail(
          "UNSAFE_EVIDENCE_FIELD",
          `${location}.${key} is a sensitive field and cannot appear in public evidence.`,
        );
      }
      assertSafeProjection(child, `${location}.${key}`);
    }
    return;
  }
  if (typeof value !== "string") return;
  if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) {
    fail(
      "UNSAFE_EVIDENCE_VALUE",
      `${location} contains a credential-shaped value.`,
    );
  }
  if (ABSOLUTE_PATH_PATTERNS.some((pattern) => pattern.test(value.trim()))) {
    fail(
      "UNSAFE_EVIDENCE_VALUE",
      `${location} contains a local absolute path.`,
    );
  }
}

function assertString(
  value,
  location,
  { min = 1, max = 10_000, pattern = null, allowed = null } = {},
) {
  if (
    typeof value !== "string" ||
    value.length < min ||
    value.length > max ||
    value !== value.trim() ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ||
    (pattern && !pattern.test(value)) ||
    (allowed && !allowed.includes(value))
  ) {
    fail("INVALID_EVIDENCE_VALUE", `${location} is invalid.`);
  }
}

function assertBoolean(value, location) {
  if (typeof value !== "boolean") {
    fail("INVALID_EVIDENCE_VALUE", `${location} must be boolean.`);
  }
}

function assertNumber(
  value,
  location,
  { integer = false, min = 0, max = Number.MAX_SAFE_INTEGER } = {},
) {
  if (
    !Number.isFinite(value) ||
    (integer && !Number.isSafeInteger(value)) ||
    value < min ||
    value > max
  ) {
    fail("INVALID_EVIDENCE_VALUE", `${location} is outside its valid range.`);
  }
}

function assertDate(value, location) {
  assertString(value, location, { min: 10, max: 10 });
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    fail("INVALID_EVIDENCE_VALUE", `${location} must be a real YYYY-MM-DD date.`);
  }
}

function assertDateTime(value, location) {
  assertString(value, location, { min: 20, max: 35 });
  const parsed = new Date(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) ||
    Number.isNaN(parsed.getTime())
  ) {
    fail(
      "INVALID_EVIDENCE_VALUE",
      `${location} must be an ISO 8601 UTC timestamp.`,
    );
  }
}

function assertStringArray(
  value,
  location,
  { min = 1, max = 100, pattern = null } = {},
) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    fail("INVALID_EVIDENCE_VALUE", `${location} must be a bounded array.`);
  }
  value.forEach((item, index) =>
    assertString(item, `${location}[${index}]`, { pattern }),
  );
  if (new Set(value).size !== value.length) {
    fail("INVALID_EVIDENCE_VALUE", `${location} must not contain duplicates.`);
  }
}

function assertSha256(value, location) {
  assertString(value, location, {
    min: 64,
    max: 64,
    pattern: SHA256_PATTERN,
  });
}

function approximatelyEqual(actual, expected) {
  const scale = Math.max(1, Math.abs(actual), Math.abs(expected));
  return Math.abs(actual - expected) <= Number.EPSILON * 64 * scale;
}

function assertDerived(actual, expected, location) {
  if (
    typeof actual !== typeof expected ||
    (typeof actual === "number"
      ? !approximatelyEqual(actual, expected)
      : actual !== expected)
  ) {
    fail(
      "EVIDENCE_DERIVATION_MISMATCH",
      `${location} is ${actual}; recomputation produced ${expected}.`,
    );
  }
}

function validateStudy(study) {
  exactKeys(
    study,
    [
      "id",
      "title",
      "executedAt",
      "sourceVersion",
      "harnessVersion",
      "executionMode",
      "provider",
      "model",
      "reasoningEffort",
      "scenario",
      "candidates",
      "repetitionsPerCandidate",
      "semanticGrader",
      "evaluationBoundary",
    ],
    "$.study",
  );
  assertString(study.id, "$.study.id", { pattern: ID_PATTERN });
  assertString(study.title, "$.study.title", { max: 200 });
  assertDateTime(study.executedAt, "$.study.executedAt");
  assertString(study.sourceVersion, "$.study.sourceVersion", {
    max: 96,
    pattern: SOURCE_VERSION_PATTERN,
  });
  assertString(study.harnessVersion, "$.study.harnessVersion", {
    max: 64,
    pattern: VERSION_PATTERN,
  });
  assertDerived(
    study.sourceVersion,
    `agent-wind-tunnel@${study.harnessVersion}`,
    "$.study.sourceVersion",
  );
  assertString(study.executionMode, "$.study.executionMode", {
    allowed: ["live"],
  });
  assertString(study.provider, "$.study.provider", {
    max: 64,
    pattern: MODEL_PATTERN,
  });
  assertString(study.model, "$.study.model", {
    max: 128,
    pattern: MODEL_PATTERN,
  });
  assertString(study.reasoningEffort, "$.study.reasoningEffort", {
    allowed: ["low", "medium", "high", "xhigh", "max", "ultra"],
  });
  exactKeys(
    study.scenario,
    ["id", "label", "task", "synthetic"],
    "$.study.scenario",
  );
  assertString(study.scenario.id, "$.study.scenario.id", {
    pattern: ID_PATTERN,
  });
  assertString(study.scenario.label, "$.study.scenario.label", { max: 200 });
  assertString(study.scenario.task, "$.study.scenario.task");
  assertBoolean(study.scenario.synthetic, "$.study.scenario.synthetic");
  assertStringArray(study.candidates, "$.study.candidates", {
    max: 16,
    pattern: ID_PATTERN,
  });
  assertNumber(
    study.repetitionsPerCandidate,
    "$.study.repetitionsPerCandidate",
    { integer: true, min: 1, max: 100 },
  );
  assertString(study.semanticGrader, "$.study.semanticGrader", { max: 200 });
  assertString(study.evaluationBoundary, "$.study.evaluationBoundary");
}

function validateAuthorization(authorization) {
  exactKeys(
    authorization,
    [
      "maximumLiveCalls",
      "plannedCallUpperBound",
      "maximumLiveSpendUsd",
      "plannedSpendUpperBoundUsd",
    ],
    "$.authorization",
  );
  assertNumber(
    authorization.maximumLiveCalls,
    "$.authorization.maximumLiveCalls",
    { integer: true, min: 1, max: 1_000_000 },
  );
  assertNumber(
    authorization.plannedCallUpperBound,
    "$.authorization.plannedCallUpperBound",
    { integer: true, min: 1, max: 1_000_000 },
  );
  assertNumber(
    authorization.maximumLiveSpendUsd,
    "$.authorization.maximumLiveSpendUsd",
    { min: Number.EPSILON, max: 1_000_000 },
  );
  assertNumber(
    authorization.plannedSpendUpperBoundUsd,
    "$.authorization.plannedSpendUpperBoundUsd",
    { min: 0, max: 1_000_000 },
  );
  if (
    authorization.plannedCallUpperBound > authorization.maximumLiveCalls ||
    authorization.plannedSpendUpperBoundUsd >
      authorization.maximumLiveSpendUsd
  ) {
    fail(
      "EVIDENCE_AUTHORIZATION_MISMATCH",
      "Planned call and spend bounds must remain inside the authorized bounds.",
    );
  }
}

function validateObserved(observed) {
  exactKeys(
    observed,
    [
      "runs",
      "acceptedRuns",
      "modelCalls",
      "inputTokens",
      "cachedInputTokens",
      "cacheWriteInputTokens",
      "outputTokens",
      "totalTokens",
      "tokenUnits",
      "retries",
      "estimatedCostUsd",
      "elapsedMsSum",
      "maxSingleRunElapsedMs",
      "authorityViolations",
      "contractErrors",
    ],
    "$.observed",
  );
  for (const key of [
    "runs",
    "acceptedRuns",
    "modelCalls",
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "totalTokens",
    "tokenUnits",
    "retries",
    "elapsedMsSum",
    "maxSingleRunElapsedMs",
    "authorityViolations",
    "contractErrors",
  ]) {
    assertNumber(observed[key], `$.observed.${key}`, {
      integer: true,
      min: key === "runs" ? 1 : 0,
    });
  }
  assertNumber(observed.estimatedCostUsd, "$.observed.estimatedCostUsd", {
    min: 0,
    max: 1_000_000,
  });
}

function validateComplexity(complexity, location) {
  exactKeys(
    complexity,
    [
      "nodes",
      "edges",
      "cycles",
      "approvals",
      "persistentRoles",
      "fanOut",
      "score",
    ],
    location,
  );
  for (const key of Object.keys(complexity)) {
    assertNumber(complexity[key], `${location}.${key}`, {
      integer: true,
      min: 0,
      max: 1_000_000,
    });
  }
}

function validateAggregate(aggregate, index) {
  const location = `$.candidateAggregates[${index}]`;
  exactKeys(
    aggregate,
    [
      "candidateId",
      "repetitions",
      "acceptedRuns",
      "acceptanceRateBps",
      "feasible",
      "qualityBpsMean",
      "modelCallsMean",
      "tokenUnitsMean",
      "latencyMsP95",
      "estimatedCostMeanUsd",
      "authorityViolations",
      "contractErrors",
      "complexity",
    ],
    location,
  );
  assertString(aggregate.candidateId, `${location}.candidateId`, {
    pattern: ID_PATTERN,
  });
  for (const key of [
    "repetitions",
    "acceptedRuns",
    "acceptanceRateBps",
    "latencyMsP95",
    "authorityViolations",
    "contractErrors",
  ]) {
    assertNumber(aggregate[key], `${location}.${key}`, {
      integer: true,
      min: key === "repetitions" ? 1 : 0,
    });
  }
  assertBoolean(aggregate.feasible, `${location}.feasible`);
  for (const key of [
    "qualityBpsMean",
    "modelCallsMean",
    "tokenUnitsMean",
    "estimatedCostMeanUsd",
  ]) {
    assertNumber(aggregate[key], `${location}.${key}`, {
      min: 0,
      max: key.includes("Cost") ? 1_000_000 : Number.MAX_SAFE_INTEGER,
    });
  }
  if (
    aggregate.acceptedRuns > aggregate.repetitions ||
    aggregate.acceptanceRateBps > 10_000 ||
    aggregate.qualityBpsMean > 10_000
  ) {
    fail("INVALID_EVIDENCE_VALUE", `${location} has an impossible rate.`);
  }
  validateComplexity(aggregate.complexity, `${location}.complexity`);
}

function validateRun(run, index) {
  const location = `$.runs[${index}]`;
  exactKeys(
    run,
    [
      "candidateId",
      "repetition",
      "status",
      "feasible",
      "qualityBps",
      "modelCalls",
      "inputTokens",
      "cachedInputTokens",
      "cacheWriteInputTokens",
      "outputTokens",
      "totalTokens",
      "tokenUnits",
      "latencyMs",
      "estimatedCostUsd",
      "retries",
      "authorityViolations",
      "contractCompliant",
    ],
    location,
  );
  assertString(run.candidateId, `${location}.candidateId`, {
    pattern: ID_PATTERN,
  });
  assertNumber(run.repetition, `${location}.repetition`, {
    integer: true,
    min: 1,
    max: 100,
  });
  assertString(run.status, `${location}.status`, {
    allowed: ["accepted", "escalated", "rejected", "error"],
  });
  assertBoolean(run.feasible, `${location}.feasible`);
  assertBoolean(run.contractCompliant, `${location}.contractCompliant`);
  for (const key of [
    "qualityBps",
    "modelCalls",
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "totalTokens",
    "tokenUnits",
    "latencyMs",
    "retries",
    "authorityViolations",
  ]) {
    assertNumber(run[key], `${location}.${key}`, {
      integer: true,
      min: 0,
    });
  }
  assertNumber(run.estimatedCostUsd, `${location}.estimatedCostUsd`, {
    min: 0,
    max: 1_000_000,
  });
  if (run.qualityBps > 10_000) {
    fail("INVALID_EVIDENCE_VALUE", `${location}.qualityBps exceeds 10000.`);
  }
  if (run.cachedInputTokens + run.cacheWriteInputTokens > run.inputTokens) {
    fail(
      "INVALID_EVIDENCE_VALUE",
      `${location} has cached input greater than total input.`,
    );
  }
  if (run.status === "accepted" && (!run.feasible || !run.contractCompliant)) {
    fail(
      "EVIDENCE_STATUS_MISMATCH",
      `${location} cannot be accepted while infeasible or contract-incompliant.`,
    );
  }
  assertDerived(
    run.totalTokens,
    run.inputTokens + run.outputTokens,
    `${location}.totalTokens`,
  );
  assertDerived(
    run.tokenUnits,
    run.totalTokens,
    `${location}.tokenUnits`,
  );
}

function validateDecision(decision) {
  exactKeys(
    decision,
    [
      "status",
      "recommendedCandidate",
      "paretoFrontier",
      "selectionRule",
      "reason",
    ],
    "$.decision",
  );
  assertString(decision.status, "$.decision.status", {
    allowed: ["RECOMMENDED"],
  });
  assertString(
    decision.recommendedCandidate,
    "$.decision.recommendedCandidate",
    { pattern: ID_PATTERN },
  );
  assertStringArray(decision.paretoFrontier, "$.decision.paretoFrontier", {
    max: 16,
    pattern: ID_PATTERN,
  });
  assertString(decision.selectionRule, "$.decision.selectionRule");
  assertString(decision.reason, "$.decision.reason");
}

function validateProvenance(provenance) {
  exactKeys(
    provenance,
    ["publicProjection", "sourceRun", "priceCard"],
    "$.provenance",
  );
  exactKeys(
    provenance.publicProjection,
    ["description", "excludes", "rawBundlePublished"],
    "$.provenance.publicProjection",
  );
  assertString(
    provenance.publicProjection.description,
    "$.provenance.publicProjection.description",
  );
  assertStringArray(
    provenance.publicProjection.excludes,
    "$.provenance.publicProjection.excludes",
    { max: 50 },
  );
  assertBoolean(
    provenance.publicProjection.rawBundlePublished,
    "$.provenance.publicProjection.rawBundlePublished",
  );
  if (provenance.publicProjection.rawBundlePublished !== false) {
    fail(
      "INVALID_EVIDENCE_PROVENANCE",
      "The v1 public projection must disclose that the raw bundle is not published.",
    );
  }

  exactKeys(
    provenance.sourceRun,
    [
      "runId",
      "manifestSha256",
      "resultsSha256",
      "reportMarkdownSha256",
      "priceCardSnapshotSha256",
      "commitmentBoundary",
    ],
    "$.provenance.sourceRun",
  );
  assertString(provenance.sourceRun.runId, "$.provenance.sourceRun.runId", {
    pattern: ID_PATTERN,
  });
  for (const key of [
    "manifestSha256",
    "resultsSha256",
    "reportMarkdownSha256",
    "priceCardSnapshotSha256",
  ]) {
    assertSha256(
      provenance.sourceRun[key],
      `$.provenance.sourceRun.${key}`,
    );
  }
  assertString(
    provenance.sourceRun.commitmentBoundary,
    "$.provenance.sourceRun.commitmentBoundary",
  );

  exactKeys(
    provenance.priceCard,
    [
      "path",
      "fileSha256",
      "canonicalSha256",
      "snapshotSha256",
      "effectiveDate",
      "currency",
      "serviceTier",
      "contextTier",
      "estimateNotInvoice",
    ],
    "$.provenance.priceCard",
  );
  assertString(provenance.priceCard.path, "$.provenance.priceCard.path", {
    max: 240,
    pattern: /^price-cards\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/,
  });
  for (const key of ["fileSha256", "canonicalSha256", "snapshotSha256"]) {
    assertSha256(
      provenance.priceCard[key],
      `$.provenance.priceCard.${key}`,
    );
  }
  assertDate(
    provenance.priceCard.effectiveDate,
    "$.provenance.priceCard.effectiveDate",
  );
  assertString(provenance.priceCard.currency, "$.provenance.priceCard.currency", {
    allowed: ["USD"],
  });
  assertString(
    provenance.priceCard.serviceTier,
    "$.provenance.priceCard.serviceTier",
    { max: 100 },
  );
  assertString(
    provenance.priceCard.contextTier,
    "$.provenance.priceCard.contextTier",
    { max: 100 },
  );
  assertBoolean(
    provenance.priceCard.estimateNotInvoice,
    "$.provenance.priceCard.estimateNotInvoice",
  );
  if (provenance.priceCard.estimateNotInvoice !== true) {
    fail(
      "INVALID_EVIDENCE_PROVENANCE",
      "Public USD estimates must be explicitly marked as not provider invoices.",
    );
  }
  assertDerived(
    provenance.priceCard.snapshotSha256,
    provenance.sourceRun.priceCardSnapshotSha256,
    "$.provenance.priceCard.snapshotSha256",
  );
}

function validateClaimBoundary(claimBoundary) {
  exactKeys(
    claimBoundary,
    ["supports", "doesNotSupport"],
    "$.claimBoundary",
  );
  assertStringArray(claimBoundary.supports, "$.claimBoundary.supports", {
    max: 50,
  });
  assertStringArray(
    claimBoundary.doesNotSupport,
    "$.claimBoundary.doesNotSupport",
    { max: 50 },
  );
}

function checkedInPriceCard(record, root) {
  const relative = record.provenance.priceCard.path;
  if (
    path.isAbsolute(relative) ||
    relative.includes("\\") ||
    path.posix.normalize(relative) !== relative
  ) {
    fail(
      "INVALID_PRICE_CARD_PATH",
      "The evidence price-card path must be a normalized repository-relative POSIX path.",
    );
  }
  let resolved;
  try {
    resolved = ensureInside(root, path.join(root, relative));
  } catch (error) {
    fail("INVALID_PRICE_CARD_PATH", error.message);
  }
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    fail(
      "INVALID_PRICE_CARD_PATH",
      `The checked-in price card is missing or not a regular file: ${relative}.`,
    );
  }
  const bytes = fs.readFileSync(resolved);
  let card;
  try {
    const text = bytes.toString("utf8");
    assertNoDuplicateJsonKeys(text);
    card = JSON.parse(text);
    validatePriceCard(card);
  } catch (error) {
    fail(
      "INVALID_CHECKED_PRICE_CARD",
      `The checked-in price card is invalid: ${error.message}`,
    );
  }
  assertDerived(
    record.provenance.priceCard.fileSha256,
    sha256(bytes),
    "$.provenance.priceCard.fileSha256",
  );
  assertDerived(
    record.provenance.priceCard.canonicalSha256,
    canonicalHash(card),
    "$.provenance.priceCard.canonicalSha256",
  );
  assertDerived(
    record.provenance.priceCard.effectiveDate,
    card.effectiveDate,
    "$.provenance.priceCard.effectiveDate",
  );
  assertDerived(
    record.provenance.priceCard.currency,
    card.currency,
    "$.provenance.priceCard.currency",
  );
  assertDerived(
    record.provenance.priceCard.serviceTier,
    card.provenance.serviceTier,
    "$.provenance.priceCard.serviceTier",
  );
  assertDerived(
    record.provenance.priceCard.contextTier,
    card.provenance.contextTier,
    "$.provenance.priceCard.contextTier",
  );
  const model = card.models.find((candidate) => candidate.id === record.study.model);
  if (!model) {
    fail(
      "PRICE_MODEL_NOT_FOUND",
      `The checked-in price card has no exact entry for ${record.study.model}.`,
    );
  }
  return { card, model };
}

function validateCrossRecord(record, model) {
  const candidateIds = record.study.candidates;
  const candidateSet = new Set(candidateIds);
  if (record.candidateAggregates.length !== candidateIds.length) {
    fail(
      "EVIDENCE_CANDIDATE_SET_MISMATCH",
      "candidateAggregates must contain exactly one row per study candidate.",
    );
  }
  const aggregateIds = record.candidateAggregates.map(
    (aggregate) => aggregate.candidateId,
  );
  if (
    new Set(aggregateIds).size !== aggregateIds.length ||
    aggregateIds.some((candidateId, index) => candidateId !== candidateIds[index])
  ) {
    fail(
      "EVIDENCE_CANDIDATE_SET_MISMATCH",
      "candidateAggregates must match study.candidates exactly and in declared order.",
    );
  }

  const expectedRunCount =
    candidateIds.length * record.study.repetitionsPerCandidate;
  if (record.runs.length !== expectedRunCount) {
    fail(
      "EVIDENCE_REPETITION_SET_MISMATCH",
      `runs must contain exactly ${expectedRunCount} candidate repetitions.`,
    );
  }
  const byCandidate = new Map(candidateIds.map((id) => [id, []]));
  const runKeys = new Set();
  for (const [index, run] of record.runs.entries()) {
    if (!candidateSet.has(run.candidateId)) {
      fail(
        "EVIDENCE_CANDIDATE_SET_MISMATCH",
        `$.runs[${index}] names an undeclared candidate.`,
      );
    }
    const key = `${run.candidateId}\0${run.repetition}`;
    if (runKeys.has(key)) {
      fail(
        "EVIDENCE_REPETITION_SET_MISMATCH",
        `The ${run.candidateId}/${run.repetition} run is duplicated.`,
      );
    }
    runKeys.add(key);
    byCandidate.get(run.candidateId).push(run);
  }
  const expectedRepetitions = Array.from(
    { length: record.study.repetitionsPerCandidate },
    (_, index) => index + 1,
  );
  for (const candidateId of candidateIds) {
    const actual = byCandidate
      .get(candidateId)
      .map((run) => run.repetition)
      .sort((a, b) => a - b);
    if (
      actual.length !== expectedRepetitions.length ||
      actual.some((repetition, index) => repetition !== expectedRepetitions[index])
    ) {
      fail(
        "EVIDENCE_REPETITION_SET_MISMATCH",
        `${candidateId} must contain repetitions 1 through ${record.study.repetitionsPerCandidate}.`,
      );
    }
  }

  const totals = {
    runs: record.runs.length,
    acceptedRuns: record.runs.filter((run) => run.status === "accepted").length,
    modelCalls: record.runs.reduce((sum, run) => sum + run.modelCalls, 0),
    inputTokens: record.runs.reduce((sum, run) => sum + run.inputTokens, 0),
    cachedInputTokens: record.runs.reduce(
      (sum, run) => sum + run.cachedInputTokens,
      0,
    ),
    cacheWriteInputTokens: record.runs.reduce(
      (sum, run) => sum + run.cacheWriteInputTokens,
      0,
    ),
    outputTokens: record.runs.reduce((sum, run) => sum + run.outputTokens, 0),
    totalTokens: record.runs.reduce((sum, run) => sum + run.totalTokens, 0),
    tokenUnits: record.runs.reduce((sum, run) => sum + run.tokenUnits, 0),
    retries: record.runs.reduce((sum, run) => sum + run.retries, 0),
    estimatedCostUsd: record.runs.reduce(
      (sum, run) => sum + run.estimatedCostUsd,
      0,
    ),
    elapsedMsSum: record.runs.reduce((sum, run) => sum + run.latencyMs, 0),
    maxSingleRunElapsedMs: Math.max(
      ...record.runs.map((run) => run.latencyMs),
    ),
    authorityViolations: record.runs.reduce(
      (sum, run) => sum + run.authorityViolations,
      0,
    ),
    contractErrors: record.runs.filter((run) => !run.contractCompliant).length,
  };
  for (const [key, expected] of Object.entries(totals)) {
    assertDerived(record.observed[key], expected, `$.observed.${key}`);
  }

  for (const [index, run] of record.runs.entries()) {
    const expectedCost = estimateUsageCost(
      {
        inputTokens: run.inputTokens,
        cachedInputTokens: run.cachedInputTokens,
        cacheWriteInputTokens: run.cacheWriteInputTokens,
        outputTokens: run.outputTokens,
      },
      model,
    ).totalUsd;
    assertDerived(
      run.estimatedCostUsd,
      expectedCost,
      `$.runs[${index}].estimatedCostUsd`,
    );
  }

  if (
    record.observed.modelCalls > record.authorization.maximumLiveCalls ||
    record.observed.modelCalls > record.authorization.plannedCallUpperBound ||
    record.observed.estimatedCostUsd >
      record.authorization.maximumLiveSpendUsd ||
    record.observed.estimatedCostUsd >
      record.authorization.plannedSpendUpperBoundUsd
  ) {
    fail(
      "EVIDENCE_AUTHORIZATION_MISMATCH",
      "Observed calls or estimated cost exceed the declared authorization envelope.",
    );
  }

  for (const [index, aggregate] of record.candidateAggregates.entries()) {
    const runs = byCandidate.get(aggregate.candidateId);
    const acceptedRuns = runs.filter((run) => run.status === "accepted").length;
    const contractErrors = runs.filter((run) => !run.contractCompliant).length;
    const derived = {
      repetitions: runs.length,
      acceptedRuns,
      acceptanceRateBps: Math.round((acceptedRuns / runs.length) * 10_000),
      feasible: runs.every((run) => run.feasible),
      qualityBpsMean: Math.round(mean(runs.map((run) => run.qualityBps))),
      modelCallsMean: mean(runs.map((run) => run.modelCalls)),
      tokenUnitsMean: mean(runs.map((run) => run.tokenUnits)),
      latencyMsP95: percentile(
        runs.map((run) => run.latencyMs),
        0.95,
      ),
      estimatedCostMeanUsd: mean(
        runs.map((run) => run.estimatedCostUsd),
      ),
      authorityViolations: runs.reduce(
        (sum, run) => sum + run.authorityViolations,
        0,
      ),
      contractErrors,
    };
    for (const [key, expected] of Object.entries(derived)) {
      assertDerived(
        aggregate[key],
        expected,
        `$.candidateAggregates[${index}].${key}`,
      );
    }
  }

  const feasible = record.candidateAggregates.filter(
    (aggregate) =>
      aggregate.feasible &&
      aggregate.acceptanceRateBps === 10_000 &&
      aggregate.authorityViolations === 0 &&
      aggregate.contractErrors === 0,
  );
  if (!feasible.length) {
    fail(
      "INFEASIBLE_EVIDENCE_RECOMMENDATION",
      "A RECOMMENDED decision requires at least one candidate that passes every declared gate.",
    );
  }
  function dominates(left, right) {
    const noWorse =
      left.complexity.score <= right.complexity.score &&
      left.modelCallsMean <= right.modelCallsMean &&
      left.tokenUnitsMean <= right.tokenUnitsMean &&
      left.latencyMsP95 <= right.latencyMsP95;
    const strictlyBetter =
      left.complexity.score < right.complexity.score ||
      left.modelCallsMean < right.modelCallsMean ||
      left.tokenUnitsMean < right.tokenUnitsMean ||
      left.latencyMsP95 < right.latencyMsP95;
    return noWorse && strictlyBetter;
  }
  const frontier = feasible
    .filter(
      (candidate) =>
        !feasible.some(
          (other) => other !== candidate && dominates(other, candidate),
        ),
    )
    .sort(
      (left, right) =>
        left.complexity.score - right.complexity.score ||
        left.modelCallsMean - right.modelCallsMean ||
        left.tokenUnitsMean - right.tokenUnitsMean ||
        left.latencyMsP95 - right.latencyMsP95 ||
        left.candidateId.localeCompare(right.candidateId),
    );
  const expectedFrontier = frontier.map((aggregate) => aggregate.candidateId);
  if (
    record.decision.recommendedCandidate !== expectedFrontier[0] ||
    record.decision.paretoFrontier.length !== expectedFrontier.length ||
    record.decision.paretoFrontier.some(
      (candidateId, index) => candidateId !== expectedFrontier[index],
    )
  ) {
    fail(
      "EVIDENCE_DECISION_MISMATCH",
      `Decision must match recomputation: recommendation=${expectedFrontier[0]}, frontier=${expectedFrontier.join(",")}.`,
    );
  }
}

export function verifyPublicLiveEvidence(
  record,
  { root = packageRoot } = {},
) {
  assertSafeProjection(record);
  exactKeys(
    record,
    [
      "$schema",
      "schemaVersion",
      "study",
      "authorization",
      "observed",
      "candidateAggregates",
      "runs",
      "decision",
      "provenance",
      "claimBoundary",
    ],
    "$",
  );
  assertString(record.$schema, "$.$schema", {
    allowed: ["../schemas/public-live-evidence.schema.json"],
  });
  assertString(record.schemaVersion, "$.schemaVersion", {
    allowed: ["agent-wind-tunnel.public-live-evidence/v1"],
  });
  validateStudy(record.study);
  validateAuthorization(record.authorization);
  validateObserved(record.observed);
  if (
    !Array.isArray(record.candidateAggregates) ||
    record.candidateAggregates.length === 0
  ) {
    fail(
      "INVALID_EVIDENCE_SHAPE",
      "$.candidateAggregates must be a non-empty array.",
    );
  }
  record.candidateAggregates.forEach(validateAggregate);
  if (!Array.isArray(record.runs) || record.runs.length === 0) {
    fail("INVALID_EVIDENCE_SHAPE", "$.runs must be a non-empty array.");
  }
  record.runs.forEach(validateRun);
  validateDecision(record.decision);
  validateProvenance(record.provenance);
  validateClaimBoundary(record.claimBoundary);
  const { model } = checkedInPriceCard(record, path.resolve(root));
  validateCrossRecord(record, model);
  return {
    schemaVersion: record.schemaVersion,
    studyId: record.study.id,
    candidateCount: record.study.candidates.length,
    runCount: record.observed.runs,
    recommendedCandidate: record.decision.recommendedCandidate,
    estimatedCostUsd: record.observed.estimatedCostUsd,
    priceCardFileSha256: record.provenance.priceCard.fileSha256,
  };
}

function assertNoDuplicateJsonKeys(source) {
  let cursor = 0;
  function whitespace() {
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
  }
  function jsonString() {
    whitespace();
    if (source[cursor] !== '"') {
      fail("INVALID_EVIDENCE_JSON", "Expected a JSON string.");
    }
    const start = cursor;
    cursor += 1;
    while (cursor < source.length) {
      if (source[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      if (source[cursor] === '"') {
        cursor += 1;
        try {
          return JSON.parse(source.slice(start, cursor));
        } catch {
          fail("INVALID_EVIDENCE_JSON", "Invalid JSON string escape.");
        }
      }
      cursor += 1;
    }
    fail("INVALID_EVIDENCE_JSON", "Unterminated JSON string.");
  }
  function value() {
    whitespace();
    if (source[cursor] === "{") {
      cursor += 1;
      whitespace();
      const keys = new Set();
      if (source[cursor] === "}") {
        cursor += 1;
        return;
      }
      while (cursor < source.length) {
        const key = jsonString();
        if (keys.has(key)) {
          fail("DUPLICATE_EVIDENCE_KEY", `JSON object repeats key ${key}.`);
        }
        keys.add(key);
        whitespace();
        if (source[cursor] !== ":") {
          fail("INVALID_EVIDENCE_JSON", "Expected ':' after a JSON key.");
        }
        cursor += 1;
        value();
        whitespace();
        if (source[cursor] === "}") {
          cursor += 1;
          return;
        }
        if (source[cursor] !== ",") {
          fail("INVALID_EVIDENCE_JSON", "Expected ',' between JSON members.");
        }
        cursor += 1;
      }
      fail("INVALID_EVIDENCE_JSON", "Unterminated JSON object.");
    }
    if (source[cursor] === "[") {
      cursor += 1;
      whitespace();
      if (source[cursor] === "]") {
        cursor += 1;
        return;
      }
      while (cursor < source.length) {
        value();
        whitespace();
        if (source[cursor] === "]") {
          cursor += 1;
          return;
        }
        if (source[cursor] !== ",") {
          fail("INVALID_EVIDENCE_JSON", "Expected ',' between JSON items.");
        }
        cursor += 1;
      }
      fail("INVALID_EVIDENCE_JSON", "Unterminated JSON array.");
    }
    if (source[cursor] === '"') {
      jsonString();
      return;
    }
    const start = cursor;
    while (
      cursor < source.length &&
      !/[\s,\]}]/.test(source[cursor])
    ) {
      cursor += 1;
    }
    if (cursor === start) {
      fail("INVALID_EVIDENCE_JSON", "Expected a JSON value.");
    }
  }
  value();
  whitespace();
  if (cursor !== source.length) {
    fail("INVALID_EVIDENCE_JSON", "Unexpected trailing JSON content.");
  }
}

export function verifyPublicLiveEvidenceFile(
  inputPath = defaultEvidencePath,
  { root = packageRoot } = {},
) {
  const resolved = path.resolve(inputPath);
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    fail(
      "EVIDENCE_FILE_UNREADABLE",
      `Public evidence is missing or not a regular file: ${resolved}.`,
    );
  }
  if (stat.size > MAX_EVIDENCE_BYTES) {
    fail(
      "EVIDENCE_FILE_TOO_LARGE",
      `Public evidence exceeds ${MAX_EVIDENCE_BYTES} bytes.`,
    );
  }
  const source = fs.readFileSync(resolved, "utf8");
  let record;
  try {
    assertNoDuplicateJsonKeys(source);
    record = JSON.parse(source);
  } catch (error) {
    if (error.code) throw error;
    fail("INVALID_EVIDENCE_JSON", `Public evidence is invalid JSON: ${error.message}`);
  }
  return verifyPublicLiveEvidence(record, { root });
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
  const argumentsList = process.argv.slice(2);
  if (argumentsList.length > 1) {
    fail(
      "INVALID_EVIDENCE_ARGUMENT",
      "Usage: node scripts/verify-public-live-evidence.mjs [evidence.json]",
    );
  }
  const result = verifyPublicLiveEvidenceFile(
    argumentsList[0] ?? defaultEvidencePath,
  );
  console.log(
    `public live evidence verified: ${result.runCount} runs, ${result.candidateCount} candidates, recommendation=${result.recommendedCandidate}, estimated-cost-usd=${result.estimatedCostUsd}`,
  );
}
