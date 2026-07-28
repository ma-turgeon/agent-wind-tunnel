import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  verifyPublicLiveEvidence,
  verifyPublicLiveEvidenceFile,
} from "../scripts/verify-public-live-evidence.mjs";
import { canonicalHash, sha256 } from "../lib/util.mjs";

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testRoot, "..");
const priceCardPath = path.join(
  packageRoot,
  "price-cards",
  "openai-standard-short-context-2026-07-28.json",
);
const priceCardBytes = fs.readFileSync(priceCardPath);
const priceCard = JSON.parse(priceCardBytes);

function liveEvidence() {
  return {
    $schema: "../schemas/public-live-evidence.schema.json",
    schemaVersion: "agent-wind-tunnel.public-live-evidence/v1",
    study: {
      id: "live-pilot-2026-07-28",
      title: "Bounded live pilot: direct versus loop",
      executedAt: "2026-07-28T15:20:22.653Z",
      sourceVersion: "agent-wind-tunnel@1.0.0",
      harnessVersion: "1.0.0",
      executionMode: "live",
      provider: "openai",
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
      scenario: {
        id: "operator-doc-gap",
        label: "Operator documentation gap",
        task:
          "Produce a safe batch-analyzer artifact with validation, tests, and an operator runbook.",
        synthetic: true,
      },
      candidates: ["direct", "loop"],
      repetitionsPerCandidate: 3,
      semanticGrader: "none",
      evaluationBoundary:
        "Quality is deterministic declared-requirement conformance, not independently calibrated semantic grading.",
    },
    authorization: {
      maximumLiveCalls: 18,
      plannedCallUpperBound: 18,
      maximumLiveSpendUsd: 1.5,
      plannedSpendUpperBoundUsd: 1.26,
    },
    observed: {
      runs: 6,
      acceptedRuns: 6,
      modelCalls: 9,
      inputTokens: 7418,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 4601,
      totalTokens: 12019,
      tokenUnits: 12019,
      retries: 0,
      estimatedCostUsd: 0.08756,
      elapsedMsSum: 68066,
      maxSingleRunElapsedMs: 17872,
      authorityViolations: 0,
      contractErrors: 0,
    },
    candidateAggregates: [
      {
        candidateId: "direct",
        repetitions: 3,
        acceptedRuns: 3,
        acceptanceRateBps: 10000,
        feasible: true,
        qualityBpsMean: 10000,
        modelCallsMean: 1,
        tokenUnitsMean: 1393,
        latencyMsP95: 11391,
        estimatedCostMeanUsd: 0.0125575,
        authorityViolations: 0,
        contractErrors: 0,
        complexity: {
          nodes: 5,
          edges: 4,
          cycles: 0,
          approvals: 0,
          persistentRoles: 1,
          fanOut: 2,
          score: 76,
        },
      },
      {
        candidateId: "loop",
        repetitions: 3,
        acceptedRuns: 3,
        acceptanceRateBps: 10000,
        feasible: true,
        qualityBpsMean: 10000,
        modelCallsMean: 2,
        tokenUnitsMean: 2613.3333333333335,
        latencyMsP95: 17872,
        estimatedCostMeanUsd: 0.016629166666666667,
        authorityViolations: 0,
        contractErrors: 0,
        complexity: {
          nodes: 7,
          edges: 8,
          cycles: 1,
          approvals: 0,
          persistentRoles: 1,
          fanOut: 4,
          score: 137,
        },
      },
    ],
    runs: [
      {
        candidateId: "direct",
        repetition: 1,
        status: "accepted",
        feasible: true,
        qualityBps: 10000,
        modelCalls: 1,
        inputTokens: 667,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 643,
        totalTokens: 1310,
        tokenUnits: 1310,
        latencyMs: 11391,
        estimatedCostUsd: 0.0113125,
        retries: 0,
        authorityViolations: 0,
        contractCompliant: true,
      },
      {
        candidateId: "loop",
        repetition: 1,
        status: "accepted",
        feasible: true,
        qualityBps: 10000,
        modelCalls: 2,
        inputTokens: 1838,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 814,
        totalTokens: 2652,
        tokenUnits: 2652,
        latencyMs: 9763,
        estimatedCostUsd: 0.016805,
        retries: 0,
        authorityViolations: 0,
        contractCompliant: true,
      },
      {
        candidateId: "loop",
        repetition: 2,
        status: "accepted",
        feasible: true,
        qualityBps: 10000,
        modelCalls: 2,
        inputTokens: 1796,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 839,
        totalTokens: 2635,
        tokenUnits: 2635,
        latencyMs: 17872,
        estimatedCostUsd: 0.017075,
        retries: 0,
        authorityViolations: 0,
        contractCompliant: true,
      },
      {
        candidateId: "direct",
        repetition: 2,
        status: "accepted",
        feasible: true,
        qualityBps: 10000,
        modelCalls: 1,
        inputTokens: 667,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 747,
        totalTokens: 1414,
        tokenUnits: 1414,
        latencyMs: 8349,
        estimatedCostUsd: 0.0128725,
        retries: 0,
        authorityViolations: 0,
        contractCompliant: true,
      },
      {
        candidateId: "direct",
        repetition: 3,
        status: "accepted",
        feasible: true,
        qualityBps: 10000,
        modelCalls: 1,
        inputTokens: 667,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 788,
        totalTokens: 1455,
        tokenUnits: 1455,
        latencyMs: 8087,
        estimatedCostUsd: 0.0134875,
        retries: 0,
        authorityViolations: 0,
        contractCompliant: true,
      },
      {
        candidateId: "loop",
        repetition: 3,
        status: "accepted",
        feasible: true,
        qualityBps: 10000,
        modelCalls: 2,
        inputTokens: 1783,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 770,
        totalTokens: 2553,
        tokenUnits: 2553,
        latencyMs: 12604,
        estimatedCostUsd: 0.0160075,
        retries: 0,
        authorityViolations: 0,
        contractCompliant: true,
      },
    ],
    decision: {
      status: "RECOMMENDED",
      recommendedCandidate: "direct",
      paretoFrontier: ["direct"],
      selectionRule:
        "Select the smallest feasible candidate on the observed Pareto frontier.",
      reason:
        "Both candidates passed the declared checks; direct used fewer calls, tokens, time, and estimated cost.",
    },
    provenance: {
      publicProjection: {
        description:
          "A curated metric projection with no prompts, outputs, traces, or local runtime paths.",
        excludes: [
          "Model prompts and responses",
          "Execution and trace event streams",
          "Local credential and filesystem details",
        ],
        rawBundlePublished: false,
      },
      sourceRun: {
        runId: "awt-20260728151914-51865b5dd33a",
        manifestSha256:
          "5123f94db6805adec7167cc59a686337d982be561eaf1e4295f933fc040d046b",
        resultsSha256:
          "c651709692ecc9c93ef8bb536097844736f41596ae8a2b0b25a77c4cdc9ff985",
        reportMarkdownSha256:
          "96a82f53f97c8e4ea15cf571e42f2f3056df7dd8683376834dc35833ea22c562",
        priceCardSnapshotSha256:
          "ef8d2432a078c9431e3a385c59cc9b327712aafdc8d5cf1e2398a769474dc2d4",
        commitmentBoundary:
          "Hashes commit to retained raw files but do not make the unpublished bundle independently reproducible. The public projection identifies the harness version without publishing a historical Git identifier.",
      },
      priceCard: {
        path: "price-cards/openai-standard-short-context-2026-07-28.json",
        fileSha256: sha256(priceCardBytes),
        canonicalSha256: canonicalHash(priceCard),
        snapshotSha256:
          "ef8d2432a078c9431e3a385c59cc9b327712aafdc8d5cf1e2398a769474dc2d4",
        effectiveDate: "2026-07-28",
        currency: "USD",
        serviceTier: "standard",
        contextTier: "short-context",
        estimateNotInvoice: true,
      },
    },
    claimBoundary: {
      supports: [
        "A bounded six-run live comparison executed under the declared configuration.",
        "The direct candidate was sufficient for this synthetic task sample.",
      ],
      doesNotSupport: [
        "A general model or architecture benchmark.",
        "Production readiness, safety certification, savings, or return-on-investment claims.",
      ],
    },
  };
}

