---
layout: default
title: Agent Wind Tunnel — Limitations
description: A concise boundary for interpreting the current evidence.
---

# Limitations

This page is intentionally direct. It defines what the repository does not
establish.

## Evidence limitations

- The built-in scenarios are synthetic composites designed to exercise the
  four topology families.
- Fixture mode uses deterministic behavior and one repetition per
  scenario × topology cell; it does not measure stochastic variance.
- The expected fixture ladder is calibration by construction, not an
  independently discovered model result.
- The project author controls the built-in tasks, checks, expected outcomes,
  implementation, and documentation.
- No independent semantic grader is bundled.
- The section/content heuristics detect declared material and obvious
  placeholders; they do not prove meaning or factual correctness.
- One bounded live pilot is published: one synthetic scenario, one
  OpenAI model/configuration, `direct` versus `loop`, and three repetitions
  per candidate. All six runs passed the declared local rubric and `direct`
  was selected, but the rubric is deterministic structural/lexical
  conformance with `semanticGrader: none`.
- That pilot is a small empirical sample, not an independent semantic
  evaluation, representative benchmark, or general architecture result. It
  did not evaluate `parallel-review`, Graph Max, real users, or production
  work. See the
  [curated evidence](../evidence/live-pilot-2026-07-28.json).
- No production adoption, incident, load, revenue, savings, or ROI evidence is
  included.

## Architecture limitations

- The compiler accepts four canonical topology families and checked-in Graph
  Max ablations, not arbitrary graph programs.
- Closed node kinds, roles, contracts, and predicates limit extensibility by
  design.
- The Graph Max source derivation is a bounded pattern scan of one source file,
  not a general JavaScript parser or compiler.
- Structural complexity uses authored weights. “Smallest” is conditional on
  that definition after hard gates pass.
- One live provider adapter is included.
- The runtime is an experiment harness, not a high-throughput serving system.

## Security limitations

- The authority broker is a local policy-envelope demonstration, not IAM.
- The approval provider used by fixtures is not authenticated human approval.
- Live consequential work fails closed because no production approval
  connector is included.
- The effect executor performs a data-only simulation and never deploys.
- There is no code, browser, network, tool, or operating-system sandbox.
- There is no multi-tenant authentication, authorization, or isolation.
- Graph dominance checks structure, not approver identity or decision quality.
- The evidence manifest is hashed but not signed or externally attested.

## Cost limitations

- Fixture cost units and latency ticks are synthetic calibration quantities.
- A live Price Card is supplied by the operator and accepted only with declared
  provenance and an exact model match.
- The conservative spend envelope prices declared token budgets; it is not a
  promise about provider billing.
- Realized estimates use recorded usage and the supplied rates; they are not
  invoices and can omit provider-specific adjustments not represented by the
  card.
- The published pilot's USD 0.08756 value is a local estimate for its six-run
  sample, not a provider invoice or evidence of cost savings.
- Price changes require a new versioned card and a new study.

## Generalization limitations

A recommendation changes when any material input changes:

- task distribution;
- model or model snapshot;
- prompt, effort, tools, or evidence;
- role contract or retry behavior;
- grader or acceptance threshold;
- policy, scopes, or approval rule;
- budget or price;
- candidate set;
- complexity definition.

The phrase “recommended topology” always means “recommended among the
evaluated candidates under the declared study inputs.”

## What would strengthen the evidence

1. Representative held-out tasks owned independently from the implementation.
2. Predeclared hypotheses and stopping rules.
3. Multiple paired repetitions per cell.
4. Executable domain checks and blinded human labels.
5. Model graders calibrated against those labels.
6. Confidence intervals, failure distributions, and sensitivity analysis.
7. Independent reproduction.
8. Real IAM, sandbox, approval, and audit integration for a safe pilot.
9. Operational and business outcomes measured over time.

The bounded pilot adds a useful end-to-end empirical check, but it does not
remove these limitations. Use Agent Wind Tunnel as a reference implementation,
calibration/regression harness, and architecture-discussion tool.
