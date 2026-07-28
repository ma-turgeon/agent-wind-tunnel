import { invariant } from "./util.mjs";

const NODE_KINDS = new Set([
  "model",
  "deterministic",
  "fork",
  "join",
  "approval",
  "effect",
  "terminal",
]);

const FEATURE_KEYS = new Set([
  "planning",
  "planReview",
  "speculativeWorker",
  "reviewers",
  "modelSynthesis",
  "presenter",
  "approvalGate",
  "effectNode",
  "maxRepairRounds",
]);

const STATE_CONTRACT = "agent-wind-tunnel.state/v1";
const BUDGET_KEYS = [
  "maxNodeVisits",
  "maxModelCalls",
  "maxTokenUnits",
  "maxLatencyTicks",
  "maxRetries",
];
const NODE_KEYS = [
  "id",
  "kind",
  "role",
  "thread",
  "inputContract",
  "outputContract",
  "capabilities",
  "maxVisits",
  "tags",
  "origin",
];
const BLUEPRINT_KEYS = [
  "schemaVersion",
  "id",
  "label",
  "source",
  "entryNode",
  "terminalNodes",
  "stateContract",
  "budgets",
  "nodes",
  "edges",
  "features",
];
const EFFECT_APPROVAL = new Map([
  ["observe", "none"],
  ["reversible-local", "none"],
  ["consequential", "explicit-human"],
]);
const THREADS_BY_KIND = new Map([
  ["model", new Set(["ephemeral", "persistent"])],
  ["deterministic", new Set(["none"])],
  ["fork", new Set(["none"])],
  ["join", new Set(["none"])],
  ["approval", new Set(["broker-owned"])],
  ["effect", new Set(["broker-owned"])],
  ["terminal", new Set(["none"])],
]);

function reachableFrom(blueprint, startNode, omitted = new Set()) {
  if (!startNode || omitted.has(startNode)) return new Set();
  const reached = new Set([startNode]);
  const queue = [startNode];
  while (queue.length) {
    const current = queue.shift();
    for (const edge of blueprint.edges.filter((candidate) => candidate.from === current)) {
      if (omitted.has(edge.to) || reached.has(edge.to)) continue;
      reached.add(edge.to);
      queue.push(edge.to);
    }
  }
  return reached;
}

function reachableNodes(blueprint, omitted = new Set()) {
  return reachableFrom(blueprint, blueprint.entryNode, omitted);
}

function edgeExists(blueprint, from, to) {
  return blueprint.edges.some((edge) => edge.from === from && edge.to === to);
}

function transitionKey(nodeId, outcome) {
  return `${nodeId}\u0000${outcome}`;
}

function transitionMap(blueprint) {
  const routes = new Map();
  const expanded = new Set();
  for (const edge of blueprint.edges) {
    for (const outcome of edge.when.outcomeIn) {
      const expandedKey = `${transitionKey(edge.from, outcome)}\u0000${edge.to}`;
      invariant(
        !expanded.has(expandedKey),
        "DUPLICATE_RUNTIME_TRANSITION",
        `${blueprint.id} declares ${edge.from}/${outcome} → ${edge.to} more than once.`,
      );
      expanded.add(expandedKey);
      const key = transitionKey(edge.from, outcome);
      if (!routes.has(key)) routes.set(key, new Set());
      routes.get(key).add(edge.to);
    }
  }
  return routes;
}

function sameSet(left, right) {
  return (
    left.size === right.size &&
    [...left].every((item) => right.has(item))
  );
}

function allowedOutcomes(node) {
  if (node.kind === "model") {
    if (node.role === "planner" || node.role === "worker" || node.role === "presenter") {
      return new Set(["completed"]);
    }
    if (node.role === "plan-reviewer") {
      return new Set(["approve", "revise", "abort"]);
    }
    if (node.role.startsWith("reviewer:")) {
      return new Set(["pass", "revise", "fatal"]);
    }
    if (node.role === "synthesizer") {
      return new Set([
        "pass",
        "pass-no-effect",
        "revise",
        "fatal",
        "budget-exhausted",
      ]);
    }
  }
  if (node.kind === "fork") return new Set(["fork"]);
  if (node.kind === "join") {
    return new Set([
      "joined",
      "pass",
      "pass-no-effect",
      "revise",
      "budget-exhausted",
      "authority-required",
    ]);
  }
  if (node.kind === "approval") {
    return new Set(["approved", "declined", "missing"]);
  }
  if (node.kind === "effect") return new Set(["completed"]);
  if (node.kind === "terminal") return new Set();
  if (node.kind === "deterministic") {
    if (node.tags?.includes("quality-gate")) {
      return new Set(["pass", "fail", "authority-required"]);
    }
    if (node.tags?.includes("deterministic-merge")) {
      return new Set([
        "pass",
        "pass-no-effect",
        "revise",
        "budget-exhausted",
        "authority-required",
      ]);
    }
  }
  return null;
}

function pathExists(blueprint, from, to, omitted = new Set()) {
  return reachableFrom(blueprint, from, omitted).has(to);
}

function singleRoleNode(blueprint, role, { required = false } = {}) {
  const matches = blueprint.nodes.filter(
    (node) => node.kind === "model" && node.role === role,
  );
  invariant(
    matches.length <= 1,
    "DUPLICATE_EXECUTION_ROLE",
    `${blueprint.id} compiles model role ${role} more than once.`,
  );
  if (required) {
    invariant(
      matches.length === 1,
      "FEATURE_TOPOLOGY_MISMATCH",
      `${blueprint.id} declares ${role} behavior without exactly one reachable ${role} model node.`,
    );
  }
  return matches[0] ?? null;
}

function repairRoundCapacity(blueprint, worker) {
  if (!worker) return 0;
  const downstream = reachableFrom(blueprint, worker.id);
  const repairEdges = blueprint.edges.filter(
    (edge) => edge.to === worker.id && downstream.has(edge.from),
  );
  return repairEdges.reduce(
    (maximum, edge) => Math.max(maximum, edge.maxTraversals),
    0,
  );
}

/*
 * The runner is deliberately a constrained compiler, not a general graph
 * interpreter. Bind every accepted IR predicate to the exact transition set
 * implemented by that compiler so changing graph semantics cannot silently
 * leave runtime behavior unchanged.
 */
