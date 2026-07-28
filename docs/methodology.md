---
layout: default
title: Agent Wind Tunnel — Methodology
description: Experimental design, metrics, selection logic, reproducibility, and validity limits.
---

# Methodology

## Decision question

Agent Wind Tunnel asks:

> Among the topologies included in this study, which is the least complex
> candidate that satisfies the declared task, contract, reliability, budget,
> and authority requirements?

It does not ask which architecture is universally best. A recommendation is
conditional on the selected scenarios, candidates, model and adapter,
contracts, graders, SLOs, policy, repetitions, and complexity definition.

## Experimental unit

The basic cell is:

```text
scenario × topology × repetition
```

Each cell produces a run status, artifact, requirement checks, contract and
reliability state, authority events, usage, exact execution ledger, and role
trace. Aggregation occurs only across repetitions of the same scenario,
topology, and evidence mode.

Fixture and live modes are separate experiments. Their results are never
combined.

## Compared candidates

The canonical study includes:

1. `direct`;
2. `loop`;
3. `parallel-review`;
4. `graph-max-governed`.

The Graph Max ablation study is a second-stage analysis. It runs only after
canonical comparison and includes seven checked-in variants. It answers which
components are load-bearing within that family and corpus; it does not add new
canonical families to the first-stage comparison.

## Synthetic composite calibration suite

The four built-in scenarios are synthetic, composite cases created to exercise
the harness:

- a simple deterministic transform;
- an operator-safety documentation gap;
- a cross-domain release review;
- a consequential production-deployment simulation.

Private fixture metadata injects declared defect patterns and expected
outcomes. The ladder in which direct, loop, parallel review, and governed graph
are selected in order is intentionally calibrated. It is a regression target
for the harness—not independent evidence that real models naturally fail in
that sequence.

Fixture mode uses one deterministic repetition per scenario × topology cell.
Repeating it would test replay, not estimate stochastic uncertainty.

## Controls

A defensible topology comparison holds constant:

- public scenario and required evidence;
- model and model snapshot;
- reasoning effort;
- tools and capability envelope;
- prompt and role contracts, except where the topology necessarily assigns
  different roles;
- retry, call, token, latency, and visit budgets;
- graders and acceptance thresholds;
- data access and approval policy;
- provider region/service tier and caching policy when relevant.

The current harness fixes these controls within each configured run. A
production study must document any unavoidable differences because they can
confound the topology effect.

## Pre-execution validity

Candidates must first pass schema, topology, contract, runtime-binding, budget,
and authority validation. A structurally invalid or authority-violating graph
is not an observed low-quality run; it is an inadmissible candidate.

This distinction matters. The study does not trade a security violation for
better quality or lower latency.

## Outcome and gate definitions

### Weighted requirement coverage

For one run:

```text
sum(weight of passed requirements)
──────────────────────────────────
sum(weight of all requirements)
```

The result is stored in basis points. Mandatory requirements are also checked
independently, so a high weighted score cannot compensate for a missing
mandatory item.

In fixture mode these are declared deterministic checks. Section heuristics can
reject obvious placeholders, but they do not establish semantic correctness.

### Contract and reliability gates

A feasible result must remain contract-compliant, terminate within the
declared graph and resource bounds, and satisfy the scenario’s accepted
statuses. Malformed envelopes, unsupported references, timeouts, exhausted
budgets, unresolved repairs, and systemic API failures remain visible
outcomes.

### Authority gate

Unknown or out-of-envelope capabilities are rejected or escalated. If a
scenario requires a consequential action, a candidate must provide the
declared approval-dominated route and complete only the built-in simulation.
The maximum accepted authority-violation count is a hard condition.

### Resource measures

Fixture mode reports:

- simulated role calls;
- synthetic cost units;
- virtual latency ticks;
- logical node visits and edge traversals.

These are stable calibration quantities. They are not provider tokens,
wall-clock latency, or dollar cost.

Live mode records returned input, output, and total token usage where
available; response/request identifiers; observed latency; attempts; retries;
and model IDs. When a validated exact-model Price Card is supplied, the CLI
calculates a conservative pre-run spend envelope from declared token budgets
and the runner retains realized estimates from recorded usage. The card must
version its currency, effective date, service/context assumptions, exclusions,
and source provenance. These values are estimates rather than provider
invoices and must be recomputed when pricing or routing changes.

## Feasibility-first selection

The selector follows this order:

1. Exclude candidates that fail a hard gate.
2. Among feasible candidates, identify those not dominated across the declared
   performance/resource dimensions.
3. Select the least structurally complex candidate on the remaining frontier.
4. Report the evaluated set so a subset study cannot imply comparison against
   omitted candidates.

Structural complexity uses visible graph characteristics such as nodes, edges,
cycles, fan-out, persistent roles, and approvals. It is a transparent
engineering tie-breaker, not a universal economic utility function. A serious
study should show raw dimensions and test whether the recommendation changes
under plausible alternative weights.

## Three recommendation scopes

### Per-scenario routing

Choose the smallest canonical topology that satisfies one scenario. In the
fixture calibration, the four cases intentionally earn the four families in
order.

### Universal canonical topology

If one fixed canonical topology must cover every selected scenario, choose the
smallest candidate that passes the whole corpus. In the fixture calibration
that is `graph-max-governed`.

