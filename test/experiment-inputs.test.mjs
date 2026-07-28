import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildLiveCallPlan, main } from "../agent-wind-tunnel.mjs";
import {
  buildBlueprints,
  buildScenarios,
  POLICY,
} from "../lib/catalog.mjs";
import { FixtureAdapter } from "../lib/fixture-adapter.mjs";
import {
  estimateUsageCost,
  loadPriceCard,
  loadScenarioPack,
  validatePriceCard,
  validateScenarioPack,
} from "../lib/experiment-inputs.mjs";
import { deepClone, stableStringify } from "../lib/util.mjs";
import { runWindTunnel } from "../lib/runner.mjs";

const packageRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const candidateIds = buildBlueprints(packageRoot).map((item) => item.id);

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-wind-tunnel-inputs-"));
}

function scenarioPack() {
  return {
    schemaVersion: "agent-wind-tunnel.scenario-pack/v1",
    id: "portfolio-calibration",
    provenance: {
      sourceType: "synthetic",
      frameworkRefs: ["Agent Wind Tunnel built-in calibration corpus"],
    },
    claimBoundary: {
      evaluationUse: "calibration",
      syntheticOrComposite: true,
      statement:
        "Synthetic calibration cases demonstrate harness behavior and are not held-out evidence.",
    },
    scenarios: buildScenarios(),
  };
}

function priceCard() {
  return {
    schemaVersion: "agent-wind-tunnel.price-card/v1",
    currency: "USD",
    effectiveDate: "2026-07-28",
    provenance: {
      sourceUrl: "https://developers.openai.com/api/docs/pricing",
      retrievedAt: "2026-07-28",
      serviceTier: "standard",
      contextTier: "standard-context",
      regionalUpliftAssumption: "No regional uplift included.",
      notes: "Test-only rate assumptions.",
      claimBoundary:
        "Derived estimates are not provider invoices and exclude tool charges.",
    },
    models: [
      {
        id: "portfolio-model",
        inputUsdPerMillionTokens: 2,
        cachedInputUsdPerMillionTokens: 0.5,
        cacheWriteInputUsdPerMillionTokens: 3,
        outputUsdPerMillionTokens: 10,
      },
    ],
  };
}

