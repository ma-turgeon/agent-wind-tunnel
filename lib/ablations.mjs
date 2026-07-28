import { runWindTunnel } from "./runner.mjs";
import { deepClone } from "./util.mjs";

function removeNodes(blueprint, nodeIds) {
  const removed = new Set(nodeIds);
  blueprint.nodes = blueprint.nodes.filter((node) => !removed.has(node.id));
  blueprint.edges = blueprint.edges.filter(
    (edge) => !removed.has(edge.from) && !removed.has(edge.to),
  );
  return blueprint;
}

function removeEdges(blueprint, edgeIds) {
  const removed = new Set(edgeIds);
  blueprint.edges = blueprint.edges.filter((edge) => !removed.has(edge.id));
  return blueprint;
}

function addEdge(blueprint, id, from, to, outcomes, maxTraversals = 1) {
  blueprint.edges.push({
    id,
    from,
    to,
    when: { outcomeIn: outcomes },
    maxTraversals,
  });
  return blueprint;
}

function rename(blueprint, id, label, transforms) {
  blueprint.id = id;
  blueprint.label = label;
  blueprint.source = {
    ...blueprint.source,
    ablationOf: "graph-max-governed",
    transforms,
  };
  return blueprint;
}

function dropPresenter(input) {
  const blueprint = deepClone(input);
  removeNodes(blueprint, ["presenter"]);
  addEdge(blueprint, "effect-accept", "production-effect", "accept", ["completed"]);
  addEdge(
    blueprint,
    "synthesis-nonconsequential-accept",
    "synthesizer",
    "accept",
    ["pass-no-effect"],
  );
  blueprint.features.presenter = false;
  return blueprint;
}

function deterministicMerge(input) {
  const blueprint = deepClone(input);
  removeNodes(blueprint, ["synthesizer"]);
  addEdge(blueprint, "review-join-approval", "review-join", "approval", ["pass"]);
  addEdge(
    blueprint,
    "review-join-nonconsequential",
    "review-join",
    blueprint.nodes.some((node) => node.id === "presenter")
      ? "presenter"
      : "accept",
    ["pass-no-effect"],
  );
  addEdge(blueprint, "review-join-repair", "review-join", "worker", ["revise"], 1);
  addEdge(blueprint, "review-join-reject", "review-join", "reject", ["budget-exhausted"]);
  blueprint.features.modelSynthesis = false;
  return blueprint;
}

function disableSpeculation(input) {
  const blueprint = deepClone(input);
  removeNodes(blueprint, ["plan-fork", "plan-join"]);
  removeEdges(blueprint, [
    "planner-plan-fork",
    "plan-fork-review",
    "plan-fork-worker",
    "plan-review-revise",
    "plan-review-join",
    "worker-plan-join",
    "plan-join-verifier",
  ]);
  addEdge(blueprint, "planner-plan-review", "planner", "plan-reviewer", ["completed"], 2);
  addEdge(blueprint, "plan-review-revise", "plan-reviewer", "planner", ["revise"], 1);
  addEdge(blueprint, "plan-review-worker", "plan-reviewer", "worker", ["approve"], 2);
  addEdge(blueprint, "worker-verifier", "worker", "verifier", ["completed"], 3);
  blueprint.features.speculativeWorker = false;
  return blueprint;
}

function dropPlanReview(input) {
  const blueprint = disableSpeculation(input);
  removeNodes(blueprint, ["plan-reviewer"]);
  removeEdges(blueprint, [
    "planner-plan-review",
    "plan-review-revise",
    "plan-review-worker",
  ]);
  addEdge(blueprint, "planner-worker", "planner", "worker", ["completed"], 2);
  blueprint.features.planReview = false;
  return blueprint;
}

function dropSecurityReviewer(input) {
  const blueprint = deepClone(input);
  removeNodes(blueprint, ["reviewer-security"]);
  blueprint.features.reviewers = blueprint.features.reviewers.filter(
    (reviewer) => reviewer !== "security",
  );
  return blueprint;
}

export function buildAblationBlueprints(blueprints) {
  const graph = blueprints.find((blueprint) => blueprint.id === "graph-max-governed");
  if (!graph) throw new Error("The Graph Max blueprint is required for ablation.");
  const noPresenter = rename(
    dropPresenter(graph),
    "graph-ablate-presenter",
    "Graph Max − presenter",
    ["drop-presenter"],
  );
  const noSynthesis = rename(
    deterministicMerge(graph),
    "graph-ablate-synthesizer",
    "Graph Max + deterministic merge",
    ["replace-model-synthesizer-with-deterministic-merge"],
  );
  const noSpeculation = rename(
    disableSpeculation(graph),
    "graph-ablate-speculation",
    "Graph Max − speculative worker",
    ["disable-speculative-worker"],
  );
  const noPlanReview = rename(
    dropPlanReview(graph),
    "graph-ablate-plan-review",
    "Graph Max − plan review",
    ["disable-speculative-worker", "drop-plan-review"],
  );
  const noSecurity = rename(
    dropSecurityReviewer(graph),
    "graph-ablate-security-review",
    "Graph Max − security reviewer",
    ["drop-reviewer:security"],
  );
  const lean = rename(
    disableSpeculation(deterministicMerge(dropPresenter(graph))),
    "graph-lean",
    "Lean governed Graph Max",
    [
      "drop-presenter",
      "replace-model-synthesizer-with-deterministic-merge",
      "disable-speculative-worker",
    ],
  );
  return [deepClone(graph), noPresenter, noSynthesis, noSpeculation, noPlanReview, noSecurity, lean];
}

export async function runAblationStudy({
  blueprints,
  scenarios,
  adapter,
  policy,
  approvalProviderFactory,
}) {
  const variants = buildAblationBlueprints(blueprints);
  const results = await runWindTunnel({
    blueprints: variants,
    scenarios,
    adapter,
    policy,
    repetitions: 1,
    mode: "fixture-ablation",
    includeExpectedFixtureChecks: false,
    approvalProviderFactory,
  });
  const baseline = new Map(
    results.aggregates
      .filter((item) => item.blueprintId === "graph-max-governed")
      .map((item) => [item.scenarioId, item]),
  );
  const deltas = results.aggregates.map((item) => {
    const base = baseline.get(item.scenarioId);
    return {
      scenarioId: item.scenarioId,
      blueprintId: item.blueprintId,
      feasible: item.feasible,
      status: item.status,
      statusCounts: item.statusCounts,
      qualityBps: item.qualityBpsMean,
      modelCalls: item.modelCallsMean,
      tokenUnits: item.tokenUnitsMean,
      complexityScore: item.complexity.score,
      delta: {
        qualityBps: item.qualityBpsMean - base.qualityBpsMean,
        modelCalls: item.modelCallsMean - base.modelCallsMean,
        tokenUnits: item.tokenUnitsMean - base.tokenUnitsMean,
        complexityScore: item.complexity.score - base.complexity.score,
      },
    };
  });
  const portfolio = variants.map((variant) => ({
    blueprintId: variant.id,
    feasibleAcrossCorpus: results.aggregates
      .filter((item) => item.blueprintId === variant.id)
      .every((item) => item.feasible),
    failedScenarios: results.aggregates
      .filter((item) => item.blueprintId === variant.id && !item.feasible)
      .map((item) => item.scenarioId),
  }));
  return {
    schemaVersion: "agent-wind-tunnel.ablation/v1",
    variants: results.blueprints,
    deltas,
    portfolio,
    recommendation: results.portfolioRecommendation,
    runs: results.runs,
  };
}