test("public live evidence verifies coherent rows, aggregates, provenance, and decision", () => {
  const result = verifyPublicLiveEvidence(liveEvidence(), {
    root: packageRoot,
  });
  assert.deepEqual(result, {
    schemaVersion: "agent-wind-tunnel.public-live-evidence/v1",
    studyId: "live-pilot-2026-07-28",
    candidateCount: 2,
    runCount: 6,
    recommendedCandidate: "direct",
    estimatedCostUsd: 0.08756,
    priceCardFileSha256:
      "9c6632c00b3f59f172c6e75eeafaa27e54d12c92fd22a242d8eb678be462b489",
  });
  const schema = JSON.parse(
    fs.readFileSync(
      path.join(packageRoot, "schemas", "public-live-evidence.schema.json"),
      "utf8",
    ),
  );
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, Object.keys(liveEvidence()));
});

test("public evidence rejects unknown, sensitive, and local-path fields", () => {
  const unknown = liveEvidence();
  unknown.study.unreviewed = true;
  assert.throws(
    () => verifyPublicLiveEvidence(unknown, { root: packageRoot }),
    (error) => error.code === "INVALID_EVIDENCE_SHAPE",
  );

  const sensitive = liveEvidence();
  sensitive.apiKey = "redacted";
  assert.throws(
    () => verifyPublicLiveEvidence(sensitive, { root: packageRoot }),
    (error) => error.code === "UNSAFE_EVIDENCE_FIELD",
  );

  const localPath = liveEvidence();
  localPath.provenance.publicProjection.description =
    "Retained at /home/example/private/run.json";
  assert.throws(
    () => verifyPublicLiveEvidence(localPath, { root: packageRoot }),
    (error) => error.code === "UNSAFE_EVIDENCE_VALUE",
  );
});

