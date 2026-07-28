import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import {
  createAuthorityBroker,
} from "./authority.mjs";
import { createExecutionLedger } from "./execution-ledger.mjs";
import {
  dedupeFindings,
  validateRoleOutput,
  validateRoleReferences,
} from "./contracts.mjs";
import { publicScenario } from "./catalog.mjs";
import { evaluateRequirements } from "./checks.mjs";
import {
  estimateUsageCost,
  validatePriceCard,
  validateScenarioPack,
} from "./experiment-inputs.mjs";
import {
  blueprintComplexity,
  compileExecutionPlan,
  validateBlueprint,
  validateScenario,
} from "./validate.mjs";
import {
  canonicalHash,
  deepClone,
  deepFreeze,
  mean,
  percentile,
  stableStringify,
  uniqueSorted,
} from "./util.mjs";

function deterministicFindings(scenario, artifact) {
  return evaluateRequirements(scenario, artifact)
    .filter(({ requirement, passed }) => requirement.deterministic && !passed)
    .map(({ requirement }) => ({
      requirementId: requirement.id,
      severity: "error",
      message: `Deterministic verifier failed the declared check for ${requirement.id}.`,
    }));
}

function qualityScore(scenario, artifact) {
  const evaluations = evaluateRequirements(scenario, artifact);
  const total = scenario.requirements.reduce((sum, item) => sum + item.weight, 0);
  const passed = evaluations
    .filter((item) => item.passed)
    .reduce((sum, item) => sum + item.requirement.weight, 0);
  return {
    basisPoints: total ? Math.round((passed / total) * 10_000) : 10_000,
    passedWeight: passed,
    totalWeight: total,
    passedRequirementIds: evaluations
      .filter((item) => item.passed)
      .map((item) => item.requirement.id),
    missingRequirementIds: evaluations
      .filter((item) => !item.passed)
      .map((item) => item.requirement.id),
    mandatoryMissingRequirementIds: evaluations
      .filter((item) => item.requirement.mandatory && !item.passed)
      .map((item) => item.requirement.id),
    checkEvidence: evaluations.map((item) => ({
      requirementId: item.requirement.id,
      passed: item.passed,
      evidence: item.evidence,
    })),
  };
}

function errorStatus(error) {
  if (error.code === "CONTRACT_VIOLATION") return "contract_error";
  if (
    error.code === "COMPILED_PLAN_MISMATCH" ||
    error.code === "UNDECLARED_RUNTIME_TRANSITION" ||
    error.code === "AMBIGUOUS_RUNTIME_TRANSITION" ||
    error.code === "UNENTERED_TRANSITION_SOURCE"
  ) {
    return "contract_error";
  }
  if (error.code === "TIMEOUT") return "timeout";
  if (
    error.code === "BUDGET_EXHAUSTED" ||
    error.code === "NODE_VISIT_BUDGET_EXHAUSTED" ||
    error.code === "GLOBAL_NODE_VISIT_BUDGET_EXHAUSTED" ||
    error.code === "EDGE_TRAVERSAL_BUDGET_EXHAUSTED"
  ) {
    return "budget_exhausted";
  }
  if (error.code === "REFUSAL") return "refused";
  if (error.code === "PERMISSION_ESCALATED") return "escalated";
  if (error.code === "MODEL_ABORT" || error.code === "FATAL_REVIEW") return "rejected";
  return "api_error";
}

function usageFromTrace(trace, virtualLatencyTicks, wallLatencyMs) {
  return {
    modelCalls: trace.filter((event) => event.type === "model-call").length,
    retries: trace.filter((event) => event.type === "model-call" && event.attempt > 1).length,
    tokenUnits: trace.reduce((sum, event) => sum + (event.usage?.tokenUnits ?? 0), 0),
    latencyTicks: virtualLatencyTicks,
    latencyMs: wallLatencyMs,
    inputTokens: trace.reduce((sum, event) => sum + (event.usage?.inputTokens ?? 0), 0),
    cachedInputTokens: trace.reduce(
      (sum, event) => sum + (event.usage?.cachedInputTokens ?? 0),
      0,
    ),
    cacheWriteInputTokens: trace.reduce(
      (sum, event) => sum + (event.usage?.cacheWriteInputTokens ?? 0),
      0,
    ),
    outputTokens: trace.reduce((sum, event) => sum + (event.usage?.outputTokens ?? 0), 0),
    totalTokens: trace.reduce((sum, event) => sum + (event.usage?.totalTokens ?? 0), 0),
  };
}

function checkObservedBudgets(
  blueprint,
  trace,
  virtualLatencyTicks,
  wallLatencyMs,
) {
  const usage = usageFromTrace(trace, virtualLatencyTicks, wallLatencyMs);
  if (
    usage.tokenUnits > blueprint.budgets.maxTokenUnits ||
    usage.latencyTicks > blueprint.budgets.maxLatencyTicks
  ) {
    throw Object.assign(new Error("Run exhausted a declared budget."), {
      code: "BUDGET_EXHAUSTED",
      usage,
    });
  }
}

