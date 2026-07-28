import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildBlueprints } from "../lib/catalog.mjs";
import { createExecutionLedger } from "../lib/execution-ledger.mjs";
import { deepClone } from "../lib/util.mjs";

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testRoot, "..");
const directBlueprint = buildBlueprints(projectRoot).find(
  (blueprint) => blueprint.id === "direct",
);

test("ledger records an exact declared path across every node kind", () => {
  const ledger = createExecutionLedger(directBlueprint);
  ledger.enter("worker");
  ledger.transition("worker", "completed", "verifier");
  ledger.enter("verifier");
  ledger.transition("verifier", "pass", "accept");
  ledger.enter("accept");

  const snapshot = ledger.snapshot();
  assert.equal(snapshot.totalNodeVisits, 3);
  assert.equal(snapshot.nodeVisits.worker, 1);
  assert.equal(snapshot.nodeVisits.verifier, 1);
  assert.equal(snapshot.nodeVisits.accept, 1);
  assert.equal(snapshot.edgeTraversals["worker-verifier"], 1);
  assert.equal(snapshot.edgeTraversals["verifier-accept"], 1);
  assert.deepEqual(
    snapshot.events.map((event) => event.type),
    [
      "node-visit",
      "edge-transition",
      "node-visit",
      "edge-transition",
      "node-visit",
    ],
  );
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.events), true);
});

test("ledger rejects undeclared outcomes and targets without mutating state", () => {
  const ledger = createExecutionLedger(directBlueprint);
  ledger.enter("worker");
  const before = ledger.snapshot();

  assert.throws(
    () => ledger.transition("worker", "invented", "verifier"),
    (error) => error.code === "UNDECLARED_RUNTIME_TRANSITION",
  );
  assert.throws(
    () => ledger.transition("worker", "completed", "accept"),
    (error) => error.code === "UNDECLARED_RUNTIME_TRANSITION",
  );
  assert.deepEqual(ledger.snapshot(), before);
});

test("ledger enforces non-model maxVisits and global node visits atomically", () => {
  const bounded = deepClone(directBlueprint);
  bounded.nodes.find((node) => node.id === "verifier").maxVisits = 1;
  bounded.budgets.maxNodeVisits = 2;
  const ledger = createExecutionLedger(bounded);

  ledger.enter("worker");
  ledger.enter("verifier");
  const before = ledger.snapshot();
  assert.throws(
    () => ledger.enter("verifier"),
    (error) => error.code === "NODE_VISIT_BUDGET_EXHAUSTED",
  );
  assert.throws(
    () => ledger.enter("accept"),
    (error) => error.code === "GLOBAL_NODE_VISIT_BUDGET_EXHAUSTED",
  );
  assert.deepEqual(ledger.snapshot(), before);
});

test("ledger enforces edge maxTraversals atomically", () => {
  const ledger = createExecutionLedger(directBlueprint);
  ledger.enter("worker");
  ledger.transition("worker", "completed", "verifier");
  const before = ledger.snapshot();

  assert.throws(
    () => ledger.transition("worker", "completed", "verifier"),
    (error) => error.code === "EDGE_TRAVERSAL_BUDGET_EXHAUSTED",
  );
  assert.deepEqual(ledger.snapshot(), before);
});

test("ledger freezes compiled bounds against caller mutation", () => {
  const mutable = deepClone(directBlueprint);
  const ledger = createExecutionLedger(mutable);
  mutable.nodes.find((node) => node.id === "worker").maxVisits = 99;
  mutable.edges.find((edge) => edge.id === "worker-verifier").maxTraversals = 99;
  mutable.budgets.maxNodeVisits = 99;

  ledger.enter("worker");
  ledger.transition("worker", "completed", "verifier");
  assert.throws(
    () => ledger.enter("worker"),
    (error) => error.code === "NODE_VISIT_BUDGET_EXHAUSTED",
  );
  assert.throws(
    () => ledger.transition("worker", "completed", "verifier"),
    (error) => error.code === "EDGE_TRAVERSAL_BUDGET_EXHAUSTED",
  );
  assert.equal(ledger.snapshot().maxNodeVisits, 40);
});

test("ledger fails closed when the global node-visit budget is absent", () => {
  const unbounded = deepClone(directBlueprint);
  delete unbounded.budgets.maxNodeVisits;
  assert.throws(
    () => createExecutionLedger(unbounded),
    (error) => error.code === "INVALID_EXECUTION_LEDGER_BLUEPRINT",
  );
});

test("ledger requires a source visit before a transition", () => {
  const ledger = createExecutionLedger(directBlueprint);
  assert.throws(
    () => ledger.transition("worker", "completed", "verifier"),
    (error) => error.code === "UNENTERED_TRANSITION_SOURCE",
  );
});