test("scenario packs load from portable JSON and remain immutable", () => {
  const directory = temporaryDirectory();
  try {
    const file = path.join(directory, "scenarios.json");
    fs.writeFileSync(file, stableStringify(scenarioPack()), "utf8");
    const loaded = loadScenarioPack(file, { candidateIds });
    assert.equal(loaded.validation.valid, true);
    assert.equal(loaded.validation.scenarioCount, 4);
    assert.equal(loaded.source.name, "scenarios.json");
    assert.equal(loaded.source.sha256.length, 64);
    assert.equal(Object.isFrozen(loaded), true);
    assert.equal(Object.isFrozen(loaded.scenarios), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the root module exposes the supported programmatic API", async () => {
  const api = await import("../index.mjs");
  for (const name of [
    "buildBlueprints",
    "buildScenarios",
    "estimateUsageCost",
    "loadPriceCard",
    "loadScenarioPack",
    "runWindTunnel",
    "validateBlueprint",
    "validatePriceCard",
    "validateScenarioPack",
  ]) {
    assert.equal(typeof api[name], "function", `${name} is not exported`);
  }
  assert.equal(typeof api.POLICY, "object");
  assert.equal(api.buildBlueprints().length, 4);
});

test("scenario-pack validation rejects duplicate IDs and unknown winners", () => {
  const duplicate = scenarioPack();
  duplicate.scenarios.push(deepClone(duplicate.scenarios[0]));
  assert.throws(
    () => validateScenarioPack(duplicate, candidateIds),
    (error) => error.code === "DUPLICATE_SCENARIO_ID",
  );

  const unknownWinner = scenarioPack();
  unknownWinner.scenarios[0].oracle.expectedWinner = "invented-topology";
  assert.throws(
    () => validateScenarioPack(unknownWinner, candidateIds),
    (error) => error.code === "UNKNOWN_EXPECTED_WINNER",
  );
});

test("scenario packs reject missing or inconsistent evidence metadata", () => {
  const missing = scenarioPack();
  delete missing.claimBoundary;
  assert.throws(
    () => validateScenarioPack(missing, candidateIds),
    (error) => error.code === "INVALID_SCENARIO_PACK",
  );

  const mismatched = scenarioPack();
  mismatched.claimBoundary.syntheticOrComposite = false;
  assert.throws(
    () => validateScenarioPack(mismatched, candidateIds),
    (error) => error.code === "SCENARIO_PACK_DISCLOSURE_MISMATCH",
  );

  const malformed = scenarioPack();
  malformed.provenance.frameworkRefs = ["duplicate", "duplicate"];
  assert.throws(
    () => validateScenarioPack(malformed, candidateIds),
    (error) => error.code === "INVALID_SCENARIO_PACK_PROVENANCE",
  );

  const unreferenced = scenarioPack();
  unreferenced.provenance.frameworkRefs = [];
  assert.throws(
    () => validateScenarioPack(unreferenced, candidateIds),
    (error) => error.code === "INVALID_SCENARIO_PACK_PROVENANCE",
  );
});

test("price cards require an exact model and produce auditable estimates", () => {
  const directory = temporaryDirectory();
  try {
    const file = path.join(directory, "prices.json");
    fs.writeFileSync(file, stableStringify(priceCard()), "utf8");
    const loaded = loadPriceCard(file, { modelId: "portfolio-model" });
    assert.equal(loaded.validation.valid, true);
    assert.equal(loaded.model.id, "portfolio-model");
    assert.equal(loaded.source.sha256.length, 64);

    const estimate = estimateUsageCost(
      {
        inputTokens: 1_000,
        cachedInputTokens: 200,
        cacheWriteInputTokens: 100,
        outputTokens: 500,
      },
      loaded.model,
    );
    assert.equal(estimate.uncachedInputTokens, 700);
    assert.equal(estimate.totalUsd, 0.0068);

    assert.throws(
      () => loadPriceCard(file, { modelId: "missing-model" }),
      (error) => error.code === "PRICE_MODEL_NOT_FOUND",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("price-card and usage validation fail closed", () => {
  const invalid = priceCard();
  invalid.models[0].outputUsdPerMillionTokens = -1;
  assert.throws(
    () => validatePriceCard(invalid),
    (error) => error.code === "INVALID_PRICE_CARD_MODEL",
  );
  const missingProvenance = priceCard();
  delete missingProvenance.provenance;
  assert.throws(
    () => validatePriceCard(missingProvenance),
    (error) => error.code === "INVALID_PRICE_CARD",
  );
  const badProvenance = priceCard();
  badProvenance.provenance.sourceUrl = "not-a-url";
  assert.throws(
    () => validatePriceCard(badProvenance),
    (error) => error.code === "INVALID_PRICE_CARD_PROVENANCE",
  );
  assert.throws(
    () =>
      estimateUsageCost(
        {
          inputTokens: 10,
          cachedInputTokens: 8,
          cacheWriteInputTokens: 4,
          outputTokens: 1,
        },
        priceCard().models[0],
      ),
    (error) => error.code === "INVALID_USAGE_FOR_PRICING",
  );
});

test("live planning prices the full token budget at the highest applicable rate", () => {
  const card = priceCard();
  const pricing = {
    card,
    model: card.models[0],
    source: { name: "prices.json", sha256: "b".repeat(64) },
  };
  const plan = buildLiveCallPlan({
    blueprints: [
      buildBlueprints(packageRoot).find((candidate) => candidate.id === "direct"),
    ],
    scenarios: [buildScenarios()[0]],
    repetitions: 1,
    maximumAllowed: 2,
    pricing,
    maximumSpendUsd: 0.05,
  });
  assert.equal(plan.upperBound, 2);
  assert.equal(plan.spendUpperBoundUsd, 0.08);
  assert.equal(plan.withinLimit, true);
  assert.equal(plan.withinSpendLimit, false);
  assert.match(plan.pricingMethod, /highest exact-model token rate/);
});

test("run results retain the price-card snapshot and per-run estimate", async () => {
  const scenario = buildScenarios()[0];
  const blueprint = buildBlueprints(packageRoot).find(
    (candidate) => candidate.id === "direct",
  );
  const delegate = new FixtureAdapter({ scenarios: [scenario] });
  const adapter = {
    kind: "priced-test",
    deterministic: false,
    experimentConfiguration: { kind: "priced-test" },
    async invoke(context) {
      const response = await delegate.invoke(context);
      return {
        ...response,
        usage: {
          ...response.usage,
          tokenUnits: 1_500,
          inputTokens: 1_000,
          cachedInputTokens: 200,
          cacheWriteInputTokens: 100,
          outputTokens: 500,
          totalTokens: 1_500,
        },
      };
    },
  };
  const card = priceCard();
  const pricing = {
    card,
    model: card.models[0],
    source: {
      name: "prices.json",
      sha256: (await import("../lib/util.mjs")).canonicalHash(card),
    },
  };
  const results = await runWindTunnel({
    blueprints: [blueprint],
    scenarios: [scenario],
    adapter,
    policy: POLICY,
    mode: "live",
    includeExpectedFixtureChecks: false,
    executionId: "priced-test-run",
    pricing,
  });
  assert.equal(results.pricingSnapshot, card);
  assert.equal(results.provenance.pricing.model, "portfolio-model");
  assert.equal(results.runs[0].efficiency.estimatedCost.totalUsd, 0.0068);
  assert.equal(results.aggregates[0].estimatedCostMean, 0.0068);
});

test("runner rejects price cards and scenario claims not bound to inputs", async () => {
  const scenario = buildScenarios()[0];
  const blueprint = buildBlueprints(packageRoot).find(
    (candidate) => candidate.id === "direct",
  );
  const delegate = new FixtureAdapter({ scenarios: [scenario] });
  const card = priceCard();
  await assert.rejects(
    () =>
      runWindTunnel({
        blueprints: [blueprint],
        scenarios: [scenario],
        adapter: delegate,
        policy: POLICY,
        pricing: {
          card,
          model: card.models[0],
          source: { name: "prices.json", sha256: "0".repeat(64) },
        },
      }),
    (error) => error.code === "INVALID_PRICING",
  );

  const pack = scenarioPack();
  pack.scenarios = [scenario];
  await assert.rejects(
    () =>
      runWindTunnel({
        blueprints: [blueprint],
        scenarios: [scenario],
        adapter: delegate,
        policy: POLICY,
        scenarioPack: {
          pack,
          source: { name: "scenarios.json", sha256: "0".repeat(64) },
        },
      }),
    (error) => error.code === "INVALID_SCENARIO_PACK_BINDING",
  );
});

test("validate and priced dry-run commands consume files without credentials", async () => {
  const directory = temporaryDirectory();
  const output = [];
  const originalLog = console.log;
  try {
    const scenariosFile = path.join(directory, "scenarios.json");
    const customScenariosFile = path.join(directory, "custom-scenarios.json");
    const pricesFile = path.join(directory, "prices.json");
    fs.writeFileSync(scenariosFile, stableStringify(scenarioPack()), "utf8");
    const customPack = scenarioPack();
    customPack.id = "custom-portfolio-calibration";
    customPack.scenarios = [customPack.scenarios[0]];
    customPack.scenarios[0].id = "custom-simple-transform";
    fs.writeFileSync(customScenariosFile, stableStringify(customPack), "utf8");
    fs.writeFileSync(pricesFile, stableStringify(priceCard()), "utf8");
    console.log = (...items) => output.push(items.join(" "));

    assert.equal(
      await main([
        "validate",
        "--scenario-pack",
        scenariosFile,
        "--price-card",
        pricesFile,
      ]),
      0,
    );
    assert.equal(
      await main([
        "run",
        "--adapter",
        "openai",
        "--dry-run",
        "--scenario-pack",
        scenariosFile,
        "--scenario",
        "simple-transform",
        "--candidates",
        "direct",
        "--repetitions",
        "1",
        "--model",
        "portfolio-model",
        "--price-card",
        pricesFile,
      ]),
      0,
    );
    assert.equal(
      await main([
        "run",
        "--adapter",
        "openai",
        "--dry-run",
        "--scenario-pack",
        customScenariosFile,
        "--candidates",
        "direct",
        "--repetitions",
        "1",
        "--max-live-calls",
        "2",
        "--model",
        "portfolio-model",
        "--price-card",
        pricesFile,
      ]),
      0,
    );
  } finally {
    console.log = originalLog;
    fs.rmSync(directory, { recursive: true, force: true });
  }
  assert.match(output.join("\n"), /INPUT VALIDATION/);
  assert.match(output.join("\n"), /Price card: valid/);
  assert.match(output.join("\n"), /dry run \(zero API calls\)/);
  assert.match(output.join("\n"), /exact model match/);
});

test("confirmed runs exceeding the spend cap stop before reading a key", async () => {
  const directory = temporaryDirectory();
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  try {
    const pricesFile = path.join(directory, "prices.json");
    fs.writeFileSync(pricesFile, stableStringify(priceCard()), "utf8");
    console.log = (...items) => logs.push(items.join(" "));
    console.error = (...items) => errors.push(items.join(" "));
    const missingKeyFile = path.join(directory, "does-not-exist.env");

    assert.equal(
      await main([
        "run",
        "--adapter",
        "openai",
        "--dry-run",
        "--scenario",
        "simple-transform",
        "--candidates",
        "direct",
        "--repetitions",
        "1",
        "--model",
        "portfolio-model",
        "--price-card",
        pricesFile,
        "--max-live-spend-usd",
        "0.05",
      ]),
      0,
    );
    assert.equal(
      await main([
        "run",
        "--adapter",
        "openai",
        "--confirm-live",
        "--scenario",
        "simple-transform",
        "--candidates",
        "direct",
        "--repetitions",
        "1",
        "--model",
        "portfolio-model",
        "--price-card",
        pricesFile,
        "--max-live-spend-usd",
        "0.05",
        "--key-env-file",
        missingKeyFile,
      ]),
      1,
    );
  } finally {
    console.log = originalLog;
    console.error = originalError;
    fs.rmSync(directory, { recursive: true, force: true });
  }
  assert.match(logs.join("\n"), /Conservative spend envelope: 0\.080000 USD/);
  assert.match(logs.join("\n"), /Spend ceiling check: BLOCKED/);
  assert.match(errors.join("\n"), /LIVE_SPEND_LIMIT_EXCEEDED/);
  assert.doesNotMatch(errors.join("\n"), /OPENAI_API_KEY_FILE_UNREADABLE/);
});