export async function executeCandidate({
  runId,
  blueprint,
  scenario,
  adapter,
  policy,
  repetition = 1,
  approvalProvider,
}) {
  const executionPlan = compileExecutionPlan(blueprint, policy);
  validateScenario(scenario);
  const executionLedger = createExecutionLedger(blueprint);
  const trace = [];
  let sequence = 0;
  let virtualLatencyTicks = 0;
  let wallLatencyMs = 0;
  let artifact = null;
  let plan = null;
  let presenter = null;
  let reservedModelCalls = 0;
  let reservedLogicalVisits = 0;
  const reservedVisitsByNode = new Map();
  const nodesById = new Map(blueprint.nodes.map((node) => [node.id, node]));
  const pendingModelEntries = new Map([[blueprint.entryNode, 1]]);
  const broker = createAuthorityBroker({
    policy,
    scenario,
    blueprint,
    runId,
    approvalProvider,
  });
  const visibleScenario = publicScenario(scenario);

  function compiledMismatch(message) {
    return Object.assign(new Error(message), {
      code: "COMPILED_PLAN_MISMATCH",
    });
  }

  function queueModelEntry(nodeId) {
    pendingModelEntries.set(
      nodeId,
      (pendingModelEntries.get(nodeId) ?? 0) + 1,
    );
  }

  function enterNode(nodeId) {
    executionLedger.enter(nodeId);
  }

  function transition(from, outcome, to, { enterTarget = true } = {}) {
    executionLedger.transition(from, outcome, to);
    const target = nodesById.get(to);
    if (!target) throw compiledMismatch(`Runtime selected unknown target ${to}.`);
    if (target.kind === "model") {
      queueModelEntry(to);
    } else if (enterTarget) {
      enterNode(to);
    }
  }

  function reserve(role, nodeId) {
    const node = nodesById.get(nodeId);
    if (!node || node.kind !== "model" || node.role !== role) {
      throw Object.assign(
        new Error(`Compiled plan attempted undeclared model node ${nodeId}/${role}.`),
        { code: "COMPILED_PLAN_MISMATCH" },
      );
    }
    const nextLogicalVisits = reservedLogicalVisits + 1;
    const nextNodeVisits = (reservedVisitsByNode.get(nodeId) ?? 0) + 1;
    if (
      nextLogicalVisits > blueprint.budgets.maxNodeVisits ||
      nextNodeVisits > node.maxVisits
    ) {
      throw Object.assign(
        new Error("Run cannot reserve another declared model-node visit."),
        { code: "BUDGET_EXHAUSTED" },
      );
    }
    const pendingEntries = pendingModelEntries.get(nodeId) ?? 0;
    if (pendingEntries < 1) {
      throw compiledMismatch(
        `Model node ${nodeId}/${role} was invoked without a declared inbound transition.`,
      );
    }
    for (const request of node.capabilities ?? []) {
      const decision = broker.requestPermission({
        capability: request.capability,
        scopes: request.scopes,
        requestedBy: nodeId,
      });
      if (decision.decision !== "granted-within-envelope") {
        throw Object.assign(
          new Error(
            `Model node ${nodeId}/${role} lacks its compiled capability grant.`,
          ),
          {
            code: "PERMISSION_ESCALATED",
            authorityEvent: decision,
          },
        );
      }
    }
    executionLedger.enter(nodeId);
    pendingModelEntries.set(nodeId, pendingEntries - 1);
    reservedLogicalVisits = nextLogicalVisits;
    reservedVisitsByNode.set(nodeId, nextNodeVisits);
    sequence += 1;
    return {
      baseSequence: sequence,
      role,
      nodeId,
    };
  }

  function reserveAttempt() {
    const next = reservedModelCalls + 1;
    if (
      next > blueprint.budgets.maxModelCalls ||
      next > scenario.slo.maximumModelCalls
    ) {
      throw Object.assign(
        new Error("Run cannot reserve another model-call attempt."),
        { code: "BUDGET_EXHAUSTED" },
      );
    }
    reservedModelCalls = next;
  }

  function checkProjectedRoleBudgets(events) {
    const projectedTicks =
      virtualLatencyTicks +
      events.reduce(
        (sum, event) => sum + (event.usage?.latencyTicks ?? 0),
        0,
      );
    const projectedLatencyMs =
      wallLatencyMs +
      events.reduce(
        (sum, event) =>
          sum +
          (event.usage?.latencyMs ?? 0) +
          (event.retryDelayMs ?? 0),
        0,
      );
    try {
      checkObservedBudgets(
        blueprint,
        [...trace, ...events],
        projectedTicks,
        projectedLatencyMs,
      );
    } catch (error) {
      error.callEvents = events;
      throw error;
    }
  }

  function createParallelRetryGate(branchIds) {
    let expected = new Set(branchIds);
    let reported = new Set();
    let waiters = [];
    let terminalFailureObserved = false;
    const branchEvents = new Map(
      branchIds.map((branchId) => [branchId, []]),
    );

    const cloneError = (error) =>
      Object.assign(new Error(error.message), error);

    function projectedBudgetError() {
      const phaseEvents = [...branchEvents.values()].flat();
      const branchTicks = [...branchEvents.values()].map((events) =>
        events.reduce(
          (sum, event) => sum + (event.usage?.latencyTicks ?? 0),
          0,
        ),
      );
      const branchLatencyMs = [...branchEvents.values()].map((events) =>
        events.reduce(
          (sum, event) =>
            sum +
            (event.usage?.latencyMs ?? 0) +
            (event.retryDelayMs ?? 0),
          0,
        ),
      );
      try {
        checkObservedBudgets(
          blueprint,
          [...trace, ...phaseEvents],
          virtualLatencyTicks + Math.max(0, ...branchTicks),
          wallLatencyMs + Math.max(0, ...branchLatencyMs),
        );
        return null;
      } catch (error) {
        return error;
      }
    }

    function finishWaveIfReady() {
      if (reported.size !== expected.size) return;
      const budgetError = projectedBudgetError();
      const cancellationError =
        !budgetError && terminalFailureObserved && waiters.length
          ? Object.assign(
              new Error(
                "Parallel retry cancelled because a sibling branch already failed terminally.",
              ),
              { code: "PARALLEL_RETRY_CANCELLED" },
            )
          : null;
      const gateError = budgetError ?? cancellationError;
      const currentWaiters = waiters;
      expected = gateError
        ? new Set()
        : new Set(currentWaiters.map((waiter) => waiter.branchId));
      reported = new Set();
      waiters = [];
      terminalFailureObserved = false;
      for (const waiter of currentWaiters) {
        if (gateError) waiter.reject(cloneError(gateError));
        else waiter.resolve();
      }
    }

    function report({
      branchId,
      event = null,
      willRetry = false,
      terminalError = null,
    }) {
      if (!expected.has(branchId) || reported.has(branchId)) {
        throw compiledMismatch(
          `Parallel retry gate received an out-of-wave report from branch ${branchId}.`,
        );
      }
      if (event) branchEvents.get(branchId).push(event);
      reported.add(branchId);
      if (terminalError) terminalFailureObserved = true;
      let permission = null;
      if (willRetry) {
        permission = new Promise((resolve, reject) => {
          waiters.push({ branchId, resolve, reject });
        });
      }
      finishWaveIfReady();
      return permission;
    }

    return { report };
  }

  async function callRole(
    reservation,
    input,
    parallelRetryGate = null,
  ) {
    const serialized = stableStringify(input, 0);
    if (serialized.includes('"fixture"') || serialized.includes('"oracle"')) {
      throw Object.assign(new Error("Private fixture/oracle data reached an adapter input."), {
        code: "ORACLE_LEAK",
      });
    }
    const events = [];
    const maxAttempts = blueprint.budgets.maxRetries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        reserveAttempt();
      } catch (error) {
        parallelRetryGate?.report({
          branchId: reservation.baseSequence,
          terminalError: error,
        });
        error.callEvents = events;
        throw error;
      }
      const attemptId = [
        "awt",
        canonicalHash([
          runId,
          scenario.id,
          blueprint.id,
          repetition,
          reservation.role,
          reservation.baseSequence,
          attempt,
        ]).slice(0, 24),
      ].join("-");
      const started = performance.now();
      let response = null;
      try {
        const adapterInput = deepFreeze(
          deepClone({
            scenario: visibleScenario,
            ...input,
          }),
        );
        response = await adapter.invoke({
          runId,
          scenarioId: scenario.id,
          blueprintId: blueprint.id,
          repetition,
          role: reservation.role,
          nodeId: reservation.nodeId,
          attempt,
          attemptId,
          input: adapterInput,
        });
        const output = deepFreeze(
          deepClone(
            validateRoleReferences(
              reservation.role,
              validateRoleOutput(reservation.role, response.output),
              scenario,
            ),
          ),
        );
        events.push({
          type: "model-call",
          sequence: reservation.baseSequence + attempt / 100,
          logicalSequence: reservation.baseSequence,
          runId,
          scenarioId: scenario.id,
          blueprintId: blueprint.id,
          repetition,
          nodeId: reservation.nodeId,
          role: reservation.role,
          attempt,
          attemptId,
          callId: response.callId,
          requestedModel: response.requestedModel ?? response.model,
          returnedModel: response.returnedModel ?? response.model,
          responseId: response.responseId ?? null,
          requestId: response.requestId ?? null,
          clientRequestId: response.clientRequestId ?? null,
          status: "ok",
          usage: {
            tokenUnits: response.usage?.tokenUnits ?? response.usage?.totalTokens ?? 0,
            latencyTicks: response.usage?.latencyTicks ?? 0,
            latencyMs: response.usage?.latencyMs ?? Math.round(performance.now() - started),
            inputTokens: response.usage?.inputTokens ?? 0,
            cachedInputTokens: response.usage?.cachedInputTokens ?? 0,
            cacheWriteInputTokens: response.usage?.cacheWriteInputTokens ?? 0,
            outputTokens: response.usage?.outputTokens ?? 0,
            totalTokens: response.usage?.totalTokens ?? 0,
          },
        });
        parallelRetryGate?.report({
          branchId: reservation.baseSequence,
          event: events.at(-1),
        });
        return { output, events };
      } catch (error) {
        const responseUsage = response?.usage ?? error.responseMeta?.usage ?? error.usage;
        const elapsedMs = adapter.deterministic
          ? 0
          : Math.round(performance.now() - started);
        const willRetry =
          error.retryable === true && attempt < maxAttempts;
        const retryDelayMs =
          willRetry && adapter.deterministic !== true
            ? Math.min(
                5_000,
                Math.max(
                  0,
                  Number.isFinite(error.retryDelayMs)
                    ? error.retryDelayMs
                    : Number.isFinite(error.retryAfterMs)
                      ? error.retryAfterMs
                    : 250 * 2 ** (attempt - 1),
                ),
              )
            : 0;
        events.push({
          type: "model-call",
          sequence: reservation.baseSequence + attempt / 100,
          logicalSequence: reservation.baseSequence,
          runId,
          scenarioId: scenario.id,
          blueprintId: blueprint.id,
          repetition,
          nodeId: reservation.nodeId,
          role: reservation.role,
          attempt,
          attemptId,
          callId:
            response?.callId ??
            error.responseMeta?.callId ??
            error.callId ??
            null,
          requestedModel:
            response?.requestedModel ??
            error.responseMeta?.requestedModel ??
            error.requestedModel ??
            null,
          returnedModel:
            response?.returnedModel ??
            response?.model ??
            error.responseMeta?.returnedModel ??
            error.returnedModel ??
            null,
          responseId:
            response?.responseId ??
            error.responseMeta?.responseId ??
            error.responseId ??
            null,
          requestId:
            response?.requestId ??
            error.responseMeta?.requestId ??
            error.requestId ??
            null,
          clientRequestId:
            response?.clientRequestId ??
            error.responseMeta?.clientRequestId ??
            error.clientRequestId ??
            null,
          status: "error",
          errorCode: error.code ?? error.name ?? "ERROR",
          retryable: error.retryable === true,
          retryDelayMs,
          usage: {
            tokenUnits:
              responseUsage?.tokenUnits ??
              responseUsage?.totalTokens ??
              0,
            latencyTicks: responseUsage?.latencyTicks ?? 1,
            latencyMs: responseUsage?.latencyMs ?? elapsedMs,
            inputTokens: responseUsage?.inputTokens ?? 0,
            cachedInputTokens: responseUsage?.cachedInputTokens ?? 0,
            cacheWriteInputTokens: responseUsage?.cacheWriteInputTokens ?? 0,
            outputTokens: responseUsage?.outputTokens ?? 0,
            totalTokens: responseUsage?.totalTokens ?? 0,
          },
        });
        if (parallelRetryGate) {
          if (willRetry) {
            try {
              await parallelRetryGate.report({
                branchId: reservation.baseSequence,
                event: events.at(-1),
                willRetry: true,
              });
            } catch (gateError) {
              gateError.callEvents = events;
              throw gateError;
            }
          } else {
            parallelRetryGate.report({
              branchId: reservation.baseSequence,
              event: events.at(-1),
              terminalError: error,
            });
          }
        } else {
          checkProjectedRoleBudgets(events);
        }
        if (!willRetry) {
          error.callEvents = events;
          throw error;
        }
        if (retryDelayMs > 0) await delay(retryDelayMs);
      }
    }
    throw new Error("Unreachable callRole termination.");
  }

  function commitPhase(results, { enforceObservedBudgets = true } = {}) {
    const list = Array.isArray(results) ? results : [results];
    const events = list.flatMap((result) => result.events);
    trace.push(...events.sort((left, right) => left.sequence - right.sequence));
    const branchTicks = list.map((result) =>
      result.events.reduce((sum, event) => sum + (event.usage?.latencyTicks ?? 0), 0),
    );
    virtualLatencyTicks += Math.max(0, ...branchTicks);
    const branchLatencyMs = list.map((result) =>
      result.events.reduce(
        (sum, event) =>
          sum +
          (event.usage?.latencyMs ?? 0) +
          (event.retryDelayMs ?? 0),
        0,
      ),
    );
    wallLatencyMs += Math.max(0, ...branchLatencyMs);
    if (enforceObservedBudgets) {
      checkObservedBudgets(
        blueprint,
        trace,
        virtualLatencyTicks,
        wallLatencyMs,
      );
    }
  }

  async function invokeSequential(role, nodeId, input) {
    const result = await callRole(reserve(role, nodeId), input);
    commitPhase(result);
    return result.output;
  }

  async function invokeParallel(calls) {
    const reservations = calls.map((call) => ({
      call,
      reservation: reserve(call.role, call.nodeId),
    }));
    const retryGate = createParallelRetryGate(
      reservations.map(({ reservation }) => reservation.baseSequence),
    );
    const settled = await Promise.allSettled(
      reservations.map(({ call, reservation }) =>
        callRole(reservation, call.input, retryGate),
      ),
    );
    const phaseResults = settled.map((result) =>
      result.status === "fulfilled"
        ? result.value
        : { events: result.reason.callEvents ?? [] },
    );
    commitPhase(phaseResults, { enforceObservedBudgets: false });
    const failures = settled
      .map((result, index) => ({ result, index }))
      .filter(({ result }) => result.status === "rejected");
    if (failures.length) {
      failures.sort(
        (left, right) =>
          Number(right.result.reason.systemic === true) -
            Number(left.result.reason.systemic === true) ||
          Number(left.result.reason.code === "PARALLEL_RETRY_CANCELLED") -
            Number(right.result.reason.code === "PARALLEL_RETRY_CANCELLED") ||
          reservations[left.index].reservation.baseSequence -
            reservations[right.index].reservation.baseSequence,
      );
      const error = failures[0].result.reason;
      error.callEventsCommitted = true;
      throw error;
    }
    checkObservedBudgets(
      blueprint,
      trace,
      virtualLatencyTicks,
      wallLatencyMs,
    );
    return settled.map((result) => result.value.output);
  }

  function throwTerminalReview(code, role, output) {
    throw Object.assign(
      new Error(`${role} terminated the candidate with verdict ${output.verdict}.`),
      {
        code,
        verdict: output.verdict,
        findings: output.findings,
      },
    );
  }

  try {
    let artifactSource = null;
    if (executionPlan.planning) {
      plan = await invokeSequential("planner", "planner", { feedback: [] });
      if (executionPlan.planReview && executionPlan.speculativeWorker) {
        let discardedSpeculativeArtifactHash = null;
        for (;;) {
          transition("planner", "completed", "plan-fork");
          transition("plan-fork", "fork", "plan-reviewer");
          transition("plan-fork", "fork", "worker");
          const [planReview, work] = await invokeParallel([
            { role: "plan-reviewer", nodeId: "plan-reviewer", input: { plan } },
            {
              role: "worker",
              nodeId: "worker",
              input: {
                plan,
                feedback: [],
                discardedSpeculativeArtifactHash,
              },
            },
          ]);
          transition("worker", "completed", "plan-join", {
            enterTarget: false,
          });
          if (planReview.verdict === "abort") {
            transition("plan-reviewer", "abort", "reject");
            throwTerminalReview("MODEL_ABORT", "plan-reviewer", planReview);
          }
          if (planReview.verdict === "approve") {
            transition("plan-reviewer", "approve", "plan-join", {
              enterTarget: false,
            });
            enterNode("plan-join");
            artifact = work.artifact;
            artifactSource = {
              from: "plan-join",
              outcome: "joined",
            };
            break;
          }
          discardedSpeculativeArtifactHash = canonicalHash(work.artifact);
          transition("plan-reviewer", "revise", "planner");
          plan = await invokeSequential("planner", "planner", {
            previousPlan: plan,
            feedback: planReview.findings,
          });
        }
      } else if (executionPlan.planReview) {
        transition("planner", "completed", "plan-reviewer");
        for (;;) {
          const review = await invokeSequential(
            "plan-reviewer",
            "plan-reviewer",
            { plan },
          );
          if (review.verdict === "abort") {
            transition("plan-reviewer", "abort", "reject");
            throwTerminalReview("MODEL_ABORT", "plan-reviewer", review);
          }
          if (review.verdict === "approve") {
            transition("plan-reviewer", "approve", "worker");
            break;
          }
          transition("plan-reviewer", "revise", "planner");
          plan = await invokeSequential("planner", "planner", {
            previousPlan: plan,
            feedback: review.findings,
          });
          transition("planner", "completed", "plan-reviewer");
        }
      } else {
        transition("planner", "completed", "worker");
      }
    }

    if (!artifact) {
      const work = await invokeSequential("worker", "worker", { plan, feedback: [] });
      artifact = work.artifact;
      artifactSource = { from: "worker", outcome: "completed" };
    }

    let acceptedQuality = false;
    let status = "rejected";
    let decisionNodeId = null;
    let evaluationGate = {
      passed: false,
      roundsEvaluated: 0,
      reviseRoles: [],
      unresolvedFindings: [],
      missingRequirementIds: [],
    };
    for (let round = 0; round <= executionPlan.maxRepairRounds; round += 1) {
      transition(
        artifactSource.from,
        artifactSource.outcome,
        "verifier",
      );
      const verifierFindings = deterministicFindings(scenario, artifact);
      const roundQuality = qualityScore(scenario, artifact);
      const deterministicGatePassed =
        roundQuality.mandatoryMissingRequirementIds.length === 0 &&
        roundQuality.basisPoints >= scenario.slo.minimumQualityBps;
      const verifierOutcome = deterministicGatePassed ? "pass" : "fail";
      const reviewerCalls = executionPlan.reviewers.map((rubric) => ({
        role: `reviewer:${rubric}`,
        nodeId: `reviewer-${rubric}`,
        input: { artifact, plan, verifierFindings, round: round + 1 },
      }));

      if (reviewerCalls.length === 0) {
        evaluationGate = {
          passed: deterministicGatePassed,
          roundsEvaluated: round + 1,
          reviseRoles: [],
          unresolvedFindings: verifierFindings,
          missingRequirementIds: roundQuality.missingRequirementIds,
        };
        if (deterministicGatePassed) {
          acceptedQuality = true;
          decisionNodeId = "verifier";
        } else {
          transition("verifier", "fail", "reject");
        }
        break;
      }

      let reviewJoin = null;
      if (reviewerCalls.length === 1) {
        transition(
          "verifier",
          verifierOutcome,
          reviewerCalls[0].nodeId,
        );
      } else {
        transition("verifier", verifierOutcome, "review-fork");
        for (const call of reviewerCalls) {
          transition("review-fork", "fork", call.nodeId);
        }
        reviewJoin = "review-join";
      }

      const reviews = await invokeParallel(reviewerCalls);
      const fatalReview = reviews.find((review) => review.verdict === "fatal");
      if (reviewerCalls.length === 1) {
        transition(
          reviewerCalls[0].nodeId,
          reviews[0].verdict,
          reviews[0].verdict === "fatal"
            ? "reject"
            : "merge-feedback",
        );
      } else {
        let fatalRouted = false;
        for (let index = 0; index < reviews.length; index += 1) {
          const review = reviews[index];
          if (review.verdict === "fatal") {
            transition(
              reviewerCalls[index].nodeId,
              "fatal",
              "reject",
              { enterTarget: !fatalRouted },
            );
            fatalRouted = true;
          } else {
            transition(
              reviewerCalls[index].nodeId,
              review.verdict,
              reviewJoin,
              { enterTarget: false },
            );
          }
        }
        if (!fatalReview) enterNode(reviewJoin);
      }
      if (fatalReview) {
        throwTerminalReview("FATAL_REVIEW", "reviewer", fatalReview);
      }

      const reviewerFindings = reviews.flatMap((review) => review.findings);
      let synthesis = null;
      let decisionNode =
        reviewerCalls.length === 1
          ? "merge-feedback"
          : reviewJoin;
      if (executionPlan.modelSynthesis) {
        transition(reviewJoin, "joined", "synthesizer");
        const deterministicMerge = dedupeFindings([...verifierFindings, ...reviewerFindings]);
        synthesis = await invokeSequential("synthesizer", "synthesizer", {
          artifact,
          plan,
          findings: deterministicMerge,
          round: round + 1,
        });
        const upstreamRequiresRevision =
          !deterministicGatePassed ||
          reviews.some((review) => review.verdict === "revise");
        if (upstreamRequiresRevision && synthesis.verdict === "pass") {
          throw Object.assign(
            new Error(
              "synthesizer passed while upstream deterministic/reviewer findings still required revision.",
            ),
            { code: "CONTRACT_VIOLATION" },
          );
        }
        if (synthesis.verdict === "fatal") {
          transition("synthesizer", "fatal", "reject");
          throwTerminalReview("FATAL_REVIEW", "synthesizer", synthesis);
        }
        decisionNode = "synthesizer";
      } else if (
        reviewerCalls.length > 1 &&
        nodesById.has("merge-feedback")
      ) {
        transition(reviewJoin, "joined", "merge-feedback");
        decisionNode = "merge-feedback";
      }

      const reviseRoles = reviews.flatMap((review, index) =>
        review.verdict === "revise" ? [reviewerCalls[index].role] : [],
      );
      if (synthesis?.verdict === "revise") reviseRoles.push("synthesizer");
      const reviseFindings = [
        ...reviews.flatMap((review) =>
          review.verdict === "revise" ? review.findings : [],
        ),
        ...(synthesis?.verdict === "revise" ? synthesis.findings : []),
      ];
      const reviewFeedback = dedupeFindings(
        [
          ...reviewerFindings,
          ...(synthesis?.findings ?? []),
          ...reviseFindings,
        ].filter((finding) =>
          reviseFindings.includes(finding) ||
          finding.severity === "error" ||
          finding.severity === "fatal",
        ),
      );
      const feedback = dedupeFindings([
        ...(deterministicGatePassed ? [] : verifierFindings),
        ...reviewFeedback,
      ]);
      evaluationGate = {
        passed:
          deterministicGatePassed &&
          reviseRoles.length === 0 &&
          reviewFeedback.length === 0,
        roundsEvaluated: round + 1,
        reviseRoles,
        unresolvedFindings: feedback,
        missingRequirementIds: roundQuality.missingRequirementIds,
      };
      if (evaluationGate.passed) {
        acceptedQuality = true;
        decisionNodeId = decisionNode;
        break;
      }
      if (!feedback.length || round === executionPlan.maxRepairRounds) {
        transition(decisionNode, "budget-exhausted", "reject");
        break;
      }
      transition(decisionNode, "revise", "worker");
      const work = await invokeSequential("worker", "worker", {
        plan,
        previousArtifact: artifact,
        feedback,
        round: round + 2,
      });
      artifact = work.artifact;
      if (executionPlan.speculativeWorker) {
        transition("worker", "completed", "plan-join");
        artifactSource = { from: "plan-join", outcome: "joined" };
      } else {
        artifactSource = { from: "worker", outcome: "completed" };
      }
    }

    const quality = {
      ...qualityScore(scenario, artifact),
      evaluationGate,
    };
    const deterministicConformancePassed =
      quality.mandatoryMissingRequirementIds.length === 0 &&
      quality.basisPoints >= scenario.slo.minimumQualityBps;
    acceptedQuality =
      acceptedQuality &&
      evaluationGate.passed &&
      deterministicConformancePassed;
    let authority = { required: false, allowed: true, executed: false };

    const finishAtAccept = async (from, outcome) => {
      const target = executionPlan.presenter ? "presenter" : "accept";
      transition(from, outcome, target);
      if (target === "presenter") {
        presenter = await invokeSequential(
          "presenter",
          "presenter",
          { artifact, plan },
        );
        transition("presenter", "completed", "accept");
      }
      status = "accepted";
    };

    if (acceptedQuality) {
      if (scenario.slo.requiresConsequentialApproval) {
        if (executionPlan.approvalGate && executionPlan.effectNode) {
          transition(decisionNodeId, "pass", "approval");
          authority = broker.authorizeConsequentialEffect({ artifact });
          if (authority.allowed) {
            transition("approval", "approved", "production-effect");
            await finishAtAccept("production-effect", "completed");
          } else {
            const approvalOutcome =
              authority.event?.decision === "declined"
                ? "declined"
                : "missing";
            transition("approval", approvalOutcome, "escalate");
            status = "escalated";
          }
        } else {
          authority = broker.authorizeConsequentialEffect({ artifact });
          transition(decisionNodeId, "authority-required", "escalate");
          status = "escalated";
        }
      } else if (executionPlan.approvalGate && executionPlan.effectNode) {
        await finishAtAccept(decisionNodeId, "pass-no-effect");
      } else {
        await finishAtAccept(decisionNodeId, "pass");
      }
    }

    const brokerState = broker.snapshot();
    const authorityViolations = brokerState.audit.filter(
      (event) => event.executed && event.decision !== "approved",
    ).length;
    const efficiency = usageFromTrace(trace, virtualLatencyTicks, wallLatencyMs);
    const feasible =
      status === "accepted" &&
      quality.basisPoints >= scenario.slo.minimumQualityBps &&
      authorityViolations <= scenario.slo.maximumAuthorityViolations &&
      efficiency.modelCalls <= scenario.slo.maximumModelCalls;
    return {
      runId,
      mode: adapter.kind,
      deterministic: adapter.deterministic === true,
      scenarioId: scenario.id,
      blueprintId: blueprint.id,
      repetition,
      status,
      feasible,
      quality,
      reliability: {
        contractCompliant: true,
        boundedTermination: true,
        terminalError: null,
      },
      authority: {
        ...brokerState,
        result: authority,
        violations: authorityViolations,
      },
      efficiency,
      complexity: blueprintComplexity(blueprint),
      execution: executionLedger.snapshot(),
      artifact,
      presenter,
      trace,
    };
  } catch (error) {
    if (error.callEvents && !error.callEventsCommitted) {
      trace.push(...error.callEvents.sort((left, right) => left.sequence - right.sequence));
      const errorTicks = error.callEvents.reduce(
        (sum, event) => sum + (event.usage?.latencyTicks ?? 0),
        0,
      );
      const errorLatencyMs = error.callEvents.reduce(
        (sum, event) =>
          sum +
          (event.usage?.latencyMs ?? 0) +
          (event.retryDelayMs ?? 0),
        0,
      );
      virtualLatencyTicks += errorTicks;
      wallLatencyMs += errorLatencyMs;
    }
    const brokerState = broker.snapshot();
    const finalStatus = errorStatus(error);
    return {
      runId,
      mode: adapter.kind,
      deterministic: adapter.deterministic === true,
      scenarioId: scenario.id,
      blueprintId: blueprint.id,
      repetition,
      status: finalStatus,
      feasible: false,
      quality: qualityScore(scenario, artifact),
      reliability: {
        contractCompliant: finalStatus !== "contract_error",
        boundedTermination: true,
        terminalError: {
          code: error.code ?? error.name ?? "ERROR",
          message: error.message,
          systemic: error.systemic === true,
        },
      },
      authority: {
        ...brokerState,
        result: { required: scenario.slo.requiresConsequentialApproval, allowed: false, executed: false },
        violations: 0,
      },
      efficiency: usageFromTrace(trace, virtualLatencyTicks, wallLatencyMs),
      complexity: blueprintComplexity(blueprint),
      execution: executionLedger.snapshot(),
      artifact,
      presenter,
      trace,
    };
  }
}