function validateRuntimeTransitionBindings(blueprint, {
  planner,
  planReviewer,
  worker,
  verifier,
  reviewerNodes,
  synthesizer,
  presenter,
  approvalNodes,
  effectNodes,
  compiledSpeculation,
}) {
  const nodes = new Map(blueprint.nodes.map((node) => [node.id, node]));
  const expected = new Map();
  const requireNode = (id, kind) => {
    const node = nodes.get(id);
    invariant(
      node?.kind === kind,
      "EXECUTION_BINDING_MISMATCH",
      `${blueprint.id} runtime transition compiler requires ${kind} node ${id}.`,
    );
    return node;
  };
  const add = (from, outcome, targets) => {
    const key = transitionKey(from, outcome);
    invariant(
      !expected.has(key),
      "AMBIGUOUS_RUNTIME_BINDING",
      `${blueprint.id} compiler bound ${from}/${outcome} more than once.`,
    );
    expected.set(key, new Set(targets));
  };

  for (const terminalId of ["accept", "reject", "escalate"]) {
    const terminal = requireNode(terminalId, "terminal");
    invariant(
      (terminal.role ?? terminal.id) === terminalId,
      "EXECUTION_BINDING_MISMATCH",
      `${blueprint.id} terminal ${terminalId} has an incompatible runtime role.`,
    );
  }
  invariant(
    verifier.id === "verifier",
    "EXECUTION_BINDING_MISMATCH",
    `${blueprint.id} quality-gate runtime node must be named verifier.`,
  );

  if (planner) {
    if (planReviewer) {
      add(planReviewer.id, "revise", [planner.id]);
      add(planReviewer.id, "abort", ["reject"]);
      if (compiledSpeculation) {
        const planFork = requireNode("plan-fork", "fork");
        const planJoin = requireNode("plan-join", "join");
        add(planner.id, "completed", [planFork.id]);
        add(planFork.id, "fork", [planReviewer.id, worker.id]);
        add(planReviewer.id, "approve", [planJoin.id]);
        add(worker.id, "completed", [planJoin.id]);
        add(planJoin.id, "joined", [verifier.id]);
      } else {
        add(planner.id, "completed", [planReviewer.id]);
        add(planReviewer.id, "approve", [worker.id]);
        add(worker.id, "completed", [verifier.id]);
      }
    } else {
      add(planner.id, "completed", [worker.id]);
      add(worker.id, "completed", [verifier.id]);
    }
  } else {
    add(worker.id, "completed", [verifier.id]);
  }

  const approval = approvalNodes[0] ?? null;
  const effect = effectNodes[0] ?? null;
  const mergeNodes = blueprint.nodes.filter(
    (node) =>
      node.kind === "deterministic" &&
      node.tags?.includes("deterministic-merge"),
  );
  invariant(
    mergeNodes.length <= 1,
    "EXECUTION_BINDING_MISMATCH",
    `${blueprint.id} compiles more than one deterministic feedback merge.`,
  );
  const merge = mergeNodes[0] ?? null;
  if (merge) {
    invariant(
      merge.id === "merge-feedback",
      "EXECUTION_BINDING_MISMATCH",
      `${blueprint.id} deterministic feedback merge must be named merge-feedback.`,
    );
  }

  const addMergeRoutes = (node) => {
    add(node.id, "revise", [worker.id]);
    add(node.id, "pass", [approval?.id ?? "accept"]);
    if (approval) {
      add(node.id, "pass-no-effect", [presenter?.id ?? "accept"]);
    }
    add(node.id, "budget-exhausted", ["reject"]);
    if (!approval) add(node.id, "authority-required", ["escalate"]);
  };

  if (reviewerNodes.length === 0) {
    add(verifier.id, "pass", [approval?.id ?? "accept"]);
    add(verifier.id, "fail", ["reject"]);
    add(verifier.id, "authority-required", ["escalate"]);
  } else {
    let reviewJoin = null;
    if (reviewerNodes.length === 1) {
      invariant(
        merge,
        "EXECUTION_BINDING_MISMATCH",
        `${blueprint.id} sole evaluator requires merge-feedback.`,
      );
      add(verifier.id, "pass", [reviewerNodes[0].id]);
      add(verifier.id, "fail", [reviewerNodes[0].id]);
      add(reviewerNodes[0].id, "pass", [merge.id]);
      add(reviewerNodes[0].id, "revise", [merge.id]);
      add(reviewerNodes[0].id, "fatal", ["reject"]);
      addMergeRoutes(merge);
    } else {
      const reviewFork = requireNode("review-fork", "fork");
      reviewJoin = requireNode("review-join", "join");
      add(verifier.id, "pass", [reviewFork.id]);
      add(verifier.id, "fail", [reviewFork.id]);
      add(
        reviewFork.id,
        "fork",
        reviewerNodes.map((reviewer) => reviewer.id),
      );
      for (const reviewer of reviewerNodes) {
        add(reviewer.id, "pass", [reviewJoin.id]);
        add(reviewer.id, "revise", [reviewJoin.id]);
        add(reviewer.id, "fatal", ["reject"]);
      }
      if (synthesizer) {
        add(reviewJoin.id, "joined", [synthesizer.id]);
      } else if (merge) {
        add(reviewJoin.id, "joined", [merge.id]);
        addMergeRoutes(merge);
      } else {
        addMergeRoutes(reviewJoin);
      }
    }
  }

  if (synthesizer) {
    add(synthesizer.id, "revise", [worker.id]);
    add(synthesizer.id, "pass", [approval?.id ?? "accept"]);
    if (approval) {
      add(synthesizer.id, "pass-no-effect", [presenter?.id ?? "accept"]);
    }
    add(synthesizer.id, "fatal", ["reject"]);
    add(synthesizer.id, "budget-exhausted", ["reject"]);
  }

  if (approval || effect) {
    invariant(
      approval && effect,
      "EXECUTION_BINDING_MISMATCH",
      `${blueprint.id} runtime authority path requires both approval and effect nodes.`,
    );
    invariant(
      approval.id === "approval" && effect.id === "production-effect",
      "EXECUTION_BINDING_MISMATCH",
      `${blueprint.id} authority runtime nodes must be named approval and production-effect.`,
    );
    add(approval.id, "approved", [effect.id]);
    add(approval.id, "declined", ["escalate"]);
    add(approval.id, "missing", ["escalate"]);
    add(effect.id, "completed", [presenter?.id ?? "accept"]);
  }
  if (presenter) add(presenter.id, "completed", ["accept"]);

  const actual = transitionMap(blueprint);
  const routeKeys = new Set([...expected.keys(), ...actual.keys()]);
  for (const key of routeKeys) {
    const [nodeId, outcome] = key.split("\u0000");
    const expectedTargets = expected.get(key) ?? new Set();
    const actualTargets = actual.get(key) ?? new Set();
    invariant(
      sameSet(expectedTargets, actualTargets),
      "RUNTIME_ROUTE_MISMATCH",
      `${blueprint.id} routes ${nodeId}/${outcome} to [${[...actualTargets].sort().join(", ")}], but its runtime compiler requires [${[...expectedTargets].sort().join(", ")}].`,
    );
  }
}

