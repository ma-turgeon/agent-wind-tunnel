import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createFixtureApprovalProvider } from "../lib/authority.mjs";
import { buildBlueprints, POLICY } from "../lib/catalog.mjs";
import {
  loadPriceCard,
  loadScenarioPack,
} from "../lib/experiment-inputs.mjs";
import { FixtureAdapter } from "../lib/fixture-adapter.mjs";
import { runWindTunnel } from "../lib/runner.mjs";

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testRoot, "..");
const caseRoot = path.join(packageRoot, "scenarios", "enterprise-portfolio");
const blueprints = buildBlueprints(packageRoot);
const candidateIds = blueprints.map((blueprint) => blueprint.id);

function approvalProviderFactory({ scenario }) {
  return createFixtureApprovalProvider({
    granted: scenario.fixture.approvalGranted === true,
  });
}

async function runPack(filename) {
  const loaded = loadScenarioPack(path.join(caseRoot, filename), {
    candidateIds,
  });
  const results = await runWindTunnel({
    blueprints,
    scenarios: loaded.scenarios,
    adapter: new FixtureAdapter({ scenarios: loaded.scenarios }),
    policy: POLICY,
    repetitions: 1,
    mode: "fixture",
    approvalProviderFactory,
    scenarioPack: loaded,
  });
  return { loaded, results };
}

test("enterprise portfolio evidence is disclosed and split 6/3", () => {
  const calibration = loadScenarioPack(
    path.join(caseRoot, "calibration.json"),
    { candidateIds },
  );
  const heldOut = loadScenarioPack(path.join(caseRoot, "held-out.json"), {
    candidateIds,
  });
  const dossiers = JSON.parse(
    fs.readFileSync(path.join(caseRoot, "dossiers.json"), "utf8"),
  );

  assert.equal(calibration.validation.scenarioCount, 6);
  assert.equal(calibration.pack.claimBoundary.evaluationUse, "calibration");
  assert.equal(heldOut.validation.scenarioCount, 3);
  assert.equal(heldOut.pack.claimBoundary.evaluationUse, "held-out");
  assert.equal(calibration.pack.provenance.sourceType, "composite");
  assert.equal(heldOut.pack.claimBoundary.syntheticOrComposite, true);
  assert.equal(dossiers.initiatives.length, 9);
  assert.equal(dossiers.capacityEnvelope.unit, "normalized-capacity-points");
  assert.match(dossiers.disclosure, /fictional composite/i);
});

test("checked-in price card is versioned and preserves a narrow claim", () => {
  const loaded = loadPriceCard(
    path.join(
      packageRoot,
      "price-cards",
      "openai-standard-short-context-2026-07-28.json",
    ),
    { modelId: "gpt-5.6-terra" },
  );
  assert.equal(loaded.card.currency, "USD");
  assert.equal(loaded.card.provenance.serviceTier, "standard");
  assert.equal(loaded.card.provenance.contextTier, "short-context");
  assert.match(loaded.card.provenance.sourceUrl, /^https:\/\/developers\.openai\.com\//);
  assert.match(loaded.card.provenance.claimBoundary, /raw provider token counts/i);
  assert.equal(loaded.model.outputUsdPerMillionTokens, 15);
});

test("enterprise calibration pack reproduces declared topology escalation", async () => {
  const { results } = await runPack("calibration.json");
  assert.deepEqual(
    Object.fromEntries(
      results.recommendations.map((item) => [
        item.scenarioId,
        item.blueprintId,
      ]),
    ),
    {
      "capacity-feasible-ranking": "loop",
      "cross-functional-dependency-review": "parallel-review",
      "data-sharing-risk-triage": "parallel-review",
      "evidence-gap-resolution": "loop",
      "high-impact-approval-routing": "graph-max-governed",
      "portfolio-intake-completeness": "direct",
    },
  );
  assert.equal(
    results.portfolioRecommendation.blueprintId,
    "graph-max-governed",
  );
  assert.equal(results.fixtureExpectationsPassed, true);
});

test("enterprise held-out composite stays separate and reproducible", async () => {
  const { results } = await runPack("held-out.json");
  assert.deepEqual(
    Object.fromEntries(
      results.recommendations.map((item) => [
        item.scenarioId,
        item.blueprintId,
      ]),
    ),
    {
      "eligibility-decision-support": "graph-max-governed",
      "procurement-copilot-selection": "parallel-review",
      "service-desk-assistant-pilot": "loop",
    },
  );
  assert.equal(
    results.portfolioRecommendation.blueprintId,
    "graph-max-governed",
  );
  assert.equal(results.fixtureExpectationsPassed, true);
});