function aggregateCandidate(runs) {
  const first = runs[0];
  const statusCounts = Object.fromEntries(
    uniqueSorted(runs.map((run) => run.status)).map((status) => [
      status,
      runs.filter((run) => run.status === status).length,
    ]),
  );
  const acceptanceRateBps = Math.round(
    (runs.filter((run) => run.status === "accepted").length / runs.length) * 10_000,
  );
  return {
    blueprintId: first.blueprintId,
    scenarioId: first.scenarioId,
    repetitions: runs.length,
    feasible: runs.every((run) => run.feasible),
    acceptanceRateBps,
    qualityBpsMean: Math.round(mean(runs.map((run) => run.quality.basisPoints))),
    authorityViolations: runs.reduce((sum, run) => sum + run.authority.violations, 0),
    contractErrors: runs.filter((run) => !run.reliability.contractCompliant).length,
    modelCallsMean: mean(runs.map((run) => run.efficiency.modelCalls)),
    tokenUnitsMean: mean(runs.map((run) => run.efficiency.tokenUnits)),
    estimatedCostMean:
      runs.every((run) => run.efficiency.estimatedCost != null)
        ? mean(runs.map((run) => run.efficiency.estimatedCost.totalUsd))
        : null,
    latencyTicksP95: percentile(runs.map((run) => run.efficiency.latencyTicks), 0.95),
    latencyMsP95: percentile(runs.map((run) => run.efficiency.latencyMs), 0.95),
    complexity: first.complexity,
    status:
      Object.keys(statusCounts).length === 1
        ? Object.keys(statusCounts)[0]
        : "mixed",
    statusCounts,
    statuses: runs.map((run) => run.status),
  };
}

