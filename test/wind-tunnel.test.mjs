import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  helpText,
  isCliEntrypoint,
  main,
  resolveWorkspaceOutput,
} from "../agent-wind-tunnel.mjs";
import { runAblationStudy } from "../lib/ablations.mjs";
import {
  createAuthorityBroker,
  createFixtureApprovalProvider,
} from "../lib/authority.mjs";
import {
  buildBlueprints,
  buildScenarios,
  POLICY,
} from "../lib/catalog.mjs";
import { FixtureAdapter } from "../lib/fixture-adapter.mjs";
import { resolveOpenAIApiKey } from "../lib/live-config.mjs";
import {
  estimateUsageCost,
  loadPriceCard,
  loadScenarioPack,
  validatePriceCard,
  validateScenarioPack,
} from "../lib/experiment-inputs.mjs";
import {
  boundedRetryDelayMs,
  classifyOpenAIError,
  OpenAIAdapter,
} from "../lib/openai-adapter.mjs";
import { writeArtifactPackage } from "../lib/report.mjs";
import { executeCandidate, runWindTunnel } from "../lib/runner.mjs";
import { canonicalHash, deepClone, stableStringify } from "../lib/util.mjs";
import { auditRepositoryInventory } from "../scripts/release-audit.mjs";
import { stagePages } from "../scripts/stage-pages.mjs";
import {
  blueprintComplexity,
  validateBlueprint,
  validatePolicy,
  validateScenario,
} from "../lib/validate.mjs";

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testRoot, "..");
const projectRoot = packageRoot;
const blueprints = buildBlueprints(projectRoot);
const scenarios = buildScenarios();

test("CLI entrypoint recognizes a package-manager symlink", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "awt-bin-link-"));
  const linkedEntrypoint = path.join(tempRoot, "agent-wind-tunnel");
  try {
    fs.symlinkSync(
      path.join(packageRoot, "agent-wind-tunnel.mjs"),
      linkedEntrypoint,
      "file",
    );
    assert.equal(isCliEntrypoint(linkedEntrypoint), true);
    assert.equal(
      isCliEntrypoint(path.join(packageRoot, "index.mjs")),
      false,
    );
  } finally {
    fs.unlinkSync(linkedEntrypoint);
    fs.rmdirSync(tempRoot);
  }
});

test("workspace output and Pages staging stay inside non-overlapping paths", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "awt-pages-stage-"));
  const externalRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "awt-pages-external-"),
  );
  const siteSource = path.join(tempRoot, "site");
  const reportSource = path.join(tempRoot, "report-source");
  const output = path.join(tempRoot, "public");
  const landingHtml =
    '<!doctype html><html lang="en"><head><title>Wind Tunnel</title><link rel="stylesheet" href="assets/site.css"></head><body><main id="main">Ready</main></body></html>';
  const reportHtml =
    '<!doctype html><html lang="en"><head><title>Verified report</title></head><body>Verified</body></html>';
  try {
    fs.mkdirSync(path.join(siteSource, "assets"), { recursive: true });
    fs.mkdirSync(reportSource);
    fs.writeFileSync(
      path.join(siteSource, "index.html"),
      landingHtml,
      "utf8",
    );
    fs.writeFileSync(
      path.join(siteSource, "assets", "site.css"),
      "body { color: black; }\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(reportSource, "report.html"),
      reportHtml,
      "utf8",
    );
    fs.writeFileSync(
      path.join(reportSource, "results.json"),
      '{"verified":true}\n',
      "utf8",
    );

    assert.equal(
      resolveWorkspaceOutput("safe-output", tempRoot),
      path.join(tempRoot, "safe-output"),
    );
    assert.throws(
      () => resolveWorkspaceOutput("../outside", tempRoot),
      (error) => error.code === "PATH_OUTSIDE_WORKSPACE",
    );
    assert.throws(
      () => resolveWorkspaceOutput(".", tempRoot),
      (error) => error.code === "UNSAFE_OUTPUT_PATH",
    );
    assert.throws(
      () => resolveWorkspaceOutput("docs/generated", tempRoot),
      (error) => error.code === "UNSAFE_OUTPUT_PATH",
    );
    fs.symlinkSync(
      externalRoot,
      path.join(tempRoot, "redirected-output"),
      "dir",
    );
    assert.throws(
      () =>
        resolveWorkspaceOutput(
          "redirected-output/generated",
          tempRoot,
        ),
      (error) => error.code === "SYMLINK_PATH_COMPONENT",
    );
    assert.throws(
      () =>
        stagePages({
          siteSource,
          reportSource,
          output: tempRoot,
          workspaceRoot: tempRoot,
        }),
      (error) => error.code === "UNSAFE_STAGE_PATH",
    );
    assert.throws(
      () =>
        stagePages({
          siteSource,
          reportSource,
          output: siteSource,
          workspaceRoot: tempRoot,
        }),
      (error) => error.code === "OVERLAPPING_STAGE_PATH",
    );
    const unownedOutput = path.join(tempRoot, "unowned");
    fs.mkdirSync(unownedOutput);
    fs.writeFileSync(
      path.join(unownedOutput, "important.txt"),
      "preserve me",
      "utf8",
    );
    assert.throws(
      () =>
        stagePages({
          siteSource,
          reportSource,
          output: unownedOutput,
          workspaceRoot: tempRoot,
        }),
      (error) => error.code === "UNOWNED_STAGE_OUTPUT",
    );
    assert.equal(
      fs.readFileSync(path.join(unownedOutput, "important.txt"), "utf8"),
      "preserve me",
    );
    assert.throws(
      () =>
        stagePages({
          siteSource,
          reportSource,
          output: path.join(tempRoot, "docs", "public"),
          workspaceRoot: tempRoot,
        }),
      (error) => error.code === "RESERVED_STAGE_PATH",
    );

    assert.equal(
      stagePages({
        siteSource,
        reportSource,
        output,
        workspaceRoot: tempRoot,
      }),
      output,
    );
    assert.equal(
      fs.readFileSync(path.join(output, "index.html"), "utf8"),
      landingHtml,
    );
    assert.equal(
      fs.readFileSync(path.join(output, "report", "index.html"), "utf8"),
      reportHtml,
    );
    assert.equal(
      fs.readFileSync(path.join(output, "report", "results.json"), "utf8"),
      '{"verified":true}\n',
    );
    assert.equal(fs.existsSync(path.join(output, ".nojekyll")), true);

    fs.writeFileSync(
      path.join(siteSource, "index.html"),
      '<!doctype html><html lang="en"><head><title>Broken candidate</title></head><body><a href="missing.html">Missing</a></body></html>',
      "utf8",
    );
    assert.throws(
      () =>
        stagePages({
          siteSource,
          reportSource,
          output,
          workspaceRoot: tempRoot,
        }),
      (error) => error.code === "BROKEN_SITE_LINK",
    );
    assert.equal(
      fs.readFileSync(path.join(output, "index.html"), "utf8"),
      landingHtml,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(externalRoot, { recursive: true, force: true });
  }
});

