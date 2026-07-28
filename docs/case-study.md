---
layout: default
title: Agent Wind Tunnel — Solution case study
description: Technical and business decisions in a constrained agent-architecture evaluation harness.
---

# Solution case study: make every agent node earn its place

## Decision

Agent Wind Tunnel addresses a recurring architecture question:

> Among the evaluated agent topologies, which is the least complex design that
> meets every declared quality, reliability, budget, and authority gate?

The harness rejects candidates that miss a hard gate. It then Pareto-prunes the
feasible set and uses structural complexity as a tie-breaker. More
orchestration wins only when a simpler evaluated option fails a declared
requirement.

![Four declared candidate families from direct to governed](assets/topology-ladder.svg)

## Why the decision is difficult

Planning, review, repair, synthesis, and approval stages can improve a workflow,
but each one also adds model calls, latency, state, failure modes, maintenance,
and permission surface. A visually impressive graph does not establish that
its extra nodes are necessary.

The comparison therefore holds the scenario contract and policy constant while
treating topology as the experimental variable.

## Evaluated alternatives

| Candidate | Mechanism under test |
| --- | --- |
| `direct` | Worker plus deterministic verification |
| `loop` | One bounded evaluator and repair cycle |
| `parallel-review` | Independent specialist reviews with bounded repair |
| `graph-max-governed` | Planning, review, synthesis or repair, and a broker-owned approval/effect boundary |

These are four closed, canonical families. The project is not an arbitrary
graph interpreter or a runtime that can invent roles, routes, or permissions.

## Control design

The implementation makes the comparison inspectable:

- strict schemas reject unknown graph, contract, policy, and study fields;
- static validation rejects unsupported routes, unbounded cycles, invalid
  capability requests, and approval-bypass paths;
- the runner records the exact logical node and edge route independently from
  model-call metadata;
- visits, traversals, retries, calls, and spend are bounded;
- parallel work reserves shared budgets before dispatch;
- immutable initial grants constrain every model node;
- approval is bound to the run, scenario, accepted artifact, capability, scope,
  and simulated effect;
- the only consequential executor is a one-time data simulator;
- fixture and live-model evidence remain separate.

![Authority remains outside the model-controlled graph](assets/authority-boundary.svg)

## Deterministic calibration

The checked-in cases are fictional synthetic composites deliberately calibrated
to exercise the harness:

| Calibration case | Smallest canonical candidate that passes |
| --- | --- |
| Simple deterministic transform | `direct` |
| Operator-safety documentation gap | `loop` |
| Cross-domain release review | `parallel-review` |
| Consequential deployment simulation | `graph-max-governed` |

Across the four cases, `graph-max-governed` is the smallest canonical family
that passes the whole corpus. A second-stage ablation then identifies
`graph-lean` as the least complex fixture-feasible variant within that family.
The result demonstrates calibrated harness behavior, not universal topology
superiority.

## Enterprise portfolio-management scenarios

The `scenarios/enterprise-portfolio/` pack applies the same decision model to
nine fictional initiative dossiers informed by public governance frameworks.
Six cases form a disclosed calibration set and three are stored separately.
They cover portfolio intake, capacity, benefits evidence, dependencies,
data-sharing risk, high-impact approval routing, procurement, service desk, and
eligibility decision support.

The separated cases remain synthetic composites. The repository contains a
blank review sheet but no completed human reviews, calibrated labels, or
reviewer-agreement result.

## Bounded live pilot

A separately published pilot compared `direct` and `loop` on one synthetic
scenario using one OpenAI model/configuration and three repetitions per
candidate. All six runs passed the declared structural and lexical checks. With
quality tied under that rubric, `direct` was selected because it was less
complex.

The six runs recorded:

- 9 model calls;
- 12,019 tokens;
- zero retries;
- zero authority violations;
- zero contract failures; and
- a USD 0.08756 estimate from the checked-in Price Card.

The pilot had no independent semantic grader, did not execute the generated
test-case strings, and did not include a live Graph Max candidate. It is not a
benchmark, generalization, production outcome, savings study, ROI claim, or
provider invoice.

[Inspect the machine-readable pilot evidence](../evidence/live-pilot-2026-07-28.json).

## Decision value

The solution gives engineering, product, operations, finance, and risk teams a
shared sequence:

1. declare mandatory outcomes and constraints;
2. compare a small set of bounded alternatives;
3. reject contract, reliability, authority, and budget failures;
4. select the least complex feasible evaluated design;
5. remove components experimentally to identify load-bearing mechanisms; and
6. retain the configuration, route evidence, measurements, and claim boundary.

This replaces architecture-by-diagram with a falsifiable, reviewable decision.

## What remains to prove

The current evidence does not establish production readiness or representative
semantic quality. A decision-grade next phase would:

1. reserve representative held-out tasks;
2. freeze model, prompt, tools, evidence, policy, and graders;
3. run paired repetitions;
4. calibrate graders against blinded human labels;
5. report failures, uncertainty, real usage, and recommendation sensitivity;
6. invite independent reproduction; and
7. integrate the selected design with real IAM, sandboxing, authenticated
   approval, idempotency, audit retention, and incident controls.

## Reproduce the evidence

```bash
npm ci
npm test
node agent-wind-tunnel.mjs demo
npm run verify:fixture
npm run verify:evidence
```

[Read the architecture](architecture.md) ·
[Review the methodology](methodology.md) ·
[Inspect the threat model](threat-model.md) ·
[Run the walkthrough](walkthrough.md)