function dominates(left, right) {
  const noWorse =
    left.complexity.score <= right.complexity.score &&
    left.modelCallsMean <= right.modelCallsMean &&
    left.tokenUnitsMean <= right.tokenUnitsMean &&
    left.latencyTicksP95 <= right.latencyTicksP95;
  const strictlyBetter =
    left.complexity.score < right.complexity.score ||
    left.modelCallsMean < right.modelCallsMean ||
    left.tokenUnitsMean < right.tokenUnitsMean || // gitleaks:allow — numeric metric comparison, not a credential
    left.latencyTicksP95 < right.latencyTicksP95;
  return noWorse && strictlyBetter;
}

export function selectSmallestCandidate(aggregates) {
  const feasible = aggregates.filter(
    (item) =>
      item.feasible &&
      item.acceptanceRateBps === 10_000 &&
      item.authorityViolations === 0 &&
      item.contractErrors === 0,
  );
  if (!feasible.length) {
    return {
      status: "NO_FEASIBLE_CANDIDATE",
      blueprintId: null,
      reason: "No candidate satisfied every declared conformance-check, reliability, authority, and budget constraint in this experiment.",
      paretoFrontier: [],
    };
  }
  const frontier = feasible.filter(
    (candidate) => !feasible.some((other) => other !== candidate && dominates(other, candidate)),
  );
  frontier.sort(
    (left, right) =>
      left.complexity.score - right.complexity.score ||
      left.modelCallsMean - right.modelCallsMean ||
      left.tokenUnitsMean - right.tokenUnitsMean ||
      left.latencyTicksP95 - right.latencyTicksP95 ||
      left.blueprintId.localeCompare(right.blueprintId),
  );
  return {
    status: "RECOMMENDED",
    blueprintId: frontier[0].blueprintId,
    reason: "Smallest Pareto-feasible evaluated topology after hard conformance-check, reliability, authority, and budget gates.",
    paretoFrontier: frontier.map((item) => item.blueprintId),
  };
}