test("repository publication audit includes governance files and fails closed", () => {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "awt-repository-audit-"),
  );
  try {
    fs.mkdirSync(path.join(tempRoot, ".github", "workflows"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tempRoot, ".gitignore"),
      ".env\n.site-output-staging-*/\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(tempRoot, "README.md"),
      "# Safe repository\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(tempRoot, ".github", "workflows", "ci.yml"),
      "name: CI\n",
      "utf8",
    );
    const cleanFiles = [
      ".gitignore",
      ".github/workflows/ci.yml",
      "README.md",
    ];
    assert.deepEqual(
      auditRepositoryInventory(cleanFiles, { root: tempRoot }),
      { fileCount: 3 },
    );

    fs.mkdirSync(path.join(tempRoot, "scratch", "private"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tempRoot, "scratch", "private", "local-notes.md"),
      "Private",
      "utf8",
    );
    assert.throws(
      () =>
        auditRepositoryInventory(
          [...cleanFiles, "scratch/private/local-notes.md"],
          { root: tempRoot },
        ),
      /FORBIDDEN_REPOSITORY_MEMBER/,
    );

    fs.writeFileSync(
      path.join(tempRoot, "unsafe.txt"),
      ["sk", "proj", "A".repeat(28)].join("-"),
      "utf8",
    );
    assert.throws(
      () =>
        auditRepositoryInventory([...cleanFiles, "unsafe.txt"], {
          root: tempRoot,
        }),
      /OPENAI_OR_GENERIC_SK_KEY/,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function fixtureAdapter(options = {}) {
  return new FixtureAdapter({ scenarios, ...options });
}

function trustedFixtureApprovalProviderFactory({ scenario }) {
  return createFixtureApprovalProvider({
    granted: scenario.fixture.approvalGranted === true,
  });
}

async function canonicalResults() {
  return runWindTunnel({
    blueprints,
    scenarios,
    adapter: fixtureAdapter(),
    policy: POLICY,
    repetitions: 1,
    mode: "fixture",
    approvalProviderFactory: trustedFixtureApprovalProviderFactory,
  });
}

test("all canonical blueprints pass static validation", () => {
  assert.equal(validatePolicy(POLICY).valid, true);
  const validations = blueprints.map((blueprint) =>
    validateBlueprint(blueprint, POLICY),
  );
  assert.equal(validations.length, 4);
  assert.ok(validations.every((item) => item.valid));
  assert.ok(validations.every((item) => item.cycleCount >= 0));
});

test("authority policies are closed-world and approval combinations are supported", () => {
  const extraTopLevel = deepClone(POLICY);
  extraTopLevel.notes = "not executable policy";
  assert.throws(
    () => validatePolicy(extraTopLevel),
    (error) => error.code === "INVALID_POLICY_SHAPE",
  );

  const unsupportedApproval = deepClone(POLICY);
  unsupportedApproval.capabilityCatalog.find(
    (item) => item.id === "deploy.production",
  ).approval = "none";
  assert.throws(
    () => validatePolicy(unsupportedApproval),
    (error) => error.code === "UNSUPPORTED_POLICY_COMBINATION",
  );

  const unsupportedEffectClass = deepClone(POLICY);
  unsupportedEffectClass.capabilityCatalog[0].effectClass = "informational";
  assert.throws(
    () => validatePolicy(unsupportedEffectClass),
    (error) => error.code === "UNSUPPORTED_POLICY_COMBINATION",
  );

  const outOfScopeGrant = deepClone(POLICY);
  outOfScopeGrant.initialGrants[0].scopes = ["production"];
  assert.throws(
    () => validatePolicy(outOfScopeGrant),
    (error) => error.code === "INVALID_POLICY_GRANT",
  );

  const preapprovedConsequential = deepClone(POLICY);
  preapprovedConsequential.initialGrants.push({
    capability: "deploy.production",
    scopes: ["demo-service"],
  });
  assert.throws(
    () => validatePolicy(preapprovedConsequential),
    (error) => error.code === "APPROVAL_REQUIRED_GRANT",
  );
});

test("blueprint budgets and runtime contracts are exact", () => {
  const missingBudget = deepClone(blueprints[0]);
  delete missingBudget.budgets.maxRetries;
  assert.throws(
    () => validateBlueprint(missingBudget, POLICY),
    (error) => error.code === "BUDGET_SHAPE_MISMATCH",
  );

  const extraBudget = deepClone(blueprints[0]);
  extraBudget.budgets.maxDollarCost = 1;
  assert.throws(
    () => validateBlueprint(extraBudget, POLICY),
    (error) => error.code === "BUDGET_SHAPE_MISMATCH",
  );

  const forgedState = deepClone(blueprints[0]);
  forgedState.stateContract = "arbitrary.state/v9";
  assert.throws(
    () => validateBlueprint(forgedState, POLICY),
    (error) => error.code === "STATE_CONTRACT_MISMATCH",
  );

  const forgedRoleContract = deepClone(blueprints[0]);
  forgedRoleContract.nodes.find((node) => node.id === "worker").outputContract =
    "unvalidated.output/v1";
  assert.throws(
    () => validateBlueprint(forgedRoleContract, POLICY),
    (error) => error.code === "NODE_CONTRACT_MISMATCH",
  );

  const forgedEffectContract = deepClone(
    blueprints.find((item) => item.id === "graph-max-governed"),
  );
  forgedEffectContract.nodes.find(
    (node) => node.id === "production-effect",
  ).inputContract = "production-effect.input/v1";
  assert.throws(
    () => validateBlueprint(forgedEffectContract, POLICY),
    (error) => error.code === "NODE_CONTRACT_MISMATCH",
  );
});

test("thread metadata is constrained and cannot change complexity score", () => {
  const direct = deepClone(blueprints[0]);
  const relabeled = deepClone(direct);
  relabeled.nodes.find((node) => node.id === "worker").thread = "ephemeral";
  assert.equal(validateBlueprint(relabeled, POLICY).valid, true);
  assert.equal(
    blueprintComplexity(direct).score,
    blueprintComplexity(relabeled).score,
  );
  assert.equal(blueprintComplexity(direct).threadMetadataScored, false);

  const invalidThread = deepClone(direct);
  invalidThread.nodes.find((node) => node.id === "verifier").thread =
    "persistent";
  assert.throws(
    () => validateBlueprint(invalidThread, POLICY),
    (error) => error.code === "THREAD_BINDING_MISMATCH",
  );
});

test("source inspection finds the real Graph Max roles and source hash", () => {
  const graph = blueprints.find((item) => item.id === "graph-max-governed");
  assert.equal(graph.source.derivedFrom.sha256.length, 64);
  assert.deepEqual(graph.source.derivedFrom.inspection.observedRoles, [
    "planner",
    "plan-reviewer",
    "worker",
    "reviewer:structure",
    "reviewer:correctness",
    "reviewer:task-fidelity",
    "synthesizer",
    "presenter",
  ]);
  assert.equal(graph.source.derivedFrom.inspection.observesParallelJoin, true);
});

test("fixture corpus earns direct, loop, parallel, and governed graph in order", async () => {
  const results = await canonicalResults();
  assert.equal(results.fixtureExpectationsPassed, true);
  assert.deepEqual(
    results.recommendations.map((item) => [item.scenarioId, item.blueprintId]),
    [
      ["simple-transform", "direct"],
      ["operator-doc-gap", "loop"],
      ["cross-domain-release", "parallel-review"],
      ["consequential-deploy", "graph-max-governed"],
    ],
  );
  assert.equal(results.portfolioRecommendation.blueprintId, "graph-max-governed");
});

test("runtime executes revised plans and conditional effect routes exactly", async () => {
  const graph = blueprints.find(
    (item) => item.id === "graph-max-governed",
  );
  const consequential = scenarios.find(
    (item) => item.id === "consequential-deploy",
  );
  const governed = await executeCandidate({
    runId: "exact-governed-route-test",
    blueprint: graph,
    scenario: consequential,
    adapter: fixtureAdapter(),
    policy: POLICY,
    approvalProvider: createFixtureApprovalProvider({ granted: true }),
  });
  assert.equal(governed.status, "accepted");
  assert.equal(governed.execution.nodeVisits.planner, 2);
  assert.equal(governed.execution.nodeVisits["plan-reviewer"], 2);
  assert.equal(governed.execution.nodeVisits.worker, 3);
  assert.equal(governed.execution.nodeVisits.approval, 1);
  assert.equal(governed.execution.nodeVisits["production-effect"], 1);
  assert.equal(governed.authority.effectExecutorCalls, 1);
  assert.equal(
    governed.execution.edgeTraversals["plan-review-revise"],
    1,
  );
  assert.equal(
    governed.execution.edgeTraversals["planner-plan-fork"],
    2,
  );

  const reversible = await executeCandidate({
    runId: "exact-nonconsequential-route-test",
    blueprint: graph,
    scenario: scenarios.find((item) => item.id === "simple-transform"),
    adapter: fixtureAdapter(),
    policy: POLICY,
    approvalProvider: createFixtureApprovalProvider({ granted: false }),
  });
  assert.equal(reversible.status, "accepted");
  assert.equal(reversible.execution.nodeVisits.approval, 0);
  assert.equal(reversible.execution.nodeVisits["production-effect"], 0);
  assert.equal(reversible.execution.nodeVisits.presenter, 1);
  assert.equal(reversible.authority.effectExecutorCalls, 0);
  assert.equal(
    reversible.execution.edgeTraversals[
      "synthesis-nonconsequential-presenter"
    ],
    1,
  );
});

test("runtime enforces non-model, edge, and global graph-visit bounds", async () => {
  const scenario = scenarios.find((item) => item.id === "operator-doc-gap");
  const loop = blueprints.find((item) => item.id === "loop");

  const nodeBound = deepClone(loop);
  nodeBound.nodes.find((node) => node.id === "verifier").maxVisits = 1;
  const nodeResult = await executeCandidate({
    runId: "non-model-bound-test",
    blueprint: nodeBound,
    scenario,
    adapter: fixtureAdapter(),
    policy: POLICY,
  });
  assert.equal(nodeResult.status, "budget_exhausted");
  assert.equal(
    nodeResult.reliability.terminalError.code,
    "NODE_VISIT_BUDGET_EXHAUSTED",
  );
  assert.equal(nodeResult.execution.nodeVisits.verifier, 1);

  const edgeBound = deepClone(loop);
  edgeBound.edges.find(
    (edge) => edge.id === "worker-verifier",
  ).maxTraversals = 1;
  const edgeResult = await executeCandidate({
    runId: "edge-bound-test",
    blueprint: edgeBound,
    scenario,
    adapter: fixtureAdapter(),
    policy: POLICY,
  });
  assert.equal(edgeResult.status, "budget_exhausted");
  assert.equal(
    edgeResult.reliability.terminalError.code,
    "EDGE_TRAVERSAL_BUDGET_EXHAUSTED",
  );
  assert.equal(edgeResult.execution.edgeTraversals["worker-verifier"], 1);

  const globalBound = deepClone(loop);
  globalBound.budgets.maxNodeVisits = 4;
  const globalResult = await executeCandidate({
    runId: "global-node-bound-test",
    blueprint: globalBound,
    scenario: scenarios.find((item) => item.id === "simple-transform"),
    adapter: fixtureAdapter(),
    policy: POLICY,
  });
  assert.equal(globalResult.status, "budget_exhausted");
  assert.equal(
    globalResult.reliability.terminalError.code,
    "GLOBAL_NODE_VISIT_BUDGET_EXHAUSTED",
  );
  assert.equal(globalResult.execution.totalNodeVisits, 4);
});

test("two fixture runs are byte-for-byte equivalent", async () => {
  const first = await canonicalResults();
  const second = await canonicalResults();
  assert.equal(stableStringify(first), stableStringify(second));
  assert.equal(canonicalHash(first), canonicalHash(second));
});

test("fixture adapter never receives private fixture or oracle fields", async () => {
  const delegate = fixtureAdapter();
  const observedInputs = [];
  const spy = {
    kind: "fixture",
    deterministic: true,
    async invoke(context) {
      observedInputs.push(stableStringify(context.input, 0));
      return delegate.invoke(context);
    },
  };
  await runWindTunnel({
    blueprints: [blueprints[0]],
    scenarios: [scenarios[0]],
    adapter: spy,
    policy: POLICY,
  });
  assert.ok(observedInputs.length > 0);
  assert.ok(observedInputs.every((input) => !input.includes('"fixture"')));
  assert.ok(observedInputs.every((input) => !input.includes('"oracle"')));
  assert.ok(observedInputs.every((input) => !input.includes('"demonstration"')));
});

test("a malformed model envelope fails closed as a contract error", async () => {
  const result = await executeCandidate({
    runId: "malformed-test",
    blueprint: blueprints[0],
    scenario: scenarios[0],
    adapter: fixtureAdapter({
      faults: { "simple-transform:direct:worker:1": "malformed" },
    }),
    policy: POLICY,
  });
  assert.equal(result.status, "contract_error");
  assert.equal(result.feasible, false);
  assert.equal(result.reliability.contractCompliant, false);
  assert.match(result.trace[0].callId, /^fixture-/);
  assert.equal(result.efficiency.modelCalls, 1);
  assert.equal(result.efficiency.tokenUnits, 1_200);
});

test("a transient timeout retries exactly once and recovers", async () => {
  const result = await executeCandidate({
    runId: "timeout-recovery-test",
    blueprint: blueprints[0],
    scenario: scenarios[0],
    adapter: fixtureAdapter({
      faults: { "simple-transform:direct:worker:1": "timeout" },
    }),
    policy: POLICY,
  });
  assert.equal(result.status, "accepted");
  assert.equal(result.efficiency.modelCalls, 2);
  assert.equal(result.efficiency.retries, 1);
  assert.deepEqual(result.trace.map((event) => event.attempt), [1, 2]);
});

test("repeated timeout stops at the declared retry bound", async () => {
  const result = await executeCandidate({
    runId: "timeout-stop-test",
    blueprint: blueprints[0],
    scenario: scenarios[0],
    adapter: fixtureAdapter({
      faults: {
        "simple-transform:direct:worker:1": "timeout",
        "simple-transform:direct:worker:2": "timeout",
      },
    }),
    policy: POLICY,
  });
  assert.equal(result.status, "timeout");
  assert.equal(result.efficiency.modelCalls, 2);
  assert.equal(result.trace.at(-1).attempt, 2);
});

test("observed paid-failure usage blocks a retry before further spend", async () => {
  const constrained = deepClone(
    blueprints.find((item) => item.id === "direct"),
  );
  constrained.budgets.maxTokenUnits = 1_000;
  const delegate = fixtureAdapter();
  let adapterCalls = 0;
  const adapter = {
    kind: "fixture",
    deterministic: true,
    async invoke(context) {
      adapterCalls += 1;
      if (context.attempt === 1) {
        throw Object.assign(new Error("Paid retryable failure."), {
          code: "TIMEOUT",
          retryable: true,
          usage: {
            tokenUnits: 1_200,
            latencyTicks: 1,
            latencyMs: 0,
          },
        });
      }
      return delegate.invoke(context);
    },
  };
  const result = await executeCandidate({
    runId: "paid-failure-budget-test",
    blueprint: constrained,
    scenario: scenarios.find((item) => item.id === "simple-transform"),
    adapter,
    policy: POLICY,
  });
  assert.equal(result.status, "budget_exhausted");
  assert.equal(result.reliability.terminalError.code, "BUDGET_EXHAUSTED");
  assert.equal(adapterCalls, 1);
  assert.equal(result.efficiency.modelCalls, 1);
  assert.equal(result.efficiency.tokenUnits, 1_200);
  assert.deepEqual(result.trace.map((event) => event.attempt), [1]);
});

test("parallel retry waves gate on combined paid-failure usage", async () => {
  const constrained = deepClone(
    blueprints.find((item) => item.id === "parallel-review"),
  );
  constrained.budgets.maxTokenUnits = 2_000;
  const delegate = fixtureAdapter();
  let adapterCalls = 0;
  const adapter = {
    kind: "fixture",
    deterministic: true,
    async invoke(context) {
      adapterCalls += 1;
      if (context.role.startsWith("reviewer:") && context.attempt === 1) {
        throw Object.assign(new Error("Parallel paid failure."), {
          code: "TIMEOUT",
          retryable: true,
          usage: {
            tokenUnits: 500,
            latencyTicks: 1,
            latencyMs: 0,
          },
        });
      }
      return delegate.invoke(context);
    },
  };
  const result = await executeCandidate({
    runId: "parallel-paid-failure-budget-test",
    blueprint: constrained,
    scenario: scenarios.find((item) => item.id === "simple-transform"),
    adapter,
    policy: POLICY,
  });
  assert.equal(result.status, "budget_exhausted");
  assert.equal(result.reliability.terminalError.code, "BUDGET_EXHAUSTED");
  assert.equal(adapterCalls, 4);
  assert.equal(result.efficiency.modelCalls, 4);
  assert.equal(result.efficiency.tokenUnits, 2_700);
  assert.equal(
    result.trace.filter(
      (event) =>
        event.role.startsWith("reviewer:") && event.attempt === 2,
    ).length,
    0,
  );
});

test("budget exhaustion terminates deterministically", async () => {
  const constrained = deepClone(
    blueprints.find((item) => item.id === "loop"),
  );
  constrained.budgets.maxModelCalls = 1;
  const result = await executeCandidate({
    runId: "budget-test",
    blueprint: constrained,
    scenario: scenarios.find((item) => item.id === "operator-doc-gap"),
    adapter: fixtureAdapter(),
    policy: POLICY,
    approvalProviderFactory: trustedFixtureApprovalProviderFactory,
  });
  assert.equal(result.status, "budget_exhausted");
  assert.equal(result.feasible, false);
  assert.equal(result.reliability.boundedTermination, true);
});

test("unknown permissions are rejected statically", () => {
  const unsafe = deepClone(blueprints[0]);
  unsafe.nodes[0].capabilities.push({
    capability: "invented.root",
    scopes: ["everything"],
  });
  assert.throws(
    () => validateBlueprint(unsafe, POLICY),
    (error) => error.code === "UNKNOWN_CAPABILITY",
  );
});

test("approval bypass edges are rejected statically", () => {
  const unsafe = deepClone(
    blueprints.find((item) => item.id === "graph-max-governed"),
  );
  unsafe.edges.push({
    id: "unsafe-bypass",
    from: "planner",
    to: "production-effect",
    when: { outcomeIn: ["completed"] },
    maxTraversals: 1,
  });
  assert.throws(
    () => validateBlueprint(unsafe, POLICY),
    (error) => error.code === "AUTHORITY_GATE_NOT_DOMINATING",
  );
});

test("unbounded edges are rejected", () => {
  const invalid = deepClone(blueprints[1]);
  invalid.edges[0].maxTraversals = 0;
  assert.throws(
    () => validateBlueprint(invalid, POLICY),
    (error) => error.code === "UNBOUNDED_EDGE",
  );
});

test("permission requests cannot mutate the frozen authority envelope", () => {
  const scenario = scenarios.find((item) => item.id === "consequential-deploy");
  const broker = createAuthorityBroker({
    policy: POLICY,
    scenario,
    blueprint: blueprints[0],
    runId: "authority-test",
  });
  const before = stableStringify(broker.snapshot().frozenGrants);
  const decision = broker.requestPermission({
    capability: "deploy.production",
    scopes: ["demo-service"],
    requestedBy: "worker",
  });
  const after = broker.snapshot();
  assert.equal(decision.decision, "escalated");
  assert.equal(decision.grantsMutated, false);
  assert.equal(stableStringify(after.frozenGrants), before);
  assert.equal(after.effectExecutorCalls, 0);
});

test("model calls require their immutable initial capability grants", async () => {
  const ungrantedPolicy = deepClone(POLICY);
  ungrantedPolicy.initialGrants = [];
  const delegate = fixtureAdapter();
  let adapterCalls = 0;
  const adapter = {
    kind: "fixture",
    deterministic: true,
    async invoke(context) {
      adapterCalls += 1;
      return delegate.invoke(context);
    },
  };
  const result = await executeCandidate({
    runId: "model-grant-enforcement-test",
    blueprint: blueprints.find((item) => item.id === "direct"),
    scenario: scenarios.find((item) => item.id === "simple-transform"),
    adapter,
    policy: ungrantedPolicy,
  });
  assert.equal(result.status, "escalated");
  assert.equal(result.feasible, false);
  assert.equal(adapterCalls, 0);
  assert.equal(result.efficiency.modelCalls, 0);
  assert.equal(result.execution.totalNodeVisits, 0);
  assert.equal(result.authority.audit[0].decision, "escalated");
});

test("unsafe candidates never execute the consequential effect", async () => {
  const results = await canonicalResults();
  const deployRuns = results.runs.filter(
    (run) => run.scenarioId === "consequential-deploy",
  );
  for (const run of deployRuns) {
    if (run.blueprintId === "graph-max-governed") {
      assert.equal(run.authority.effectExecutorCalls, 1);
      assert.equal(run.authority.result.allowed, true);
    } else {
      assert.equal(run.authority.effectExecutorCalls, 0);
      assert.notEqual(run.status, "accepted");
    }
    assert.equal(run.authority.violations, 0);
  }
});

test("ablation identifies safe simplifications and load-bearing reviews", async () => {
  const ablation = await runAblationStudy({
    blueprints,
    scenarios,
    adapter: fixtureAdapter(),
    policy: POLICY,
    approvalProviderFactory: trustedFixtureApprovalProviderFactory,
  });
  assert.equal(ablation.recommendation.blueprintId, "graph-lean");
  assert.equal(
    ablation.portfolio.find((item) => item.blueprintId === "graph-lean")
      .feasibleAcrossCorpus,
    true,
  );
  assert.deepEqual(
    ablation.portfolio.find(
      (item) => item.blueprintId === "graph-ablate-plan-review",
    ).failedScenarios,
    ["consequential-deploy"],
  );
  assert.ok(
    ablation.portfolio
      .find((item) => item.blueprintId === "graph-ablate-security-review")
      .failedScenarios.includes("cross-domain-release"),
  );
});

test("artifact package is reproducible and contains every reader surface", async () => {
  const results = await canonicalResults();
  const ablation = await runAblationStudy({
    blueprints,
    scenarios,
    adapter: fixtureAdapter(),
    policy: POLICY,
    approvalProviderFactory: trustedFixtureApprovalProviderFactory,
  });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-wind-tunnel-test-"));
  const externalRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-wind-tunnel-sentinel-"),
  );
  try {
    const first = writeArtifactPackage({
      results,
      ablation,
      outputDir: path.join(tempRoot, "one"),
      projectRoot: tempRoot,
    });
    const second = writeArtifactPackage({
      results,
      ablation,
      outputDir: path.join(tempRoot, "two"),
      projectRoot: tempRoot,
    });
    assert.deepEqual(first.manifest.files, second.manifest.files);
    for (const name of [
      "manifest.json",
      "blueprints.json",
      "policy.json",
      "fixtures.json",
      "results.json",
      "execution.ndjson",
      "trace.ndjson",
      "report.md",
      "report.html",
    ]) {
      assert.equal(
        fs.readFileSync(path.join(first.outputDir, name), "utf8"),
        fs.readFileSync(path.join(second.outputDir, name), "utf8"),
      );
    }
    const report = fs.readFileSync(
      path.join(first.outputDir, "report.html"),
      "utf8",
    );
    assert.match(report, /Scenario × topology matrix/);
    assert.match(report, /Graph Max ablation ladder/);
    assert.match(report, /Authority broker audit/);
    assert.match(report, /execution\.ndjson/);
    assert.doesNotMatch(report, /\bmissed 76\.92% weighted requirement coverage\b/);
    assert.match(report, /\breached 76\.92% weighted requirement coverage\b/);
    assert.equal(first.manifest.harnessVersion, "1.0.0");
    const payload = fs.readFileSync(
      path.join(first.outputDir, "results.json"),
      "utf8",
    );
    assert.doesNotMatch(payload, /OPENAI_API_KEY|___SECURE/);
    const execution = fs.readFileSync(
      path.join(first.outputDir, "execution.ndjson"),
      "utf8",
    );
    assert.match(execution, /"type":"node-visit"/);
    assert.match(execution, /"type":"edge-transition"/);

    const hostileOutput = path.join(tempRoot, "hostile");
    const sentinel = path.join(externalRoot, "sentinel.html");
    fs.mkdirSync(hostileOutput);
    fs.writeFileSync(sentinel, "do not overwrite", "utf8");
    fs.symlinkSync(
      sentinel,
      path.join(hostileOutput, "report.html"),
      "file",
    );
    assert.throws(
      () =>
        writeArtifactPackage({
          results,
          ablation,
          outputDir: hostileOutput,
          projectRoot: tempRoot,
        }),
      (error) => error.code === "SYMLINK_PATH_COMPONENT",
    );
    assert.equal(fs.readFileSync(sentinel, "utf8"), "do not overwrite");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(externalRoot, { recursive: true, force: true });
  }
});

test("live mode without a key fails clearly before an adapter can fall back", () => {
  assert.throws(
    () =>
      resolveOpenAIApiKey({
        environment: {},
        envFile: null,
        workspaceRoot: projectRoot,
      }),
    (error) => error.code === "OPENAI_API_KEY_MISSING",
  );
});

test("top-level help flags print help without running the demo", async () => {
  const output = [];
  const originalLog = console.log;
  console.log = (...items) => output.push(items.join(" "));
  try {
    assert.equal(await main(["--help"]), 0);
    assert.equal(await main(["-h"]), 0);
  } finally {
    console.log = originalLog;
  }
  assert.equal(output.length, 2);
  assert.equal(output[0], helpText());
  assert.equal(output[1], helpText());
  assert.doesNotMatch(output.join("\n"), /Mode: fixture|Report:/);
});

test("the checked-in Graph Max reference is self-contained", async () => {
  const reference = await import(
    `${path.join(projectRoot, "examples", "graph-max-reference.mjs")}?wind-tunnel-test=1`
  );
  assert.equal(typeof reference.graphMaxReference, "function");
});

test("claimed requirement IDs cannot substitute for substantive artifact material", async () => {
  const delegate = fixtureAdapter();
  const adapter = {
    kind: "fixture",
    deterministic: true,
    experimentConfiguration: { kind: "fixture", adversary: "empty-material" },
    async invoke(context) {
      const response = await delegate.invoke(context);
      if (context.role !== "worker") return response;
      const requirementIds = scenarios
        .find((scenario) => scenario.id === context.scenarioId)
        .requirements.map((requirement) => requirement.id);
      return {
        ...response,
        output: {
          ...response.output,
          artifact: {
            title: "Self-attested artifact",
            summary: "Claims every requirement without supplying checked material.",
            evidence: requirementIds.map((requirementId) => ({
              requirementId,
              detail: "Claim only.",
            })),
            facts: [],
            sections: [],
            testCases: [],
          },
        },
      };
    },
  };
  const result = await executeCandidate({
    runId: "self-attestation-test",
    blueprint: blueprints.find((item) => item.id === "direct"),
    scenario: scenarios.find((item) => item.id === "simple-transform"),
    adapter,
    policy: POLICY,
  });
  assert.equal(result.status, "rejected");
  assert.equal(result.quality.basisPoints, 0);
  assert.deepEqual(result.quality.missingRequirementIds, [
    "formula",
    "invalid-input",
  ]);
});

test("parallel branch failures wait for and account for every started sibling", async () => {
  const result = await executeCandidate({
    runId: "parallel-accounting-test",
    blueprint: blueprints.find((item) => item.id === "parallel-review"),
    scenario: scenarios.find((item) => item.id === "cross-domain-release"),
    adapter: fixtureAdapter({
      faults: {
        "cross-domain-release:parallel-review:reviewer:correctness:1": "timeout",
        "cross-domain-release:parallel-review:reviewer:correctness:2": "timeout",
      },
    }),
    policy: POLICY,
  });
  assert.equal(result.status, "timeout");
  assert.equal(
    result.trace.filter((event) => event.role === "reviewer:correctness").length,
    2,
  );
  assert.equal(
    result.trace.filter((event) => event.role === "reviewer:security").length,
    1,
  );
  assert.equal(
    result.trace.filter((event) => event.role === "reviewer:task-fidelity").length,
    1,
  );
  assert.equal(result.efficiency.modelCalls, 5);
});

test("model-call budgets are reserved before parallel dispatch", async () => {
  const constrained = deepClone(
    blueprints.find((item) => item.id === "parallel-review"),
  );
  constrained.budgets.maxModelCalls = 3;
  const result = await executeCandidate({
    runId: "parallel-budget-reservation-test",
    blueprint: constrained,
    scenario: scenarios.find((item) => item.id === "simple-transform"),
    adapter: fixtureAdapter(),
    policy: POLICY,
  });
  assert.equal(result.status, "budget_exhausted");
  assert.equal(result.efficiency.modelCalls, 3);
  assert.ok(
    result.efficiency.modelCalls <= constrained.budgets.maxModelCalls,
  );
});

test("fatal review verdicts terminate and inconsistent revise verdicts fail contract", async () => {
  const delegate = fixtureAdapter();
  const fatalAdapter = {
    kind: "fixture",
    deterministic: true,
    async invoke(context) {
      const response = await delegate.invoke(context);
      if (context.role !== "reviewer:general") return response;
      return {
        ...response,
        output: {
          verdict: "fatal",
          findings: [
            {
              requirementId: "runbook",
              severity: "fatal",
              message: "Injected terminal review finding.",
            },
          ],
        },
      };
    },
  };
  const fatal = await executeCandidate({
    runId: "fatal-review-test",
    blueprint: blueprints.find((item) => item.id === "loop"),
    scenario: scenarios.find((item) => item.id === "operator-doc-gap"),
    adapter: fatalAdapter,
    policy: POLICY,
  });
  assert.equal(fatal.status, "rejected");
  assert.equal(fatal.reliability.terminalError.code, "FATAL_REVIEW");
  assert.equal(fatal.reliability.contractCompliant, true);

  const inconsistentAdapter = {
    kind: "fixture",
    deterministic: true,
    async invoke(context) {
      const response = await delegate.invoke(context);
      if (context.role !== "reviewer:general") return response;
      return { ...response, output: { verdict: "revise", findings: [] } };
    },
  };
  const inconsistent = await executeCandidate({
    runId: "inconsistent-review-test",
    blueprint: blueprints.find((item) => item.id === "loop"),
    scenario: scenarios.find((item) => item.id === "operator-doc-gap"),
    adapter: inconsistentAdapter,
    policy: POLICY,
  });
  assert.equal(inconsistent.status, "contract_error");
  assert.equal(inconsistent.reliability.contractCompliant, false);
});

test("every completed fatal parallel branch records its reject transition", async () => {
  const delegate = fixtureAdapter();
  const adapter = {
    kind: "fixture",
    deterministic: true,
    async invoke(context) {
      const response = await delegate.invoke(context);
      if (
        context.role !== "reviewer:correctness" &&
        context.role !== "reviewer:security"
      ) {
        return response;
      }
      return {
        ...response,
        output: {
          verdict: "fatal",
          findings: [
            {
              requirementId: "rollback",
              severity: "fatal",
              message: `Injected fatal result from ${context.role}.`,
            },
          ],
        },
      };
    },
  };
  const result = await executeCandidate({
    runId: "parallel-fatal-route-test",
    blueprint: blueprints.find(
      (item) => item.id === "parallel-review",
    ),
    scenario: scenarios.find(
      (item) => item.id === "cross-domain-release",
    ),
    adapter,
    policy: POLICY,
  });
  assert.equal(result.status, "rejected");
  assert.equal(result.execution.nodeVisits.reject, 1);
  assert.equal(
    result.execution.edgeTraversals["correctness-reject"],
    1,
  );
  assert.equal(
    result.execution.edgeTraversals["security-reject"],
    1,
  );
});

test("unresolved revise verdicts remain blocking after the repair budget", async () => {
  const delegate = fixtureAdapter();
  const scenario = scenarios.find((item) => item.id === "simple-transform");
  const blueprint = blueprints.find((item) => item.id === "loop");
  const persistentRevisionAdapter = (severity) => ({
    kind: "fixture",
    deterministic: true,
    async invoke(context) {
      const response = await delegate.invoke(context);
      if (context.role !== "reviewer:general") return response;
      return {
        ...response,
        output: {
          verdict: "revise",
          findings: [
            {
              requirementId: "formula",
              severity,
              message: `Persistent ${severity}-level revision request.`,
            },
          ],
        },
      };
    },
  });

  for (const severity of ["error", "warning"]) {
    const result = await executeCandidate({
      runId: `persistent-${severity}-revision-test`,
      blueprint,
      scenario,
      adapter: persistentRevisionAdapter(severity),
      policy: POLICY,
    });
    assert.equal(result.quality.basisPoints, 10_000);
    assert.equal(result.quality.evaluationGate.passed, false);
    assert.deepEqual(result.quality.evaluationGate.reviseRoles, [
      "reviewer:general",
    ]);
    assert.equal(result.status, "rejected");
    assert.equal(result.feasible, false);
    assert.equal(result.efficiency.modelCalls, 4);
  }
});

test("feature flags cannot invent graph behavior", () => {
  const forged = deepClone(blueprints.find((item) => item.id === "direct"));
  forged.features.approvalGate = true;
  assert.throws(
    () => validateBlueprint(forged, POLICY),
    (error) => error.code === "FEATURE_TOPOLOGY_MISMATCH",
  );
});

test("live-like runs fail closed without an external approval provider", async () => {
  const delegate = fixtureAdapter();
  const liveLikeAdapter = {
    kind: "openai",
    deterministic: false,
    async invoke(context) {
      return delegate.invoke(context);
    },
  };
  const result = await executeCandidate({
    runId: "unconfigured-live-approval-test",
    blueprint: blueprints.find((item) => item.id === "graph-max-governed"),
    scenario: scenarios.find((item) => item.id === "consequential-deploy"),
    adapter: liveLikeAdapter,
    policy: POLICY,
  });
  assert.equal(result.status, "escalated");
  assert.equal(result.authority.effectExecutorCalls, 0);
  assert.equal(result.authority.approvalProvider, "unconfigured");
});

test("approval bindings are one-time and effect simulation is idempotent", () => {
  const scenario = scenarios.find((item) => item.id === "consequential-deploy");
  const blueprint = blueprints.find((item) => item.id === "graph-max-governed");
  const broker = createAuthorityBroker({
    policy: POLICY,
    scenario,
    blueprint,
    runId: "authority-idempotency-test",
    approvalProvider: createFixtureApprovalProvider({ granted: true }),
  });
  const artifact = { title: "accepted", version: 1 };
  const first = broker.authorizeConsequentialEffect({ artifact });
  const second = broker.authorizeConsequentialEffect({ artifact });
  assert.equal(first.allowed, true);
  assert.equal(first.executed, true);
  assert.equal(second.allowed, true);
  assert.equal(second.replayed, true);
  const snapshot = broker.snapshot();
  assert.equal(snapshot.effectExecutorCalls, 1);
  assert.equal(snapshot.approvalTokens.length, 1);
  assert.equal(snapshot.approvalTokens[0].consumed, true);
  assert.throws(() => snapshot.frozenGrants[0].scopes.push("mutated"));
  assert.deepEqual(
    broker.snapshot().frozenGrants,
    POLICY.initialGrants,
  );
});

test("mandatory requirements and quality thresholds are independent gates", async () => {
  const scenario = deepClone(
    scenarios.find((item) => item.id === "simple-transform"),
  );
  scenario.id = "optional-threshold";
  scenario.label = "Optional threshold";
  scenario.requirements.find((item) => item.id === "invalid-input").mandatory = false;
  scenario.slo.minimumQualityBps = 6_000;
  scenario.fixture.initialArtifactDefects = ["invalid-input"];
  scenario.oracle.expectedWinner = "direct";
  validateScenario(scenario);
  const result = await executeCandidate({
    runId: "optional-threshold-test",
    blueprint: blueprints.find((item) => item.id === "direct"),
    scenario,
    adapter: new FixtureAdapter({ scenarios: [scenario] }),
    policy: POLICY,
  });
  assert.equal(result.quality.basisPoints, 6_000);
  assert.deepEqual(result.quality.mandatoryMissingRequirementIds, []);
  assert.equal(result.status, "accepted");
});

test("experiment fingerprints include fixture faults and live execution IDs are unique", async () => {
  const selectedBlueprints = [
    blueprints.find((item) => item.id === "direct"),
  ];
  const selectedScenarios = [
    scenarios.find((item) => item.id === "simple-transform"),
  ];
  const baseline = await runWindTunnel({
    blueprints: selectedBlueprints,
    scenarios: selectedScenarios,
    adapter: fixtureAdapter(),
    policy: POLICY,
  });
  const faultConfigured = await runWindTunnel({
    blueprints: selectedBlueprints,
    scenarios: selectedScenarios,
    adapter: fixtureAdapter({ faults: { unused: "timeout" } }),
    policy: POLICY,
  });
  assert.notEqual(baseline.runId, faultConfigured.runId);
  assert.notEqual(
    baseline.provenance.experimentFingerprint,
    faultConfigured.provenance.experimentFingerprint,
  );

  const delegate = fixtureAdapter();
  const liveLike = {
    kind: "openai",
    deterministic: false,
    async invoke(context) {
      return delegate.invoke(context);
    },
  };
  const first = await runWindTunnel({
    blueprints: selectedBlueprints,
    scenarios: selectedScenarios,
    adapter: liveLike,
    policy: POLICY,
    includeExpectedFixtureChecks: false,
  });
  const second = await runWindTunnel({
    blueprints: selectedBlueprints,
    scenarios: selectedScenarios,
    adapter: liveLike,
    policy: POLICY,
    includeExpectedFixtureChecks: false,
  });
  assert.notEqual(first.runId, second.runId);
});

test("live contract failures retain paid-response metadata and usage", async () => {
  const adapter = new OpenAIAdapter({
    apiKey: "test-key-never-sent",
    model: "test-model",
    reasoningEffort: "low",
    executionId: "mock-live-contract",
  });
  adapter.client.responses.create = async () => ({
    id: "resp_mock_contract",
    _request_id: "req_mock_contract",
    model: "test-model-returned",
    status: "completed",
    output_text: JSON.stringify({
      artifact: {
        title: "Incomplete artifact",
      },
      evidence: [],
    }),
    output: [],
    usage: {
      input_tokens: 101,
      output_tokens: 23,
      total_tokens: 124,
    },
  });
  await assert.rejects(
    () =>
      adapter.invoke({
        runId: "mock-run",
        scenarioId: "simple-transform",
        blueprintId: "direct",
        role: "worker",
        nodeId: "worker",
        attempt: 1,
        attemptId: "mock-attempt",
        input: { scenario: scenarios[0] },
      }),
    (error) => {
      assert.equal(error.code, "CONTRACT_VIOLATION");
      assert.equal(error.responseId, "resp_mock_contract");
      assert.equal(error.requestId, "req_mock_contract");
      assert.equal(error.returnedModel, "test-model-returned");
      assert.equal(error.usage.totalTokens, 124);
      return true;
    },
  );
});

test("OpenAI errors separate quota/configuration failures from bounded retries", () => {
  const quota = classifyOpenAIError(
    {
      status: 429,
      error: { code: "insufficient_quota" },
      message: "Quota exhausted.",
    },
    { attempt: 1, attemptId: "quota" },
  );
  assert.equal(quota.code, "OPENAI_QUOTA_EXHAUSTED");
  assert.equal(quota.systemic, true);
  assert.equal(quota.retryable, false);

  const rateLimit = classifyOpenAIError(
    {
      status: 429,
      error: { code: "rate_limit_exceeded" },
      message: "Try again.",
      headers: { "retry-after": "99" },
    },
    { attempt: 1, attemptId: "rate-limit" },
  );
  assert.equal(rateLimit.systemic, false);
  assert.equal(rateLimit.retryable, true);
  assert.equal(rateLimit.retryDelayMs, 5_000);
  assert.ok(
    boundedRetryDelayMs({
      attempt: 10,
      attemptId: "cap",
      retryAfterMs: 999_999,
    }) <= 5_000,
  );
});

test("systemic live API failures stop the experiment matrix", async () => {
  const adapter = {
    kind: "openai",
    deterministic: false,
    async invoke() {
      throw Object.assign(new Error("Injected authentication failure."), {
        code: "OPENAI_AUTH_ERROR",
        systemic: true,
        retryable: false,
      });
    },
  };
  await assert.rejects(
    () =>
      runWindTunnel({
        blueprints: [blueprints.find((item) => item.id === "direct")],
        scenarios: [scenarios.find((item) => item.id === "simple-transform")],
        adapter,
        policy: POLICY,
        includeExpectedFixtureChecks: false,
      }),
    (error) =>
      error.code === "OPENAI_AUTH_ERROR" &&
      error.systemic === true &&
      error.partialRunCount === 0,
  );
});

test("explicit env files take precedence without exposing credential values", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "awt-key-config-"));
  try {
    fs.writeFileSync(
      path.join(tempRoot, ".env.local"),
      "OPENAI_API_KEY=file-value-for-test\n",
      { mode: 0o600 },
    );
    const value = resolveOpenAIApiKey({
      environment: { OPENAI_API_KEY: "environment-value-for-test" },
      envFile: ".env.local",
      workspaceRoot: tempRoot,
    });
    assert.equal(value, "file-value-for-test");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("CLI live guardrails reject ambiguity before reading a key", async () => {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...items) => logs.push(items.join(" "));
  console.error = (...items) => errors.push(items.join(" "));
  try {
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
      ]),
      0,
    );
    assert.equal(
      await main(["run", "--adapter", "openai", "--unknown-option"]),
      1,
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
        "--output",
        "../outside-agent-wind-tunnel",
      ]),
      1,
    );
    assert.equal(
      await main([
        "run",
        "--adapter",
        "openai",
        "--confirm-live",
        "--max-live-calls",
        "1",
      ]),
      1,
    );
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.match(logs.join("\n"), /dry run \(zero API calls\)/);
  assert.match(errors.join("\n"), /Unknown option/);
  assert.match(errors.join("\n"), /LIVE_CALL_LIMIT_EXCEEDED/);
  assert.match(errors.join("\n"), /PATH_OUTSIDE_WORKSPACE/);
});