test("public evidence rejects candidate and repetition-set tampering", () => {
  const candidate = liveEvidence();
  candidate.study.candidates = ["direct", "loop", "invented"];
  assert.throws(
    () => verifyPublicLiveEvidence(candidate, { root: packageRoot }),
    (error) => error.code === "EVIDENCE_CANDIDATE_SET_MISMATCH",
  );

  const repetition = liveEvidence();
  repetition.runs[5].repetition = 2;
  assert.throws(
    () => verifyPublicLiveEvidence(repetition, { root: packageRoot }),
    (error) => error.code === "EVIDENCE_REPETITION_SET_MISMATCH",
  );
});

test("public evidence rejects observed-total and authorization tampering", () => {
  const totals = liveEvidence();
  totals.observed.totalTokens += 1;
  assert.throws(
    () => verifyPublicLiveEvidence(totals, { root: packageRoot }),
    (error) => error.code === "EVIDENCE_DERIVATION_MISMATCH",
  );

  const tokenUnits = liveEvidence();
  tokenUnits.runs[0].tokenUnits += 1;
  tokenUnits.observed.tokenUnits += 1;
  tokenUnits.candidateAggregates[0].tokenUnitsMean += 1 / 3;
  assert.throws(
    () => verifyPublicLiveEvidence(tokenUnits, { root: packageRoot }),
    (error) =>
      error.code === "EVIDENCE_DERIVATION_MISMATCH" &&
      /tokenUnits/.test(error.message),
  );

  const envelope = liveEvidence();
  envelope.authorization.maximumLiveCalls = 8;
  envelope.authorization.plannedCallUpperBound = 8;
  assert.throws(
    () => verifyPublicLiveEvidence(envelope, { root: packageRoot }),
    (error) => error.code === "EVIDENCE_AUTHORIZATION_MISMATCH",
  );
});