function validateFeatureTopology(blueprint, reached) {
  const features = blueprint.features;
  invariant(
    features && typeof features === "object" && !Array.isArray(features),
    "FEATURES_MISSING",
    `${blueprint.id} needs a compiled feature manifest.`,
  );
  for (const key of Object.keys(features)) {
    invariant(
      FEATURE_KEYS.has(key),
      "UNKNOWN_FEATURE",
      `${blueprint.id} declares unsupported feature ${key}.`,
    );
  }
  for (const key of [
    "planning",
    "planReview",
    "speculativeWorker",
    "modelSynthesis",
    "presenter",
    "approvalGate",
    "effectNode",
  ]) {
    invariant(
      typeof features[key] === "boolean",
      "INVALID_FEATURE_VALUE",
      `${blueprint.id} feature ${key} must be boolean.`,
    );
  }
  invariant(
    Array.isArray(features.reviewers) &&
      features.reviewers.every((reviewer) => typeof reviewer === "string" && reviewer.length > 0) &&
      new Set(features.reviewers).size === features.reviewers.length,
    "INVALID_FEATURE_VALUE",
    `${blueprint.id} feature reviewers must contain unique non-empty rubric IDs.`,
  );
  invariant(
    Number.isInteger(features.maxRepairRounds) && features.maxRepairRounds >= 0,
    "INVALID_FEATURE_VALUE",
    `${blueprint.id} feature maxRepairRounds must be a non-negative integer.`,
  );

  for (const node of blueprint.nodes) {
    invariant(
      reached.has(node.id),
      "UNREACHABLE_EXECUTION_NODE",
      `${blueprint.id}/${node.id} is not reachable from the entry node.`,
    );
    const canTerminate = blueprint.terminalNodes.some((terminal) =>
      pathExists(blueprint, node.id, terminal),
    );
    invariant(
      canTerminate,
      "NONTERMINATING_EXECUTION_NODE",
      `${blueprint.id}/${node.id} cannot reach a declared terminal.`,
    );
  }

  const planner = singleRoleNode(blueprint, "planner");
  const planReviewer = singleRoleNode(blueprint, "plan-reviewer");
  const worker = singleRoleNode(blueprint, "worker", { required: true });
  const synthesizer = singleRoleNode(blueprint, "synthesizer");
  const presenter = singleRoleNode(blueprint, "presenter");
  const approvalNodes = blueprint.nodes.filter((node) => node.kind === "approval");
  const effectNodes = blueprint.nodes.filter((node) => node.kind === "effect");
  const reviewerNodes = blueprint.nodes.filter(
    (node) => node.kind === "model" && node.role.startsWith("reviewer:"),
  );
  const compiledReviewers = reviewerNodes
    .map((node) => node.role.slice("reviewer:".length))
    .sort();
  const declaredReviewers = [...features.reviewers].sort();
  const compiledModelRoles = new Set([
    "worker",
    ...(planner ? ["planner"] : []),
    ...(planReviewer ? ["plan-reviewer"] : []),
    ...(synthesizer ? ["synthesizer"] : []),
    ...(presenter ? ["presenter"] : []),
    ...compiledReviewers.map((reviewer) => `reviewer:${reviewer}`),
  ]);
  invariant(
    blueprint.nodes
      .filter((node) => node.kind === "model")
      .every((node) => compiledModelRoles.has(node.role)),
    "UNCOMPILED_MODEL_ROLE",
    `${blueprint.id} contains a model role that is not represented in its compiled execution plan.`,
  );
  for (const [role, node] of [
    ["planner", planner],
    ["plan-reviewer", planReviewer],
    ["worker", worker],
    ["synthesizer", synthesizer],
    ["presenter", presenter],
  ]) {
    invariant(
      !node || node.id === role,
      "EXECUTION_BINDING_MISMATCH",
      `${blueprint.id} runtime role ${role} must compile to node ID ${role}.`,
    );
  }
  for (const reviewer of reviewerNodes) {
    const rubric = reviewer.role.slice("reviewer:".length);
    invariant(
      reviewer.id === `reviewer-${rubric}`,
      "EXECUTION_BINDING_MISMATCH",
      `${blueprint.id} runtime reviewer ${rubric} must compile to node ID reviewer-${rubric}.`,
    );
  }

  const featureMatches = [
    ["planning", Boolean(planner)],
    ["planReview", Boolean(planReviewer)],
    ["modelSynthesis", Boolean(synthesizer)],
    ["presenter", Boolean(presenter)],
    ["approvalGate", approvalNodes.length > 0],
    ["effectNode", effectNodes.length > 0],
  ];
  for (const [name, compiled] of featureMatches) {
    invariant(
      features[name] === compiled,
      "FEATURE_TOPOLOGY_MISMATCH",
      `${blueprint.id} feature ${name}=${features[name]} disagrees with compiled topology (${compiled}).`,
    );
  }
  invariant(
    declaredReviewers.length === compiledReviewers.length &&
      declaredReviewers.every((reviewer, index) => reviewer === compiledReviewers[index]),
    "FEATURE_TOPOLOGY_MISMATCH",
    `${blueprint.id} reviewer features disagree with reachable reviewer model nodes.`,
  );
  invariant(
    approvalNodes.length <= 1 && effectNodes.length <= 1,
    "AUTHORITY_TOPOLOGY_AMBIGUOUS",
    `${blueprint.id} must compile at most one approval node and one brokered effect node.`,
  );

  const verifier = blueprint.nodes.find(
    (node) => node.kind === "deterministic" && node.tags?.includes("quality-gate"),
  );
  invariant(
    verifier && pathExists(blueprint, worker.id, verifier.id),
    "VERIFIER_TOPOLOGY_MISMATCH",
    `${blueprint.id} must route worker output through a deterministic quality gate.`,
  );

  if (features.planning) {
    invariant(
      blueprint.entryNode === planner.id,
      "PLANNING_TOPOLOGY_MISMATCH",
      `${blueprint.id} must enter at its planner when planning is enabled.`,
    );
  } else {
    invariant(
      blueprint.entryNode === worker.id,
      "PLANNING_TOPOLOGY_MISMATCH",
      `${blueprint.id} must enter at its worker when planning is disabled.`,
    );
  }
  invariant(
    !features.planReview || features.planning,
    "PLANNING_TOPOLOGY_MISMATCH",
    `${blueprint.id} cannot compile plan review without planning.`,
  );
  invariant(
    !features.speculativeWorker || (features.planning && features.planReview),
    "PLANNING_TOPOLOGY_MISMATCH",
    `${blueprint.id} cannot compile speculative work without planning and plan review.`,
  );

  let compiledSpeculation = false;
  if (planner && planReviewer) {
    compiledSpeculation = blueprint.nodes
      .filter((node) => node.kind === "fork")
      .some((fork) => {
        const forksToBoth =
          edgeExists(blueprint, planner.id, fork.id) &&
          edgeExists(blueprint, fork.id, planReviewer.id) &&
          edgeExists(blueprint, fork.id, worker.id);
        if (!forksToBoth) return false;
        return blueprint.nodes
          .filter((node) => node.kind === "join")
          .some(
            (join) =>
              edgeExists(blueprint, planReviewer.id, join.id) &&
              edgeExists(blueprint, worker.id, join.id),
          );
      });
  }
  invariant(
    features.speculativeWorker === compiledSpeculation,
    "FEATURE_TOPOLOGY_MISMATCH",
    `${blueprint.id} speculativeWorker=${features.speculativeWorker} disagrees with its fork/join topology.`,
  );
  if (planReviewer && !compiledSpeculation) {
    invariant(
      edgeExists(blueprint, planner.id, planReviewer.id) &&
        edgeExists(blueprint, planReviewer.id, worker.id),
      "PLANNING_TOPOLOGY_MISMATCH",
      `${blueprint.id} non-speculative plan review must route planner → plan reviewer → worker.`,
    );
  } else if (planner && !planReviewer) {
    invariant(
      edgeExists(blueprint, planner.id, worker.id),
      "PLANNING_TOPOLOGY_MISMATCH",
      `${blueprint.id} planning without plan review must route planner → worker.`,
    );
  }
  if (planReviewer && !compiledSpeculation) {
    invariant(
      !reachableNodes(blueprint, new Set([planReviewer.id])).has(verifier.id),
      "PLANNING_TOPOLOGY_MISMATCH",
      `${blueprint.id} must not reach artifact verification without its compiled plan review.`,
    );
  }

  if (reviewerNodes.length === 1) {
    invariant(
      edgeExists(blueprint, verifier.id, reviewerNodes[0].id),
      "REVIEW_TOPOLOGY_MISMATCH",
      `${blueprint.id} must route its verifier directly to its sole reviewer.`,
    );
  } else if (reviewerNodes.length > 1) {
    const reviewForks = blueprint.nodes.filter(
      (node) =>
        node.kind === "fork" &&
        pathExists(blueprint, verifier.id, node.id) &&
        reviewerNodes.every((reviewer) => edgeExists(blueprint, node.id, reviewer.id)),
    );
    const reviewJoins = blueprint.nodes.filter(
      (node) =>
        node.kind === "join" &&
        reviewerNodes.every((reviewer) => edgeExists(blueprint, reviewer.id, node.id)),
    );
    invariant(
      reviewForks.length === 1 && reviewJoins.length === 1,
      "REVIEW_TOPOLOGY_MISMATCH",
      `${blueprint.id} parallel reviewers require one explicit fan-out and one explicit fan-in.`,
    );
  }

  const compiledRepairRounds = repairRoundCapacity(blueprint, worker);
  invariant(
    features.maxRepairRounds === compiledRepairRounds,
    "FEATURE_TOPOLOGY_MISMATCH",
    `${blueprint.id} maxRepairRounds=${features.maxRepairRounds} disagrees with compiled repair capacity (${compiledRepairRounds}).`,
  );
  invariant(
    features.maxRepairRounds === 0 || reviewerNodes.length > 0,
    "REPAIR_TOPOLOGY_MISMATCH",
    `${blueprint.id} cannot compile repair rounds without an evaluator.`,
  );
  if (reviewerNodes.length > 0) {
    const reviewerIds = new Set(reviewerNodes.map((reviewer) => reviewer.id));
    const acceptTerminal = blueprint.terminalNodes.find(
      (terminal) =>
        terminal === "accept" ||
        blueprint.nodes.find((node) => node.id === terminal)?.role === "accept",
    );
    invariant(
      !acceptTerminal ||
        !reachableFrom(blueprint, verifier.id, reviewerIds).has(acceptTerminal),
      "REVIEW_TOPOLOGY_MISMATCH",
      `${blueprint.id} acceptance must not bypass its compiled reviewers.`,
    );
    invariant(
      features.maxRepairRounds === 0 ||
        reviewerNodes.every((reviewer) =>
          pathExists(blueprint, reviewer.id, worker.id),
        ),
      "REVIEW_TOPOLOGY_MISMATCH",
      `${blueprint.id} every evaluator must feed the compiled repair path.`,
    );
  }

  if (synthesizer) {
    invariant(
      reviewerNodes.length > 0 &&
        reviewerNodes.every((reviewer) => pathExists(blueprint, reviewer.id, synthesizer.id)) &&
        pathExists(blueprint, synthesizer.id, worker.id),
      "SYNTHESIS_TOPOLOGY_MISMATCH",
      `${blueprint.id} synthesis must follow every reviewer and retain a bounded repair path.`,
    );
  }
  if (presenter) {
    invariant(
      effectNodes.length === 0 ||
        effectNodes.every((effect) => pathExists(blueprint, effect.id, presenter.id)),
      "PRESENTER_TOPOLOGY_MISMATCH",
      `${blueprint.id} presenter must follow its brokered effect.`,
    );
  }

  if (approvalNodes.length || effectNodes.length) {
    invariant(
      approvalNodes.length === 1 && effectNodes.length === 1,
      "AUTHORITY_TOPOLOGY_MISMATCH",
      `${blueprint.id} must compile approval and effect nodes as a pair.`,
    );
    invariant(
      edgeExists(blueprint, approvalNodes[0].id, effectNodes[0].id),
      "AUTHORITY_TOPOLOGY_MISMATCH",
      `${blueprint.id} approval must route directly to its effect node.`,
    );
    invariant(
      blueprint.terminalNodes.some((terminal) =>
        pathExists(blueprint, approvalNodes[0].id, terminal, new Set([effectNodes[0].id])),
      ),
      "AUTHORITY_TOPOLOGY_MISMATCH",
      `${blueprint.id} approval must retain a non-effect escalation/decline path.`,
    );
  }

  validateRuntimeTransitionBindings(blueprint, {
    planner,
    planReviewer,
    worker,
    verifier,
    reviewerNodes,
    synthesizer,
    presenter,
    approvalNodes,
    effectNodes,
    compiledSpeculation,
  });
}