test("adapter inputs are immutable and adapter labels cannot mint fixture approval", async () => {
  const scenario = deepClone(
    scenarios.find((item) => item.id === "consequential-deploy"),
  );
  const delegate = new FixtureAdapter({ scenarios: [scenario] });
  let mutationBlocked = false;
  const spoofedAdapter = {
    kind: "fixture",
    deterministic: false,
    approvalProvider: createFixtureApprovalProvider({ granted: true }),
    async invoke(context) {
      try {
        context.input.scenario.requirements.length = 0;
        context.input.scenario.slo.requiresConsequentialApproval = false;
      } catch {
        mutationBlocked = true;
      }
      return delegate.invoke(context);
    },
  };
  const result = await executeCandidate({
    runId: "adapter-boundary-test",
    blueprint: blueprints.find((item) => item.id === "graph-max-governed"),
    scenario,
    adapter: spoofedAdapter,
    policy: POLICY,
  });
  assert.equal(mutationBlocked, true);
  assert.equal(scenario.requirements.length, 5);
  assert.equal(scenario.slo.requiresConsequentialApproval, true);
  assert.equal(result.status, "escalated");
  assert.equal(result.authority.approvalProvider, "unconfigured");
  assert.equal(result.authority.effectExecutorCalls, 0);
});