export async function runWindTunnel({
  blueprints,
  scenarios,
  adapter,
  policy,
  repetitions = 1,
  mode = adapter.kind,
  includeExpectedFixtureChecks = adapter.kind === "fixture",
  executionId,
  approvalProviderFactory,
  pricing = null,
  scenarioPack = null,
}) {
  if (
    pricing != null &&
    (!pricing.model ||
      !pricing.card ||
      !pricing.source ||
      typeof pricing.source.sha256 !== "string")
  ) {
    throw Object.assign(
      new Error("pricing must be a validated exact-model price-card selection."),
      { code: "INVALID_PRICING" },
    );
  }
  if (pricing) {
    validatePriceCard(pricing.card);
    const exactModel = pricing.card.models.find(
      (candidate) => candidate.id === pricing.model.id,
    );
    if (
      !exactModel ||
      canonicalHash(exactModel) !== canonicalHash(pricing.model) ||
      canonicalHash(pricing.card) !== pricing.source.sha256
    ) {
      throw Object.assign(
        new Error("pricing model or source hash does not match its price-card snapshot."),
        { code: "INVALID_PRICING" },
      );
    }
  }
  if (scenarioPack) {
    validateScenarioPack(
      scenarioPack.pack,
      blueprints.map((blueprint) => blueprint.id),
    );
    if (
      canonicalHash(scenarioPack.pack) !== scenarioPack.source.sha256 ||
      canonicalHash(scenarioPack.pack.scenarios) !== canonicalHash(scenarios)
    ) {
      throw Object.assign(
        new Error(
          "scenarioPack metadata, source hash, and evaluated scenarios must describe the same snapshot.",
        ),
        { code: "INVALID_SCENARIO_PACK_BINDING" },
      );
    }
  }
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 100) {
    throw Object.assign(
      new Error("repetitions must be an integer from 1 through 100."),
      { code: "INVALID_REPETITIONS" },
    );
  }
  const validations = blueprints.map((blueprint) => validateBlueprint(blueprint, policy));
  scenarios.forEach(validateScenario);
  const catalogFingerprint = canonicalHash({
    blueprints,
    scenarios: scenarios.map(publicScenario),
    policy,
  });
  const experimentFingerprint = canonicalHash({
    catalogFingerprint,
    mode,
    repetitions,
    fixtureConfiguration:
      adapter.kind === "fixture"
        ? scenarios.map((scenario) => ({
            id: scenario.id,
            fixture: scenario.fixture,
            oracle: scenario.oracle,
          }))
        : null,
    adapter:
      adapter.experimentConfiguration ?? {
        kind: adapter.kind,
        deterministic: adapter.deterministic === true,
      },
    pricing: pricing
      ? {
          card: pricing.source.sha256,
          model: pricing.model.id,
        }
      : null,
    scenarioPack: scenarioPack
      ? {
          id: scenarioPack.pack.id,
          source: scenarioPack.source.sha256,
          evaluationUse: scenarioPack.pack.claimBoundary.evaluationUse,
        }
      : null,
  });
  const runId =
    executionId ??
    (adapter.deterministic
      ? `${mode}-${experimentFingerprint.slice(0, 20)}`
      : `${mode}-${experimentFingerprint.slice(0, 12)}-${randomUUID()}`);
  const runs = [];
  const orderedScenarios = [...scenarios].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const orderedBlueprints = [...blueprints].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    for (
      let scenarioIndex = 0;
      scenarioIndex < orderedScenarios.length;
      scenarioIndex += 1
    ) {
      const scenario = orderedScenarios[scenarioIndex];
      const rotation =
        orderedBlueprints.length === 0
          ? 0
          : (repetition - 1 + scenarioIndex) % orderedBlueprints.length;
      const roundRobin = [
        ...orderedBlueprints.slice(rotation),
        ...orderedBlueprints.slice(0, rotation),
      ];
      for (const blueprint of roundRobin) {
        const run = await executeCandidate({
          runId,
          blueprint,
          scenario,
          adapter,
          policy,
          repetition,
          approvalProvider: approvalProviderFactory?.({
            runId,
            scenario,
            blueprint,
            repetition,
          }),
        });
        if (pricing) {
          run.efficiency.estimatedCost = estimateUsageCost(
            run.efficiency,
            pricing.model,
          );
        }
        if (
          adapter.deterministic !== true &&
          run.reliability.terminalError?.systemic === true
        ) {
          throw Object.assign(
            new Error(
              `Live experiment stopped after systemic API failure: ${run.reliability.terminalError.message}`,
            ),
            {
              code: run.reliability.terminalError.code,
              systemic: true,
              partialRunCount: runs.length,
            },
          );
        }
        runs.push(run);
      }
    }
  }

  const aggregates = [];
  for (const scenario of scenarios) {
    for (const blueprint of blueprints) {
      aggregates.push(
        aggregateCandidate(
          runs.filter(
            (run) => run.scenarioId === scenario.id && run.blueprintId === blueprint.id,
          ),
        ),
      );
    }
  }
  const recommendations = scenarios.map((scenario) => {
    const recommendation = selectSmallestCandidate(
      aggregates.filter((item) => item.scenarioId === scenario.id),
    );
    return {
      scenarioId: scenario.id,
      ...recommendation,
      expectedFixtureWinner: includeExpectedFixtureChecks ? scenario.oracle.expectedWinner : null,
      expectedMatch: includeExpectedFixtureChecks
        ? recommendation.blueprintId === scenario.oracle.expectedWinner
        : null,
    };
  });

  const candidateIds = uniqueSorted(blueprints.map((item) => item.id));
  const portfolioCandidates = candidateIds.map((blueprintId) => {
    const cases = aggregates.filter((item) => item.blueprintId === blueprintId);
    return {
      blueprintId,
      feasible: cases.every((item) => item.feasible),
      acceptanceRateBps: Math.min(...cases.map((item) => item.acceptanceRateBps)),
      authorityViolations: cases.reduce((sum, item) => sum + item.authorityViolations, 0),
      contractErrors: cases.reduce((sum, item) => sum + item.contractErrors, 0),
      modelCallsMean: mean(cases.map((item) => item.modelCallsMean)),
      tokenUnitsMean: mean(cases.map((item) => item.tokenUnitsMean)),
      estimatedCostMean:
        cases.every((item) => item.estimatedCostMean != null)
          ? mean(cases.map((item) => item.estimatedCostMean))
          : null,
      latencyTicksP95: Math.max(...cases.map((item) => item.latencyTicksP95)),
      complexity: cases[0].complexity,
    };
  });
  const portfolioRecommendation = selectSmallestCandidate(portfolioCandidates);

  return {
    schemaVersion: "agent-wind-tunnel.results/v1",
    runId,
    generatedAt: adapter.deterministic ? "1970-01-01T00:00:00.000Z" : new Date().toISOString(),
    provenance: {
      harnessVersion: "1.0.0",
      mode,
      adapter: adapter.kind,
      deterministic: adapter.deterministic === true,
      repetitions,
      claim:
        adapter.deterministic === true
          ? "Synthetic fixtures demonstrate harness behavior; they do not predict live-model quality."
          : "Live empirical sample; model outputs are nondeterministic and are not pooled with fixtures.",
      catalogFingerprint,
      experimentFingerprint,
      executionId: runId,
      accounting:
        "Model-call and logical-visit budgets are reserved before dispatch; token and latency limits are enforced immediately after observed usage.",
      semanticGrader: "none",
      evaluationBoundary:
        "Weighted coverage measures declared deterministic conformance checks. It is not adversarially robust semantic grading; production studies need independent human, model, or executable domain graders.",
      pricing: pricing
        ? {
            schemaVersion: pricing.card.schemaVersion,
            currency: pricing.card.currency,
            effectiveDate: pricing.card.effectiveDate,
            model: pricing.model.id,
            rateProvenance: pricing.card.provenance,
            source: pricing.source,
          }
        : null,
      scenarioPack: scenarioPack
        ? {
            id: scenarioPack.pack.id,
            provenance: scenarioPack.pack.provenance,
            claimBoundary: scenarioPack.pack.claimBoundary,
            source: scenarioPack.source,
          }
        : null,
    },
    validations,
    blueprintIR: blueprints,
    policySnapshot: policy,
    pricingSnapshot: pricing?.card ?? null,
    scenarioPackSnapshot: scenarioPack?.pack ?? null,
    fixtureDefinitions:
      adapter.kind === "fixture"
        ? scenarios.map((scenario) => ({
            scenarioId: scenario.id,
            fixture: scenario.fixture,
            oracle: scenario.oracle,
            demonstration: scenario.demonstration,
          }))
        : null,
    blueprints: blueprints.map((blueprint) => ({
      id: blueprint.id,
      label: blueprint.label,
      source: blueprint.source,
      budgets: blueprint.budgets,
      features: blueprint.features,
      complexity: blueprintComplexity(blueprint),
    })),
    scenarios: scenarios.map((scenario) => ({
      ...publicScenario(scenario),
      expectedFixtureWinner: includeExpectedFixtureChecks ? scenario.oracle.expectedWinner : null,
    })),
    runs,
    aggregates,
    recommendations,
    portfolioRecommendation,
    fixtureExpectationsPassed: includeExpectedFixtureChecks
      ? recommendations.every((item) => item.expectedMatch)
      : null,
  };
}
