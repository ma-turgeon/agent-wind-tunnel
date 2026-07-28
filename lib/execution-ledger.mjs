import {
  deepClone,
  deepFreeze,
  invariant,
} from "./util.mjs";

function immutableCopy(value) {
  return deepFreeze(deepClone(value));
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/*
 * Runtime accounting for an already validated Blueprint IR.
 *
 * The ledger intentionally does not choose routes or enter a transition's
 * target implicitly. A graph executor must:
 *
 *   ledger.enter(entryNode);
 *   ledger.transition(fromNode, emittedOutcome, toNode);
 *   ledger.enter(toNode);
 *
 * Keeping those operations separate supports fork/join execution while still
 * making every node visit and every selected edge explicit and auditable.
 */
export function createExecutionLedger(blueprint) {
  invariant(
    blueprint &&
      typeof blueprint === "object" &&
      Array.isArray(blueprint.nodes) &&
      Array.isArray(blueprint.edges),
    "INVALID_EXECUTION_LEDGER_BLUEPRINT",
    "Execution ledger requires a validated blueprint.",
  );
  invariant(
    Number.isInteger(blueprint.budgets?.maxNodeVisits) &&
      blueprint.budgets.maxNodeVisits > 0,
    "INVALID_EXECUTION_LEDGER_BLUEPRINT",
    "Execution ledger requires a positive global maxNodeVisits budget.",
  );

  const nodeSpecs = new Map();
  for (const node of blueprint.nodes) {
    invariant(
      nonEmptyString(node?.id) &&
        Number.isInteger(node.maxVisits) &&
        node.maxVisits > 0 &&
        !nodeSpecs.has(node.id),
      "INVALID_EXECUTION_LEDGER_BLUEPRINT",
      "Execution ledger requires unique nodes with positive maxVisits bounds.",
    );
    nodeSpecs.set(
      node.id,
      immutableCopy({
        id: node.id,
        kind: node.kind,
        maxVisits: node.maxVisits,
      }),
    );
  }

  const edgeSpecs = [];
  const edgeIds = new Set();
  for (const edge of blueprint.edges) {
    invariant(
      nonEmptyString(edge?.id) &&
        !edgeIds.has(edge.id) &&
        nodeSpecs.has(edge.from) &&
        nodeSpecs.has(edge.to) &&
        Array.isArray(edge.when?.outcomeIn) &&
        edge.when.outcomeIn.length > 0 &&
        edge.when.outcomeIn.every(nonEmptyString) &&
        Number.isInteger(edge.maxTraversals) &&
        edge.maxTraversals > 0,
      "INVALID_EXECUTION_LEDGER_BLUEPRINT",
      "Execution ledger requires bounded, uniquely named edges with declared outcomes.",
    );
    edgeIds.add(edge.id);
    edgeSpecs.push(
      immutableCopy({
        id: edge.id,
        from: edge.from,
        to: edge.to,
        outcomes: [...edge.when.outcomeIn],
        maxTraversals: edge.maxTraversals,
      }),
    );
  }

  const blueprintId = blueprint.id ?? null;
  const maxNodeVisits = blueprint.budgets.maxNodeVisits;
  const nodeVisits = new Map(
    [...nodeSpecs.keys()].map((nodeId) => [nodeId, 0]),
  );
  const edgeTraversals = new Map(
    edgeSpecs.map((edge) => [edge.id, 0]),
  );
  const events = [];
  let totalNodeVisits = 0;
  let sequence = 0;

  function enter(nodeId) {
    const node = nodeSpecs.get(nodeId);
    invariant(
      node,
      "UNKNOWN_EXECUTION_NODE",
      `Execution ledger cannot enter undeclared node ${String(nodeId)}.`,
    );
    const nextNodeVisits = nodeVisits.get(nodeId) + 1;
    invariant(
      nextNodeVisits <= node.maxVisits,
      "NODE_VISIT_BUDGET_EXHAUSTED",
      `${blueprintId ?? "blueprint"}/${nodeId} exceeded maxVisits=${node.maxVisits}.`,
    );
    const nextTotalNodeVisits = totalNodeVisits + 1;
    invariant(
      nextTotalNodeVisits <= maxNodeVisits,
      "GLOBAL_NODE_VISIT_BUDGET_EXHAUSTED",
      `${blueprintId ?? "blueprint"} exceeded maxNodeVisits=${maxNodeVisits}.`,
    );

    nodeVisits.set(nodeId, nextNodeVisits);
    totalNodeVisits = nextTotalNodeVisits;
    sequence += 1;
    const event = {
      sequence,
      type: "node-visit",
      nodeId,
      nodeKind: node.kind,
      nodeVisit: nextNodeVisits,
      totalNodeVisits,
    };
    events.push(event);
    return immutableCopy(event);
  }

  function transition(from, outcome, to) {
    invariant(
      nodeSpecs.has(from) && nodeSpecs.has(to),
      "UNKNOWN_EXECUTION_NODE",
      `Execution ledger transition references an undeclared node: ${String(from)} -> ${String(to)}.`,
    );
    invariant(
      nonEmptyString(outcome),
      "UNDECLARED_RUNTIME_TRANSITION",
      "Execution ledger requires a non-empty emitted outcome.",
    );
    invariant(
      nodeVisits.get(from) > 0,
      "UNENTERED_TRANSITION_SOURCE",
      `Execution ledger cannot leave ${from} before that node is entered.`,
    );

    const matchingEdges = edgeSpecs.filter(
      (edge) =>
        edge.from === from &&
        edge.to === to &&
        edge.outcomes.includes(outcome),
    );
    invariant(
      matchingEdges.length > 0,
      "UNDECLARED_RUNTIME_TRANSITION",
      `${blueprintId ?? "blueprint"} declares no ${from}/${outcome} -> ${to} transition.`,
    );
    invariant(
      matchingEdges.length === 1,
      "AMBIGUOUS_RUNTIME_TRANSITION",
      `${blueprintId ?? "blueprint"} declares ${from}/${outcome} -> ${to} more than once.`,
    );

    const edge = matchingEdges[0];
    const nextTraversals = edgeTraversals.get(edge.id) + 1;
    invariant(
      nextTraversals <= edge.maxTraversals,
      "EDGE_TRAVERSAL_BUDGET_EXHAUSTED",
      `${blueprintId ?? "blueprint"}/${edge.id} exceeded maxTraversals=${edge.maxTraversals}.`,
    );

    edgeTraversals.set(edge.id, nextTraversals);
    sequence += 1;
    const event = {
      sequence,
      type: "edge-transition",
      edgeId: edge.id,
      from,
      outcome,
      to,
      edgeTraversal: nextTraversals,
    };
    events.push(event);
    return immutableCopy(event);
  }

  function snapshot() {
    return immutableCopy({
      blueprintId,
      maxNodeVisits,
      totalNodeVisits,
      nodeVisits: Object.fromEntries(nodeVisits),
      edgeTraversals: Object.fromEntries(edgeTraversals),
      events,
    });
  }

  return deepFreeze({
    enter,
    transition,
    snapshot,
  });
}