test("public evidence rejects aggregate mean, P95, and run-cost tampering", () => {
  const aggregate = liveEvidence();
  aggregate.candidateAggregates[0].tokenUnitsMean = 1392;
  assert.throws(
    () => verifyPublicLiveEvidence(aggregate, { root: packageRoot }),
    (error) => error.code === "EVIDENCE_DERIVATION_MISMATCH",
  );

  const p95 = liveEvidence();
  p95.candidateAggregates[1].latencyMsP95 = 12604;
  assert.throws(
    () => verifyPublicLiveEvidence(p95, { root: packageRoot }),
    (error) => error.code === "EVIDENCE_DERIVATION_MISMATCH",
  );

  const cost = liveEvidence();
  cost.runs[0].estimatedCostUsd += 0.001;
  cost.observed.estimatedCostUsd += 0.001;
  cost.candidateAggregates[0].estimatedCostMeanUsd += 0.001 / 3;
  assert.throws(
    () => verifyPublicLiveEvidence(cost, { root: packageRoot }),
    (error) => error.code === "EVIDENCE_DERIVATION_MISMATCH",
  );
});

test("public evidence rejects an undeclared or infeasible recommendation", () => {
  const dominated = liveEvidence();
  dominated.decision.recommendedCandidate = "loop";
  dominated.decision.paretoFrontier = ["loop"];
  assert.throws(
    () => verifyPublicLiveEvidence(dominated, { root: packageRoot }),
    (error) => error.code === "EVIDENCE_DECISION_MISMATCH",
  );

  const undeclared = liveEvidence();
  undeclared.decision.recommendedCandidate = "invented";
  undeclared.decision.paretoFrontier = ["invented"];
  assert.throws(
    () => verifyPublicLiveEvidence(undeclared, { root: packageRoot }),
    (error) => error.code === "EVIDENCE_DECISION_MISMATCH",
  );

  const infeasible = liveEvidence();
  infeasible.runs
    .filter((run) => run.candidateId === "direct")
    .forEach((run) => {
      run.status = "rejected";
      run.feasible = false;
    });
  infeasible.observed.acceptedRuns = 3;
  infeasible.candidateAggregates[0].acceptedRuns = 0;
  infeasible.candidateAggregates[0].acceptanceRateBps = 0;
  infeasible.candidateAggregates[0].feasible = false;
  assert.throws(
    () => verifyPublicLiveEvidence(infeasible, { root: packageRoot }),
    (error) => error.code === "EVIDENCE_DECISION_MISMATCH",
  );
});

test("public evidence binds its source version and price-card commitments", () => {
  const sourceVersion = liveEvidence();
  sourceVersion.study.sourceVersion = "agent-wind-tunnel@1.0.1";
  assert.throws(
    () => verifyPublicLiveEvidence(sourceVersion, { root: packageRoot }),
    (error) =>
      error.code === "EVIDENCE_DERIVATION_MISMATCH" &&
      /sourceVersion/.test(error.message),
  );

  const byteHash = liveEvidence();
  byteHash.provenance.priceCard.fileSha256 = "0".repeat(64);
  assert.throws(
    () => verifyPublicLiveEvidence(byteHash, { root: packageRoot }),
    (error) => error.code === "EVIDENCE_DERIVATION_MISMATCH",
  );

  const canonical = liveEvidence();
  canonical.provenance.priceCard.canonicalSha256 = "1".repeat(64);
  assert.throws(
    () => verifyPublicLiveEvidence(canonical, { root: packageRoot }),
    (error) => error.code === "EVIDENCE_DERIVATION_MISMATCH",
  );

  const snapshot = liveEvidence();
  snapshot.provenance.priceCard.snapshotSha256 = "2".repeat(64);
  assert.throws(
    () => verifyPublicLiveEvidence(snapshot, { root: packageRoot }),
    (error) => error.code === "EVIDENCE_DERIVATION_MISMATCH",
  );
});

test("public evidence file verification rejects duplicate JSON object keys", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-wind-tunnel-public-evidence-"),
  );
  try {
    const file = path.join(directory, "duplicate.json");
    const source = JSON.stringify(liveEvidence());
    fs.writeFileSync(
      file,
      source.replace(
        "{",
        '{"$schema":"../schemas/public-live-evidence.schema.json",',
      ),
      "utf8",
    );
    assert.throws(
      () =>
        verifyPublicLiveEvidenceFile(file, {
          root: packageRoot,
        }),
      (error) => error.code === "DUPLICATE_EVIDENCE_KEY",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