### Within-family ablation

Once the governed family is selected, remove one or more declared components
and re-run the corpus. In the current fixture calibration:

- removing the presenter remains fixture-feasible;
- removing model synthesis remains fixture-feasible;
- removing speculative execution remains fixture-feasible;
- removing plan review fails the consequential case;
- removing security review fails named cross-domain and consequential cases;
- the checked-in `graph-lean` combination remains fixture-feasible.

These are causal statements only inside the constructed fixture behavior. A
component that is removable here may be necessary for another task
distribution or live model.

## Reproducibility

Fixture timestamps, IDs, ordering, virtual usage, source hashes, and JSON key
order are stable. Two fixture runs are expected to produce byte-identical
artifacts.

```bash
npm ci
npm test
node agent-wind-tunnel.mjs demo
npm run verify:fixture
```

The verifier checks the package membership declared by `manifest.json`, file
sizes, and SHA-256 hashes. This supports tamper detection and reproduction of
the checked-in calibration; it does not certify the truth of the scenario
assumptions.

## Published bounded live pilot

The repository includes one curated live evidence projection from a completed
direct-versus-loop pilot. Its predeclared study cell was:

```text
operator-doc-gap synthetic scenario
× {direct, loop}
× 3 repetitions
× one OpenAI model/configuration
```

All six nondeterministic runs were accepted under the declared deterministic
structural/lexical rubric. Both candidates received the same rubric score, so
the feasibility-first selector recommended `direct`, the less complex
candidate. The sample recorded nine model calls, 12,019 tokens, zero retries,
and a USD 0.08756 estimate from the versioned local Price Card.

This result does not establish independent semantic correctness: the study
used `semanticGrader: none`, and declared test-case strings were counted but
not executed. It is not a representative benchmark, production result,
savings or ROI study, or evidence about `parallel-review` or Graph Max. The
cost is an estimate, not a provider invoice. Review the exact configuration,
per-run observations, provenance commitments, and claim boundary in the
[curated live evidence](../evidence/live-pilot-2026-07-28.json).

## Live-study protocol

A decision-grade empirical study should:

1. define representative task classes with product, operations, and risk
   stakeholders;
2. reserve held-out cases before tuning prompts, topologies, or graders;
3. keep the primary model, effort, tools, evidence, and policy fixed across
   candidate cells;
4. run at least three, and preferably five or more, repetitions per cell;
5. use executable domain checks wherever possible;
6. calibrate model graders against blinded human labels and report agreement;
7. retain failures and refusals rather than silently retrying them away;
8. report distributions, confidence intervals, and per-task paired
   differences—not only means;
9. document the stopping rule and multiple-comparison strategy before reading
   the results;
10. perform ablations only after selecting a viable family;
11. re-run when the model, prompt, tools, task distribution, policy, or price
   changes.

Sample size should be justified by the expected effect, variance, and decision
risk. A single successful live smoke run confirms adapter plumbing, not an
architecture advantage.

## Independent grading

The repository does not bundle an independent semantic grader. For production
use, combine:

1. deterministic executable checks;
2. domain-specific rule checks;
3. blinded human review on a calibrated sample;
4. one or more model graders whose agreement and failure modes are measured;
5. operational outcomes observed in a safe environment.

The model that generates an answer should not be treated as the sole judge of
its own success.

## Validity threats

| Threat | Consequence | Mitigation |
| --- | --- | --- |
| Designed fixture ladder | Expected winner can be encoded by construction | Label it calibration; use held-out real tasks for empirical claims |
| Same author creates tasks, checks, and runtime | Circularity and confirmation bias | Independent task ownership, blinded labels, external reproduction |
| Prompt or role differences | Topology effect becomes confounded | Freeze shared materials; document necessary role-specific differences |
| Small or convenient corpus | Recommendation may not generalize | Sample representative task classes and publish inclusion criteria |
| Stochastic model output | One run can be lucky | Repetitions, paired analysis, uncertainty, retained failure traces |
| Grader bias or leakage | Quality score can reward superficial compliance | Human calibration, executable checks, held-out data, adversarial cases |
| Subjective complexity weights | “Smallest” can change with the score | Publish raw dimensions and sensitivity analysis |
| Synthetic cost units | Apparent efficiency can be mistaken for money | Keep fixture/live terminology separate; use provider usage in live mode |
| Model or provider drift | Recommendation becomes stale | Record IDs/configuration and schedule re-evaluation |
| Simulated authority | A passing run can be mistaken for production safety | Integrate real IAM/sandbox/approval controls before deployment |

## Interpretation rule

The strongest warranted fixture statement is:

> Within the checked-in deterministic synthetic calibration, the harness
> selected the expected smallest feasible candidate, enforced its declared
> topology and authority invariants, exposed load-bearing ablations, and
> produced a reproducible evidence package.

For the published live pilot, the strongest warranted statement is:

> Within one synthetic scenario and one fixed model/configuration, all three
> `direct` and all three `loop` runs passed the declared local conformance
> gates. Because measured rubric quality tied, the selector recommended the
> less complex `direct` candidate for this sample.

Stronger claims about semantic quality, generalization, cost reduction,
production safety, novelty, or universal topology superiority require
separate evidence.