test("padding and dummy test cases fail the stronger deterministic checks", async () => {
  const scenario = scenarios.find((item) => item.id === "operator-doc-gap");
  const delegate = fixtureAdapter();
  const paddingAdapter = {
    kind: "fixture",
    deterministic: true,
    async invoke(context) {
      const response = await delegate.invoke(context);
      if (context.role !== "worker") return response;
      return {
        ...response,
        output: {
          artifact: {
            title: "Padded artifact",
            summary: "Attempts to game length and count checks.",
            evidence: scenario.requirements.map((requirement) => ({
              requirementId: requirement.id,
              detail: "Unsupported claim.",
            })),
            facts: [{ id: "execution.default", value: "dry-run" }],
            sections: [
              { id: "input-validation", content: "x ".repeat(200) },
              { id: "runbook", content: "x ".repeat(200) },
            ],
            testCases: [1, 2, 3].map((index) => ({
              id: `dummy-${index}`,
              requirementId: "tests",
              input: "x",
              expectedOutput: "x",
            })),
          },
          evidence: ["padding-adversary"],
        },
      };
    },
  };
  const result = await executeCandidate({
    runId: "padding-adversary-test",
    blueprint: blueprints.find((item) => item.id === "direct"),
    scenario,
    adapter: paddingAdapter,
    policy: POLICY,
  });
  assert.equal(result.status, "rejected");
  assert.deepEqual(result.quality.passedRequirementIds, ["safe-default"]);
  assert.deepEqual(result.quality.missingRequirementIds, [
    "input-validation",
    "tests",
    "runbook",
  ]);
});

