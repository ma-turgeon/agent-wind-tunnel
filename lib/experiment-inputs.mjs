import fs from "node:fs";
import path from "node:path";
import {
  canonicalHash,
  deepClone,
  deepFreeze,
} from "./util.mjs";
import { validateScenario } from "./validate.mjs";

const MAX_INPUT_BYTES = 2 * 1024 * 1024;

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function plainObject(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null),
  );
}

function exactKeys(value, keys, code, context) {
  if (!plainObject(value)) fail(code, `${context} must be a plain object.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(code, `${context} must contain exactly: ${expected.join(", ")}.`);
  }
}

function readJson(inputPath, cwd = process.cwd()) {
  const resolved = path.resolve(cwd, inputPath);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (error) {
    fail("INPUT_FILE_UNREADABLE", `Cannot read ${resolved}: ${error.message}`);
  }
  if (!stat.isFile()) fail("INPUT_FILE_INVALID", `${resolved} is not a regular file.`);
  if (stat.size > MAX_INPUT_BYTES) {
    fail("INPUT_FILE_TOO_LARGE", `${resolved} exceeds the ${MAX_INPUT_BYTES}-byte limit.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (error) {
    fail("INPUT_JSON_INVALID", `${resolved} is not valid JSON: ${error.message}`);
  }
  return { parsed, resolved };
}

export function validateScenarioPack(pack, candidateIds = []) {
  exactKeys(
    pack,
    ["schemaVersion", "id", "provenance", "claimBoundary", "scenarios"],
    "INVALID_SCENARIO_PACK",
    "scenario pack",
  );
  if (pack.schemaVersion !== "agent-wind-tunnel.scenario-pack/v1") {
    fail("INVALID_SCENARIO_PACK_SCHEMA", "Unsupported scenario-pack schema version.");
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(pack.id)) {
    fail("INVALID_SCENARIO_PACK", "Scenario-pack id must be kebab-case.");
  }
  exactKeys(
    pack.provenance,
    ["sourceType", "frameworkRefs"],
    "INVALID_SCENARIO_PACK_PROVENANCE",
    "scenario-pack provenance",
  );
  const sourceTypes = new Set([
    "synthetic",
    "composite",
    "public-benchmark",
    "organization-internal",
  ]);
  if (
    !sourceTypes.has(pack.provenance.sourceType) ||
    !Array.isArray(pack.provenance.frameworkRefs) ||
    pack.provenance.frameworkRefs.length === 0 ||
    !pack.provenance.frameworkRefs.every(
      (reference) => typeof reference === "string" && reference.trim(),
    ) ||
    new Set(pack.provenance.frameworkRefs).size !==
      pack.provenance.frameworkRefs.length
  ) {
    fail(
      "INVALID_SCENARIO_PACK_PROVENANCE",
      "Scenario-pack provenance needs a supported sourceType and unique frameworkRefs strings.",
    );
  }
  exactKeys(
    pack.claimBoundary,
    ["evaluationUse", "syntheticOrComposite", "statement"],
    "INVALID_SCENARIO_PACK_CLAIM_BOUNDARY",
    "scenario-pack claimBoundary",
  );
  if (
    !["calibration", "held-out"].includes(pack.claimBoundary.evaluationUse) ||
    typeof pack.claimBoundary.syntheticOrComposite !== "boolean" ||
    typeof pack.claimBoundary.statement !== "string" ||
    !pack.claimBoundary.statement.trim()
  ) {
    fail(
      "INVALID_SCENARIO_PACK_CLAIM_BOUNDARY",
      "Scenario-pack claimBoundary needs evaluationUse, syntheticOrComposite, and a non-empty statement.",
    );
  }
  const declaredSyntheticOrComposite = ["synthetic", "composite"].includes(
    pack.provenance.sourceType,
  );
  if (
    pack.claimBoundary.syntheticOrComposite !== declaredSyntheticOrComposite
  ) {
    fail(
      "SCENARIO_PACK_DISCLOSURE_MISMATCH",
      "syntheticOrComposite must agree with provenance.sourceType.",
    );
  }
  if (!Array.isArray(pack.scenarios) || pack.scenarios.length === 0) {
    fail("INVALID_SCENARIO_PACK", "Scenario pack must contain at least one scenario.");
  }
  const ids = new Set();
  const candidates = new Set(candidateIds);
  for (const scenario of pack.scenarios) {
    validateScenario(scenario);
    if (ids.has(scenario.id)) {
      fail("DUPLICATE_SCENARIO_ID", `Scenario pack repeats ${scenario.id}.`);
    }
    ids.add(scenario.id);
    if (candidates.size && !candidates.has(scenario.oracle.expectedWinner)) {
      fail(
        "UNKNOWN_EXPECTED_WINNER",
        `${scenario.id} expects unknown candidate ${scenario.oracle.expectedWinner}.`,
      );
    }
  }
  return {
    valid: true,
    id: pack.id,
    scenarioCount: pack.scenarios.length,
  };
}

export function loadScenarioPack(inputPath, {
  cwd = process.cwd(),
  candidateIds = [],
} = {}) {
  const { parsed, resolved } = readJson(inputPath, cwd);
  const validation = validateScenarioPack(parsed, candidateIds);
  return deepFreeze({
    pack: deepClone(parsed),
    scenarios: deepClone(parsed.scenarios),
    validation,
    source: {
      name: path.basename(resolved),
      sha256: canonicalHash(parsed),
    },
  });
}

export function validatePriceCard(card) {
  exactKeys(
    card,
    [
      "schemaVersion",
      "currency",
      "effectiveDate",
      "provenance",
      "models",
    ],
    "INVALID_PRICE_CARD",
    "price card",
  );
  if (card.schemaVersion !== "agent-wind-tunnel.price-card/v1") {
    fail("INVALID_PRICE_CARD_SCHEMA", "Unsupported price-card schema version.");
  }
  if (card.currency !== "USD") {
    fail("INVALID_PRICE_CARD", "Price-card currency must be USD for the v1 USD-denominated fields.");
  }
  exactKeys(
    card.provenance,
    [
      "sourceUrl",
      "retrievedAt",
      "serviceTier",
      "contextTier",
      "regionalUpliftAssumption",
      "notes",
      "claimBoundary",
    ],
    "INVALID_PRICE_CARD_PROVENANCE",
    "price-card provenance",
  );
  let sourceUrl;
  try {
    sourceUrl = new URL(card.provenance.sourceUrl);
  } catch {
    sourceUrl = null;
  }
  if (
    sourceUrl?.protocol !== "https:" ||
    ![
      "serviceTier",
      "contextTier",
      "regionalUpliftAssumption",
      "notes",
      "claimBoundary",
    ].every(
      (field) =>
        typeof card.provenance[field] === "string" &&
        card.provenance[field].trim(),
    )
  ) {
    fail(
      "INVALID_PRICE_CARD_PROVENANCE",
      "Price-card provenance needs an HTTPS sourceUrl and non-empty service/context/uplift/notes/claim fields.",
    );
  }
  const retrievedDate = new Date(`${card.provenance.retrievedAt}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(card.provenance.retrievedAt) ||
    Number.isNaN(retrievedDate.getTime()) ||
    retrievedDate.toISOString().slice(0, 10) !==
      card.provenance.retrievedAt
  ) {
    fail(
      "INVALID_PRICE_CARD_PROVENANCE",
      "Price-card provenance retrievedAt must be a real YYYY-MM-DD date.",
    );
  }
  const parsedDate = new Date(`${card.effectiveDate}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(card.effectiveDate) ||
    Number.isNaN(parsedDate.getTime()) ||
    parsedDate.toISOString().slice(0, 10) !== card.effectiveDate
  ) {
    fail("INVALID_PRICE_CARD", "Price-card effectiveDate must be YYYY-MM-DD.");
  }
  if (!Array.isArray(card.models) || card.models.length === 0) {
    fail("INVALID_PRICE_CARD", "Price card must contain at least one model.");
  }
  const ids = new Set();
  for (const model of card.models) {
    exactKeys(
      model,
      [
        "id",
        "inputUsdPerMillionTokens",
        "cachedInputUsdPerMillionTokens",
        "cacheWriteInputUsdPerMillionTokens",
        "outputUsdPerMillionTokens",
      ],
      "INVALID_PRICE_CARD_MODEL",
      "price-card model",
    );
    if (
      typeof model.id !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(model.id) ||
      ids.has(model.id)
    ) {
      fail("INVALID_PRICE_CARD_MODEL", "Price-card model IDs must be unique and valid.");
    }
    ids.add(model.id);
    for (const field of [
      "inputUsdPerMillionTokens",
      "cachedInputUsdPerMillionTokens",
      "cacheWriteInputUsdPerMillionTokens",
      "outputUsdPerMillionTokens",
    ]) {
      if (!Number.isFinite(model[field]) || model[field] < 0) {
        fail("INVALID_PRICE_CARD_MODEL", `${model.id}/${field} must be a nonnegative number.`);
      }
    }
  }
  return { valid: true, modelCount: card.models.length };
}

export function loadPriceCard(inputPath, {
  cwd = process.cwd(),
  modelId = null,
} = {}) {
  const { parsed, resolved } = readJson(inputPath, cwd);
  const validation = validatePriceCard(parsed);
  const model = modelId == null
    ? null
    : parsed.models.find((candidate) => candidate.id === modelId);
  if (modelId != null && !model) {
    fail("PRICE_MODEL_NOT_FOUND", `Price card has no exact entry for model ${modelId}.`);
  }
  return deepFreeze({
    card: deepClone(parsed),
    model: model ? deepClone(model) : null,
    validation,
    source: {
      name: path.basename(resolved),
      sha256: canonicalHash(parsed),
    },
  });
}

export function estimateUsageCost(usage, pricing) {
  const values = {
    inputTokens: usage.inputTokens ?? 0,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
    cacheWriteInputTokens: usage.cacheWriteInputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
  };
  if (
    Object.values(values).some((value) => !Number.isFinite(value) || value < 0) ||
    values.cachedInputTokens + values.cacheWriteInputTokens > values.inputTokens
  ) {
    fail("INVALID_USAGE_FOR_PRICING", "Token usage is inconsistent or negative.");
  }
  const uncachedInputTokens =
    values.inputTokens -
    values.cachedInputTokens -
    values.cacheWriteInputTokens;
  const inputUsd =
    (uncachedInputTokens * pricing.inputUsdPerMillionTokens) / 1_000_000;
  const cachedInputUsd =
    (values.cachedInputTokens * pricing.cachedInputUsdPerMillionTokens) / 1_000_000;
  const cacheWriteInputUsd =
    (values.cacheWriteInputTokens *
      pricing.cacheWriteInputUsdPerMillionTokens) /
    1_000_000;
  const outputUsd =
    (values.outputTokens * pricing.outputUsdPerMillionTokens) / 1_000_000;
  const totalUsd = inputUsd + cachedInputUsd + cacheWriteInputUsd + outputUsd;
  return deepFreeze({
    uncachedInputTokens,
    ...values,
    inputUsd,
    cachedInputUsd,
    cacheWriteInputUsd,
    outputUsd,
    totalUsd: Number(totalUsd.toFixed(10)),
  });
}