function stronglyConnectedComponents(blueprint) {
  const adjacency = new Map(blueprint.nodes.map((node) => [node.id, []]));
  for (const edge of blueprint.edges) adjacency.get(edge.from)?.push(edge.to);
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const indexes = new Map();
  const lowLinks = new Map();
  const components = [];

  function visit(nodeId) {
    indexes.set(nodeId, index);
    lowLinks.set(nodeId, index);
    index += 1;
    stack.push(nodeId);
    onStack.add(nodeId);

    for (const next of adjacency.get(nodeId) ?? []) {
      if (!indexes.has(next)) {
        visit(next);
        lowLinks.set(nodeId, Math.min(lowLinks.get(nodeId), lowLinks.get(next)));
      } else if (onStack.has(next)) {
        lowLinks.set(nodeId, Math.min(lowLinks.get(nodeId), indexes.get(next)));
      }
    }

    if (lowLinks.get(nodeId) === indexes.get(nodeId)) {
      const component = [];
      let popped;
      do {
        popped = stack.pop();
        onStack.delete(popped);
        component.push(popped);
      } while (popped !== nodeId);
      components.push(component);
    }
  }

  for (const node of blueprint.nodes) if (!indexes.has(node.id)) visit(node.id);
  return components;
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

function exactKeys(value, requiredKeys, context) {
  invariant(
    plainObject(value),
    "INVALID_SCENARIO_SHAPE",
    `${context} must be a plain object.`,
  );
  const actual = Object.keys(value).sort();
  const expected = [...requiredKeys].sort();
  invariant(
    actual.length === expected.length &&
      actual.every((key, index) => key === expected[index]),
    "INVALID_SCENARIO_SHAPE",
    `${context} must contain exactly: ${expected.join(", ")}.`,
  );
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function exactShape(value, requiredKeys, code, context) {
  invariant(
    plainObject(value),
    code,
    `${context} must be a plain object.`,
  );
  const actual = Object.keys(value).sort();
  const expected = [...requiredKeys].sort();
  invariant(
    actual.length === expected.length &&
      actual.every((key, index) => key === expected[index]),
    code,
    `${context} must contain exactly: ${expected.join(", ")}.`,
  );
}

export function validatePolicy(policy) {
  exactShape(
    policy,
    ["schemaVersion", "capabilityCatalog", "initialGrants"],
    "INVALID_POLICY_SHAPE",
    "policy",
  );
  invariant(
    policy.schemaVersion === "agent-wind-tunnel.policy/v1",
    "INVALID_POLICY_SCHEMA",
    "Policy has an unsupported schema version.",
  );
  invariant(
    Array.isArray(policy.capabilityCatalog),
    "INVALID_POLICY_SHAPE",
    "Policy capabilityCatalog must be an array.",
  );
  invariant(
    Array.isArray(policy.initialGrants),
    "INVALID_POLICY_SHAPE",
    "Policy initialGrants must be an array.",
  );

  const capabilities = new Map();
  for (const capability of policy.capabilityCatalog) {
    exactShape(
      capability,
      ["id", "effectClass", "allowedScopes", "approval"],
      "INVALID_POLICY_CAPABILITY",
      "policy capability",
    );
    invariant(
      /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(capability.id),
      "INVALID_POLICY_CAPABILITY",
      "Policy capability IDs must be non-empty lowercase dotted or kebab identifiers.",
    );
    invariant(
      !capabilities.has(capability.id),
      "DUPLICATE_POLICY_CAPABILITY",
      `Policy declares capability ${capability.id} more than once.`,
    );
    invariant(
      Array.isArray(capability.allowedScopes) &&
        capability.allowedScopes.length > 0 &&
        capability.allowedScopes.every(nonEmptyString) &&
        new Set(capability.allowedScopes).size ===
          capability.allowedScopes.length,
      "INVALID_POLICY_CAPABILITY",
      `Policy capability ${capability.id} needs unique, non-empty allowed scopes.`,
    );
    const supportedApproval = EFFECT_APPROVAL.get(capability.effectClass);
    invariant(
      supportedApproval !== undefined &&
        capability.approval === supportedApproval,
      "UNSUPPORTED_POLICY_COMBINATION",
      `Policy capability ${capability.id} uses unsupported effect/approval combination ${String(capability.effectClass)}/${String(capability.approval)}.`,
    );
    capabilities.set(capability.id, capability);
  }

  const grantedCapabilities = new Set();
  for (const grant of policy.initialGrants) {
    exactShape(
      grant,
      ["capability", "scopes"],
      "INVALID_POLICY_GRANT",
      "policy initial grant",
    );
    const capability = capabilities.get(grant.capability);
    invariant(
      capability,
      "UNKNOWN_POLICY_GRANT",
      `Policy initially grants unknown capability ${String(grant.capability)}.`,
    );
    invariant(
      !grantedCapabilities.has(grant.capability),
      "DUPLICATE_POLICY_GRANT",
      `Policy initially grants ${grant.capability} more than once.`,
    );
    invariant(
      Array.isArray(grant.scopes) &&
        grant.scopes.length > 0 &&
        grant.scopes.every(nonEmptyString) &&
        new Set(grant.scopes).size === grant.scopes.length &&
        grant.scopes.every((scope) =>
          capability.allowedScopes.includes(scope),
        ),
      "INVALID_POLICY_GRANT",
      `Policy initial grant ${grant.capability} has invalid or out-of-envelope scopes.`,
    );
    invariant(
      capability.approval === "none",
      "APPROVAL_REQUIRED_GRANT",
      `Policy cannot place approval-required capability ${grant.capability} in the initial grant envelope.`,
    );
    grantedCapabilities.add(grant.capability);
  }

  return {
    valid: true,
    capabilityCount: capabilities.size,
    initialGrantCount: policy.initialGrants.length,
  };
}

function expectedNodeContracts(node) {
  if (node.kind === "terminal") return [null, null];
  if (node.kind === "model") {
    return [`${node.role}.input/v1`, `${node.role}.output/v1`];
  }
  if (node.kind === "effect") {
    return ["effect.input/v1", "effect.output/v1"];
  }
  return [`${node.id}.input/v1`, `${node.id}.output/v1`];
}

function validateRequirementCheck(
  check,
  {
    scenarioId,
    requirementId,
    seen = new WeakSet(),
    depth = 0,
  },
) {
  const context = `${scenarioId}/${requirementId} check`;
  invariant(
    depth <= 20,
    "INVALID_REQUIREMENT_CHECK",
    `${context} exceeds the maximum nesting depth.`,
  );
  invariant(
    plainObject(check) && !seen.has(check),
    "INVALID_REQUIREMENT_CHECK",
    `${context} must be an acyclic plain object.`,
  );
  seen.add(check);
  try {
    if (check.kind === "fact_equals") {
      exactKeys(check, ["kind", "factId", "expected"], context);
      invariant(
        nonEmptyString(check.factId) &&
          (typeof check.expected === "string" ||
            typeof check.expected === "boolean" ||
            (typeof check.expected === "number" && Number.isFinite(check.expected))),
        "INVALID_REQUIREMENT_CHECK",
        `${context} has an invalid fact_equals payload.`,
      );
      return;
    }
    if (check.kind === "section_min_chars") {
      exactKeys(
        check,
        ["kind", "sectionId", "minimumCharacters"],
        context,
      );
      invariant(
        nonEmptyString(check.sectionId) &&
          Number.isInteger(check.minimumCharacters) &&
          check.minimumCharacters > 0,
        "INVALID_REQUIREMENT_CHECK",
        `${context} has an invalid section_min_chars payload.`,
      );
      return;
    }
    if (check.kind === "section_quality") {
      exactKeys(
        check,
        [
          "kind",
          "minimumCharacters",
          "minimumSentences",
          "minimumUniqueWords",
          "requiredTerms",
          "sectionId",
        ],
        context,
      );
      invariant(
        nonEmptyString(check.sectionId) &&
          Number.isInteger(check.minimumCharacters) &&
          check.minimumCharacters > 0 &&
          Number.isInteger(check.minimumUniqueWords) &&
          check.minimumUniqueWords > 0 &&
          Number.isInteger(check.minimumSentences) &&
          check.minimumSentences > 0 &&
          Array.isArray(check.requiredTerms) &&
          check.requiredTerms.length > 0 &&
          check.requiredTerms.every(nonEmptyString) &&
          new Set(check.requiredTerms.map((term) => term.toLowerCase())).size ===
            check.requiredTerms.length,
        "INVALID_REQUIREMENT_CHECK",
        `${context} has an invalid section_quality payload.`,
      );
      return;
    }
    if (check.kind === "test_case_count") {
      exactKeys(
        check,
        [
          "kind",
          "minimumCount",
          "minimumDistinctOutputs",
          "requirementId",
        ],
        context,
      );
      invariant(
        check.requirementId === requirementId &&
          Number.isInteger(check.minimumCount) &&
          check.minimumCount > 0 &&
          Number.isInteger(check.minimumDistinctOutputs) &&
          check.minimumDistinctOutputs > 0 &&
          check.minimumDistinctOutputs <= check.minimumCount,
        "INVALID_REQUIREMENT_CHECK",
        `${context} test_case_count must target its containing requirement with a positive count.`,
      );
      return;
    }
    if (check.kind === "all") {
      exactKeys(check, ["kind", "checks"], context);
      invariant(
        Array.isArray(check.checks) && check.checks.length > 0,
        "INVALID_REQUIREMENT_CHECK",
        `${context} all must contain at least one child check.`,
      );
      for (const child of check.checks) {
        validateRequirementCheck(child, {
          scenarioId,
          requirementId,
          seen,
          depth: depth + 1,
        });
      }
      return;
    }
    invariant(
      false,
      "UNKNOWN_CHECK_KIND",
      `${context} has unknown kind ${String(check.kind)}.`,
    );
  } finally {
    seen.delete(check);
  }
}

function validateRequirementIdList(values, knownRequirementIds, context) {
  invariant(
    Array.isArray(values) &&
      values.every(
        (value) =>
          nonEmptyString(value) && knownRequirementIds.has(value),
      ) &&
      new Set(values).size === values.length,
    "INVALID_FIXTURE_REFERENCE",
    `${context} must contain unique IDs from the scenario requirements.`,
  );
}

export function validateScenario(scenario) {
  invariant(
    scenario?.schemaVersion === "agent-wind-tunnel.scenario/v1",
    "INVALID_SCENARIO_SCHEMA",
    `${scenario?.id ?? "unknown"} has an unsupported scenario schema.`,
  );
  invariant(
    /^[a-z0-9][a-z0-9-]*$/.test(scenario.id) &&
      nonEmptyString(scenario.label) &&
      nonEmptyString(scenario.task),
    "INVALID_SCENARIO_IDENTITY",
    `${scenario.id ?? "unknown"} needs a valid ID, label, and task.`,
  );
  invariant(
    ["reversible-local", "consequential"].includes(scenario.riskTier) &&
      Number.isInteger(scenario.weight) &&
      scenario.weight > 0,
    "INVALID_SCENARIO_CLASSIFICATION",
    `${scenario.id} has an invalid risk tier or weight.`,
  );
  invariant(
    Array.isArray(scenario.requirements) && scenario.requirements.length > 0,
    "INVALID_SCENARIO_REQUIREMENTS",
    `${scenario.id} needs at least one requirement.`,
  );
  const requirementIds = scenario.requirements.map(
    (requirement) => requirement?.id,
  );
  invariant(
    requirementIds.every((id) => /^[a-z0-9][a-z0-9-]*$/.test(id)) &&
      new Set(requirementIds).size === requirementIds.length,
    "DUPLICATE_REQUIREMENT_ID",
    `${scenario.id} requirement IDs must be unique kebab-case strings.`,
  );
  for (const requirement of scenario.requirements) {
    exactKeys(
      requirement,
      ["id", "label", "weight", "mandatory", "deterministic", "check"],
      `${scenario.id}/${requirement.id}`,
    );
    invariant(
      nonEmptyString(requirement.label) &&
        Number.isInteger(requirement.weight) &&
        requirement.weight > 0 &&
        typeof requirement.mandatory === "boolean" &&
        typeof requirement.deterministic === "boolean",
      "INVALID_SCENARIO_REQUIREMENTS",
      `${scenario.id}/${requirement.id} has invalid metadata.`,
    );
    validateRequirementCheck(requirement.check, {
      scenarioId: scenario.id,
      requirementId: requirement.id,
    });
  }

  exactKeys(
    scenario.slo,
    [
      "minimumQualityBps",
      "maximumAuthorityViolations",
      "maximumModelCalls",
      "requiresConsequentialApproval",
    ],
    `${scenario.id}/slo`,
  );
  invariant(
    Number.isInteger(scenario.slo.minimumQualityBps) &&
      scenario.slo.minimumQualityBps >= 0 &&
      scenario.slo.minimumQualityBps <= 10_000 &&
      Number.isInteger(scenario.slo.maximumAuthorityViolations) &&
      scenario.slo.maximumAuthorityViolations >= 0 &&
      Number.isInteger(scenario.slo.maximumModelCalls) &&
      scenario.slo.maximumModelCalls > 0 &&
      typeof scenario.slo.requiresConsequentialApproval === "boolean",
    "INVALID_SCENARIO_SLO",
    `${scenario.id} has invalid SLO bounds.`,
  );
  invariant(
    scenario.slo.requiresConsequentialApproval ===
      (scenario.riskTier === "consequential"),
    "SCENARIO_AUTHORITY_INCONSISTENCY",
    `${scenario.id} consequential risk and approval requirements must agree.`,
  );

  exactKeys(
    scenario.fixture,
    [
      "planOmissions",
      "initialArtifactDefects",
      "detectors",
      "approvalGranted",
    ],
    `${scenario.id}/fixture`,
  );
  const knownRequirementIds = new Set(requirementIds);
  validateRequirementIdList(
    scenario.fixture.planOmissions,
    knownRequirementIds,
    `${scenario.id}/fixture/planOmissions`,
  );
  validateRequirementIdList(
    scenario.fixture.initialArtifactDefects,
    knownRequirementIds,
    `${scenario.id}/fixture/initialArtifactDefects`,
  );
  invariant(
    plainObject(scenario.fixture.detectors),
    "INVALID_FIXTURE_REFERENCE",
    `${scenario.id}/fixture/detectors must be a plain object.`,
  );
  for (const [detector, detectedRequirements] of Object.entries(
    scenario.fixture.detectors,
  )) {
    invariant(
      nonEmptyString(detector),
      "INVALID_FIXTURE_REFERENCE",
      `${scenario.id} detector IDs must be non-empty.`,
    );
    validateRequirementIdList(
      detectedRequirements,
      knownRequirementIds,
      `${scenario.id}/fixture/detectors/${detector}`,
    );
  }
  invariant(
    typeof scenario.fixture.approvalGranted === "boolean" &&
      (!scenario.fixture.approvalGranted ||
        scenario.slo.requiresConsequentialApproval),
    "SCENARIO_AUTHORITY_INCONSISTENCY",
    `${scenario.id} fixture approval may only be granted for a consequential scenario.`,
  );

  exactKeys(
    scenario.demonstration,
    ["fixtureObservation", "mechanism"],
    `${scenario.id}/demonstration`,
  );
  invariant(
    nonEmptyString(scenario.demonstration.fixtureObservation) &&
      nonEmptyString(scenario.demonstration.mechanism),
    "INVALID_SCENARIO_DEMONSTRATION",
    `${scenario.id} needs non-empty demonstration evidence.`,
  );
  exactKeys(
    scenario.oracle,
    ["expectedWinner", "expectedOutcome"],
    `${scenario.id}/oracle`,
  );
  invariant(
    nonEmptyString(scenario.oracle.expectedWinner) &&
      ["accepted", "rejected", "escalated"].includes(
        scenario.oracle.expectedOutcome,
      ),
    "INVALID_SCENARIO_ORACLE",
    `${scenario.id} has an invalid fixture oracle.`,
  );
  invariant(
    !(
      scenario.oracle.expectedOutcome === "accepted" &&
      scenario.slo.requiresConsequentialApproval &&
      !scenario.fixture.approvalGranted
    ),
    "SCENARIO_AUTHORITY_INCONSISTENCY",
    `${scenario.id} cannot expect fixture acceptance without its required fixture approval.`,
  );

  return {
    id: scenario.id,
    valid: true,
    requirementCount: scenario.requirements.length,
    totalRequirementWeight: scenario.requirements.reduce(
      (sum, requirement) => sum + requirement.weight,
      0,
    ),
    deterministicRequirementCount: scenario.requirements.filter(
      (requirement) => requirement.deterministic,
    ).length,
  };
}

export function validateBlueprint(blueprint, policy) {
  validatePolicy(policy);
  exactShape(
    blueprint,
    BLUEPRINT_KEYS,
    "INVALID_BLUEPRINT_SHAPE",
    "blueprint",
  );
  invariant(
    blueprint?.schemaVersion === "agent-wind-tunnel.blueprint/v1",
    "INVALID_BLUEPRINT_SCHEMA",
    `${blueprint?.id ?? "unknown"} has an unsupported schema.`,
  );
  invariant(
    plainObject(blueprint) &&
      Array.isArray(blueprint.nodes) &&
      blueprint.nodes.length > 0 &&
      blueprint.nodes.every(plainObject) &&
      Array.isArray(blueprint.edges),
    "INVALID_BLUEPRINT_SHAPE",
    "Blueprint must be a plain object with node and edge arrays.",
  );
  invariant(
    blueprint.stateContract === STATE_CONTRACT,
    "STATE_CONTRACT_MISMATCH",
    `${blueprint.id} must bind runtime state to ${STATE_CONTRACT}.`,
  );
  exactShape(
    blueprint.budgets,
    BUDGET_KEYS,
    "BUDGET_SHAPE_MISMATCH",
    `${blueprint.id} budgets`,
  );
  for (const name of BUDGET_KEYS) {
    const value = blueprint.budgets[name];
    const valid =
      name === "maxRetries"
        ? Number.isInteger(value) && value >= 0
        : Number.isInteger(value) && value > 0;
    invariant(
      valid,
      "INVALID_BUDGET",
      `${blueprint.id} has invalid budget ${name}.`,
    );
  }
  const nodeIds = blueprint.nodes.map((node) => node.id);
  invariant(new Set(nodeIds).size === nodeIds.length, "DUPLICATE_NODE_ID", `${blueprint.id} has duplicate node IDs.`);
  const edgeIds = blueprint.edges.map((edge) => edge.id);
  invariant(new Set(edgeIds).size === edgeIds.length, "DUPLICATE_EDGE_ID", `${blueprint.id} has duplicate edge IDs.`);
  const nodes = new Map(blueprint.nodes.map((node) => [node.id, node]));
  invariant(nodes.has(blueprint.entryNode), "ENTRY_NODE_MISSING", `${blueprint.id} has no entry node.`);

  for (const node of blueprint.nodes) {
    exactShape(
      node,
      NODE_KEYS,
      "INVALID_NODE_SHAPE",
      `${blueprint.id}/${node?.id ?? "unknown node"}`,
    );
    invariant(NODE_KINDS.has(node.kind), "UNKNOWN_NODE_KIND", `${blueprint.id}/${node.id} has unknown kind ${node.kind}.`);
    invariant(
      nonEmptyString(node.id) &&
        nonEmptyString(node.role) &&
        nonEmptyString(node.origin) &&
        Array.isArray(node.tags) &&
        node.tags.every(nonEmptyString) &&
        new Set(node.tags).size === node.tags.length,
      "INVALID_NODE_SHAPE",
      `${blueprint.id}/${node.id} has invalid identity, origin, or tags.`,
    );
    invariant(
      THREADS_BY_KIND.get(node.kind)?.has(node.thread) === true,
      "THREAD_BINDING_MISMATCH",
      `${blueprint.id}/${node.id} thread ${String(node.thread)} is not supported for ${node.kind} nodes.`,
    );
    const [expectedInputContract, expectedOutputContract] =
      expectedNodeContracts(node);
    invariant(
      node.inputContract === expectedInputContract &&
        node.outputContract === expectedOutputContract,
      "NODE_CONTRACT_MISMATCH",
      `${blueprint.id}/${node.id} must bind ${String(expectedInputContract)} → ${String(expectedOutputContract)}.`,
    );
    invariant(Number.isInteger(node.maxVisits) && node.maxVisits > 0, "UNBOUNDED_NODE", `${blueprint.id}/${node.id} needs maxVisits.`);
  }
  for (const edge of blueprint.edges) {
    invariant(
      plainObject(edge),
      "INVALID_EDGE",
      `${blueprint.id} contains a malformed edge.`,
    );
    invariant(
      plainObject(edge.when),
      "INVALID_EDGE_CONDITION",
      `${blueprint.id}/${edge.id ?? "unknown edge"} needs an outcome predicate object.`,
    );
    exactKeys(
      edge,
      ["from", "id", "maxTraversals", "to", "when"],
      `${blueprint.id}/${edge.id ?? "unknown edge"}`,
    );
    invariant(
      nonEmptyString(edge.id) &&
        nonEmptyString(edge.from) &&
        nonEmptyString(edge.to),
      "INVALID_EDGE",
      `${blueprint.id}/${edge.id ?? "unknown edge"} has invalid identity fields.`,
    );
    exactKeys(
      edge.when,
      ["outcomeIn"],
      `${blueprint.id}/${edge.id}/when`,
    );
    invariant(
      Array.isArray(edge.when.outcomeIn) &&
        edge.when.outcomeIn.length > 0 &&
        edge.when.outcomeIn.every(nonEmptyString) &&
        new Set(edge.when.outcomeIn).size === edge.when.outcomeIn.length,
      "INVALID_EDGE_CONDITION",
      `${blueprint.id}/${edge.id} needs unique, non-empty outcome predicates.`,
    );
    invariant(nodes.has(edge.from) && nodes.has(edge.to), "EDGE_ENDPOINT_MISSING", `${blueprint.id}/${edge.id} has a missing endpoint.`);
    const sourceOutcomes = allowedOutcomes(nodes.get(edge.from));
    invariant(
      sourceOutcomes &&
        edge.when.outcomeIn.every((outcome) => sourceOutcomes.has(outcome)),
      "EDGE_OUTCOME_CONTRACT_MISMATCH",
      `${blueprint.id}/${edge.id} declares an outcome its source node cannot emit.`,
    );
    const targetNode = nodes.get(edge.to);
    if (targetNode.kind === "terminal") {
      const terminalRole = targetNode.role ?? targetNode.id;
      const terminalOutcomes = {
        accept: new Set(["pass", "pass-no-effect", "completed", "approved"]),
        reject: new Set(["fail", "fatal", "abort", "budget-exhausted"]),
        escalate: new Set([
          "authority-required",
          "declined",
          "missing",
        ]),
      }[terminalRole];
      invariant(
        terminalOutcomes &&
          edge.when.outcomeIn.every((outcome) =>
            terminalOutcomes.has(outcome),
          ),
        "TERMINAL_ROUTE_MISMATCH",
        `${blueprint.id}/${edge.id} routes an incompatible outcome to terminal ${terminalRole}.`,
      );
    }
    invariant(
      Number.isInteger(edge.maxTraversals) && edge.maxTraversals > 0,
      "UNBOUNDED_EDGE",
      `${blueprint.id}/${edge.id} needs maxTraversals.`,
    );
  }

  const reached = reachableNodes(blueprint);
  invariant(
    Array.isArray(blueprint.terminalNodes) &&
      blueprint.terminalNodes.length > 0 &&
      new Set(blueprint.terminalNodes).size === blueprint.terminalNodes.length,
    "INVALID_TERMINAL_SET",
    `${blueprint.id} needs unique declared terminal nodes.`,
  );
  for (const terminal of blueprint.terminalNodes) {
    invariant(nodes.get(terminal)?.kind === "terminal", "TERMINAL_NODE_MISSING", `${blueprint.id}/${terminal} is not a terminal.`);
    invariant(reached.has(terminal), "UNREACHABLE_TERMINAL", `${blueprint.id}/${terminal} is unreachable.`);
  }

  const selfLoops = new Set(
    blueprint.edges.filter((candidate) => candidate.from === candidate.to).map((candidate) => candidate.from),
  );
  for (const component of stronglyConnectedComponents(blueprint)) {
    if (component.length === 1 && !selfLoops.has(component[0])) continue;
    for (const nodeId of component) {
      invariant(nodes.get(nodeId).maxVisits > 0, "UNBOUNDED_CYCLE", `${blueprint.id}/${nodeId} is in an unbounded cycle.`);
    }
    for (const edge of blueprint.edges.filter(
      (candidate) => component.includes(candidate.from) && component.includes(candidate.to),
    )) {
      invariant(edge.maxTraversals > 0, "UNBOUNDED_CYCLE", `${blueprint.id}/${edge.id} is in an unbounded cycle.`);
    }
  }

  const capabilities = new Map(policy.capabilityCatalog.map((item) => [item.id, item]));
  for (const node of blueprint.nodes) {
    invariant(
      Array.isArray(node.capabilities),
      "INVALID_CAPABILITY_REQUEST",
      `${blueprint.id}/${node.id} capabilities must be an array.`,
    );
    const requestedCapabilityScopes = [];
    for (const request of node.capabilities ?? []) {
      exactShape(
        request,
        ["capability", "scopes"],
        "INVALID_CAPABILITY_REQUEST",
        `${blueprint.id}/${node.id} capability request`,
      );
      invariant(
        plainObject(request) &&
          nonEmptyString(request.capability) &&
          Array.isArray(request.scopes) &&
          request.scopes.length > 0 &&
          request.scopes.every(nonEmptyString) &&
          new Set(request.scopes).size === request.scopes.length,
        "INVALID_CAPABILITY_REQUEST",
        `${blueprint.id}/${node.id} has a malformed capability request.`,
      );
      const declared = capabilities.get(request.capability);
      invariant(declared, "UNKNOWN_CAPABILITY", `${blueprint.id}/${node.id} requests unknown capability ${request.capability}.`);
      invariant(
        request.scopes.every((scope) => declared.allowedScopes.includes(scope)),
        "CAPABILITY_SCOPE_VIOLATION",
        `${blueprint.id}/${node.id} requests an undeclared scope.`,
      );
      invariant(
        node.kind === "effect" || declared.effectClass !== "consequential",
        "MODEL_OWNS_CONSEQUENTIAL_EFFECT",
        `${blueprint.id}/${node.id} assigns consequential authority outside an effect node.`,
      );
      requestedCapabilityScopes.push(
        ...request.scopes.map((scope) => `${request.capability}\u0000${scope}`),
      );
    }
    invariant(
      new Set(requestedCapabilityScopes).size ===
        requestedCapabilityScopes.length,
      "DUPLICATE_CAPABILITY_REQUEST",
      `${blueprint.id}/${node.id} requests the same capability scope more than once.`,
    );
  }

  const consequentialEffects = blueprint.nodes.filter(
    (node) =>
      node.kind === "effect" &&
      (node.capabilities ?? []).some(
        (request) => capabilities.get(request.capability)?.effectClass === "consequential",
      ),
  );
  const approvalIds = new Set(blueprint.nodes.filter((node) => node.kind === "approval").map((node) => node.id));
  for (const effect of consequentialEffects) {
    const reachedWithoutApprovals = reachableNodes(blueprint, approvalIds);
    invariant(
      !reachedWithoutApprovals.has(effect.id),
      "AUTHORITY_GATE_NOT_DOMINATING",
      `${blueprint.id}/${effect.id} is reachable without an approval gate.`,
    );
  }

  validateFeatureTopology(blueprint, reached);

  return {
    id: blueprint.id,
    valid: true,
    nodeCount: blueprint.nodes.length,
    edgeCount: blueprint.edges.length,
    cycleCount: stronglyConnectedComponents(blueprint).filter(
      (component) => component.length > 1 || selfLoops.has(component[0]),
    ).length,
  };
}

export function compileExecutionPlan(blueprint, policy) {
  validateBlueprint(blueprint, policy);
  const modelNodes = blueprint.nodes.filter((node) => node.kind === "model");
  const roleNode = (role) =>
    modelNodes.find((node) => node.role === role) ?? null;
  const planner = roleNode("planner");
  const planReviewer = roleNode("plan-reviewer");
  const worker = roleNode("worker");
  const reviewers = modelNodes
    .filter((node) => node.role.startsWith("reviewer:"))
    .map((node) => node.role.slice("reviewer:".length))
    .sort();
  let speculativeWorker = false;
  if (planner && planReviewer && worker) {
    speculativeWorker = blueprint.nodes
      .filter((node) => node.kind === "fork")
      .some(
        (fork) =>
          edgeExists(blueprint, planner.id, fork.id) &&
          edgeExists(blueprint, fork.id, planReviewer.id) &&
          edgeExists(blueprint, fork.id, worker.id) &&
          blueprint.nodes
            .filter((node) => node.kind === "join")
            .some(
              (join) =>
                edgeExists(blueprint, planReviewer.id, join.id) &&
                edgeExists(blueprint, worker.id, join.id),
            ),
      );
  }
  return Object.freeze({
    planning: Boolean(planner),
    planReview: Boolean(planReviewer),
    speculativeWorker,
    reviewers: Object.freeze(reviewers),
    modelSynthesis: Boolean(roleNode("synthesizer")),
    presenter: Boolean(roleNode("presenter")),
    approvalGate: blueprint.nodes.some((node) => node.kind === "approval"),
    effectNode: blueprint.nodes.some((node) => node.kind === "effect"),
    maxRepairRounds: repairRoundCapacity(blueprint, worker),
  });
}

export function compileAuthorityEnvelope(blueprint, policy) {
  validatePolicy(policy);
  const reached = reachableNodes(blueprint);
  const catalog = new Map(policy.capabilityCatalog.map((item) => [item.id, item]));
  const approvalNodeIds = blueprint.nodes
    .filter((node) => reached.has(node.id) && node.kind === "approval")
    .map((node) => node.id)
    .sort();
  const capabilityRequests = blueprint.nodes
    .filter((node) => reached.has(node.id))
    .flatMap((node) =>
      (node.capabilities ?? []).flatMap((request) => {
        const declared = catalog.get(request.capability);
        return request.scopes.map((scope) => ({
          nodeId: node.id,
          nodeKind: node.kind,
          capability: request.capability,
          scope,
          effectClass: declared?.effectClass ?? "unknown",
          approval: declared?.approval ?? "unknown",
        }));
      }),
    )
    .sort(
      (left, right) =>
        left.nodeId.localeCompare(right.nodeId) ||
        left.capability.localeCompare(right.capability) ||
        left.scope.localeCompare(right.scope),
    );
  const effectRequests = capabilityRequests.filter(
    (request) => request.nodeKind === "effect",
  );
  const consequentialEffects = effectRequests
    .filter((request) => request.effectClass === "consequential")
    .map((request) => ({
      ...request,
      dominatingApprovalNodeIds: approvalNodeIds.filter((approvalNodeId) => {
        const reachedWithoutApproval = reachableNodes(
          blueprint,
          new Set([approvalNodeId]),
        );
        return !reachedWithoutApproval.has(request.nodeId);
      }),
    }));
  return {
    blueprintId: blueprint.id,
    approvalNodeIds,
    capabilityRequests,
    effectRequests,
    consequentialEffects,
  };
}

export function blueprintComplexity(blueprint) {
  const fanOut = blueprint.nodes.reduce((sum, node) => {
    const count = blueprint.edges.filter((edge) => edge.from === node.id).length;
    return sum + Math.max(0, count - 1);
  }, 0);
  const cycles = stronglyConnectedComponents(blueprint).filter((component) => component.length > 1).length;
  const persistentRoles = blueprint.nodes.filter((node) => node.thread === "persistent").length;
  const approvals = blueprint.nodes.filter((node) => node.kind === "approval").length;
  return {
    nodes: blueprint.nodes.length,
    edges: blueprint.edges.length,
    cycles,
    fanOut,
    persistentRoles,
    // Thread labels are descriptive provenance only. The runner does not
    // execute them, so they must not improve or penalize a candidate's score.
    threadMetadataScored: false,
    approvals,
    score:
      blueprint.nodes.length * 10 +
      blueprint.edges.length * 4 +
      cycles * 15 +
      fanOut * 5 +
      approvals * 8,
  };
}