test("edge predicates are mandatory and execution features compile from topology", () => {
  const missingPredicate = deepClone(
    blueprints.find((item) => item.id === "direct"),
  );
  delete missingPredicate.edges[0].when;
  assert.throws(
    () => validateBlueprint(missingPredicate, POLICY),
    (error) => error.code === "INVALID_EDGE_CONDITION",
  );
  const impossibleOutcome = deepClone(
    blueprints.find((item) => item.id === "direct"),
  );
  impossibleOutcome.edges[0].when.outcomeIn = ["invented-outcome"];
  assert.throws(
    () => validateBlueprint(impossibleOutcome, POLICY),
    (error) => error.code === "EDGE_OUTCOME_CONTRACT_MISMATCH",
  );
  const swappedTerminals = deepClone(
    blueprints.find((item) => item.id === "direct"),
  );
  swappedTerminals.edges.find((edge) => edge.to === "accept").when.outcomeIn = [
    "fail",
  ];
  swappedTerminals.edges.find((edge) => edge.to === "reject").when.outcomeIn = [
    "pass",
  ];
  assert.throws(
    () => validateBlueprint(swappedTerminals, POLICY),
    (error) => error.code === "TERMINAL_ROUTE_MISMATCH",
  );

  const graph = blueprints.find(
    (item) => item.id === "graph-max-governed",
  );
  const expectRuntimeRouteFailure = (candidate) =>
    assert.throws(
      () => validateBlueprint(candidate, POLICY),
      (error) => error.code === "RUNTIME_ROUTE_MISMATCH",
    );

  const swappedPlanVerdicts = deepClone(graph);
  swappedPlanVerdicts.edges.find(
    (edge) => edge.id === "plan-review-revise",
  ).when.outcomeIn = ["approve"];
  swappedPlanVerdicts.edges.find(
    (edge) => edge.id === "plan-review-join",
  ).when.outcomeIn = ["revise"];
  expectRuntimeRouteFailure(swappedPlanVerdicts);

  const ambiguousPlanApproval = deepClone(graph);
  ambiguousPlanApproval.edges.find(
    (edge) => edge.id === "plan-review-revise",
  ).when.outcomeIn.push("approve");
  expectRuntimeRouteFailure(ambiguousPlanApproval);

  const swappedSynthesisVerdicts = deepClone(graph);
  swappedSynthesisVerdicts.edges.find(
    (edge) => edge.id === "synthesis-repair",
  ).when.outcomeIn = ["pass"];
  swappedSynthesisVerdicts.edges.find(
    (edge) => edge.id === "synthesis-approval",
  ).when.outcomeIn = ["revise"];
  expectRuntimeRouteFailure(swappedSynthesisVerdicts);

  const missingReviewerRevision = deepClone(graph);
  missingReviewerRevision.edges.find(
    (edge) => edge.id === "security-review-join",
  ).when.outcomeIn = ["pass"];
  expectRuntimeRouteFailure(missingReviewerRevision);

  const ambiguousApprovalDecline = deepClone(graph);
  ambiguousApprovalDecline.edges.find(
    (edge) => edge.id === "approval-effect",
  ).when.outcomeIn.push("declined");
  expectRuntimeRouteFailure(ambiguousApprovalDecline);

  const ambiguousMergePass = deepClone(
    blueprints.find((item) => item.id === "loop"),
  );
  ambiguousMergePass.edges.find(
    (edge) => edge.id === "merge-repair",
  ).when.outcomeIn.push("pass");
  expectRuntimeRouteFailure(ambiguousMergePass);

  const unexpectedForkTarget = deepClone(
    blueprints.find((item) => item.id === "parallel-review"),
  );
  unexpectedForkTarget.edges.push({
    id: "fork-unexpected-worker",
    from: "review-fork",
    to: "worker",
    when: { outcomeIn: ["fork"] },
    maxTraversals: 1,
  });
  expectRuntimeRouteFailure(unexpectedForkTarget);

  const forged = deepClone(blueprints.find((item) => item.id === "direct"));
  forged.features.reviewers = ["security"];
  assert.throws(
    () => validateBlueprint(forged, POLICY),
    (error) => error.code === "FEATURE_TOPOLOGY_MISMATCH",
  );
});

test("parallel systemic failures outrank observed budget overflow", async () => {
  const constrained = deepClone(
    blueprints.find((item) => item.id === "parallel-review"),
  );
  constrained.budgets.maxTokenUnits = 2_000;
  const delegate = fixtureAdapter();
  const adapter = {
    kind: "openai",
    deterministic: false,
    async invoke(context) {
      if (context.role === "reviewer:correctness") {
        throw Object.assign(new Error("Injected systemic auth failure."), {
          code: "OPENAI_AUTH_ERROR",
          systemic: true,
          retryable: false,
        });
      }
      return delegate.invoke(context);
    },
  };
  const result = await executeCandidate({
    runId: "parallel-systemic-priority-test",
    blueprint: constrained,
    scenario: scenarios.find((item) => item.id === "simple-transform"),
    adapter,
    policy: POLICY,
  });
  assert.equal(result.status, "api_error");
  assert.equal(result.reliability.terminalError.code, "OPENAI_AUTH_ERROR");
  assert.equal(result.reliability.terminalError.systemic, true);
  assert.equal(
    result.trace.filter((event) => event.role?.startsWith("reviewer:")).length,
    3,
  );
});

test("authority broker exposes only the built-in data-only effect simulator", () => {
  const scenario = scenarios.find((item) => item.id === "consequential-deploy");
  const blueprint = blueprints.find((item) => item.id === "graph-max-governed");
  let arbitraryCallbackCalls = 0;
  const broker = createAuthorityBroker({
    policy: POLICY,
    scenario,
    blueprint,
    runId: "data-only-simulator-test",
    approvalProvider: createFixtureApprovalProvider({ granted: true }),
    effectSimulator() {
      arbitraryCallbackCalls += 1;
      return { externalEffect: true };
    },
  });
  const result = broker.authorizeConsequentialEffect({
    artifact: { title: "accepted" },
  });
  assert.equal(arbitraryCallbackCalls, 0);
  assert.equal(result.allowed, true);
  assert.equal(result.event.simulationOnly, true);
  assert.equal(result.event.externalEffect, false);
});

test("subset reports identify the smallest evaluated candidate without overclaiming", async () => {
  const selectedScenario = scenarios.find((item) => item.id === "simple-transform");
  const selectedBlueprint = blueprints.find((item) => item.id === "loop");
  const results = await runWindTunnel({
    blueprints: [selectedBlueprint],
    scenarios: [selectedScenario],
    adapter: fixtureAdapter(),
    policy: POLICY,
  });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "awt-subset-report-"));
  try {
    writeArtifactPackage({
      results,
      outputDir: tempRoot,
      projectRoot: tempRoot,
    });
    const report = fs.readFileSync(path.join(tempRoot, "report.md"), "utf8");
    assert.match(report, /Smallest evaluated canonical topology/);
    assert.match(report, /no lower-complexity candidate was included/i);
    assert.match(report, /Graph Max was not among the candidates evaluated/);
    assert.doesNotMatch(report, /based on a \*\*—\*\* scan/);
    assert.doesNotMatch(report, /The direct topology satisfied/);
  } finally {
    for (const name of fs.readdirSync(tempRoot)) {
      fs.unlinkSync(path.join(tempRoot, name));
    }
    fs.rmdirSync(tempRoot);
  }
});
