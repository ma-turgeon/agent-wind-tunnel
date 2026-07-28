---
layout: default
title: Agent Wind Tunnel
description: Evidence-driven selection of bounded agent architectures.
---

# Agent Wind Tunnel

Agent Wind Tunnel is an offline-first engineering laboratory for one decision:

> Which of the evaluated agent topologies is the simplest one that meets the
> declared quality, reliability, budget, and authority requirements?

Teams can add planners, reviewers, repair loops, and approval gates faster than
they can prove those components are useful. Agent Wind Tunnel treats topology
as an experimental variable. It compares bounded candidates under the same
scenario contract, rejects candidates that miss a hard gate, and then prefers
the least complex feasible design.

[View the source repository](../) ·
[Read the solution case study](case-study.md) ·
[Run the ten-minute walkthrough](walkthrough.md) ·
[Résumé exécutif en français](executive-summary-fr.md)

![Selection pipeline from scenario and policy to evidence package](assets/selection-pipeline.svg)

## The result, stated precisely

The checked-in deterministic calibration suite is intentionally constructed to
exercise four levels of orchestration:

| Synthetic composite scenario | Smallest canonical topology that passes its declared fixture gates |
| --- | --- |
| Simple deterministic transform | `direct` |
| Operator runbook gap | `loop` |
| Cross-domain release review | `parallel-review` |
| Consequential deployment simulation | `graph-max-governed` |

This result proves that the harness can distinguish the designed cases,
enforce its declared invariants, and reproduce its evidence package. It does
**not** prove that these outcomes generalize to real users, tasks, models, or
production systems. Fixture results and live-model results are kept separate.

## Bounded live pilot

One separately labeled live pilot compared `direct` and `loop` on one
synthetic scenario with one OpenAI model/configuration and three repetitions
per candidate. All six runs passed the local structural/lexical rubric; with
rubric quality tied, the selector recommended the less complex `direct`
candidate. The six-run sample recorded nine calls, 12,019 tokens, zero
retries, and a USD 0.08756 local Price Card estimate.

This is not an independently graded semantic result, representative benchmark,
Graph Max comparison, production finding, savings claim, or ROI evidence. The
cost is an estimate, not an invoice.

[Inspect the curated evidence](../evidence/live-pilot-2026-07-28.json) ·
[Read the visual pilot summary](https://ma-turgeon.github.io/agent-wind-tunnel/live-pilot.html)

## What a reviewer can verify

- Four canonical topology families are represented as a closed Blueprint IR.
- Every accepted node and edge is named and bounded.
- Static validation rejects unsupported routes, contracts, capabilities, and
  authority paths.
- Runtime accounting records every logical node visit and selected edge.
- Consequential authority requires a dominating approval node in the declared
  graph; the included effect remains a data-only simulation.
- Deterministic fixture runs produce byte-stable artifacts whose membership,
  size, and SHA-256 hashes can be verified.
- A live OpenAI adapter uses the same topology contracts, but live outputs are
  labeled nondeterministic empirical samples and are not pooled with fixtures.
- Graph-family ablations identify components that are removable or
  load-bearing **within the synthetic calibration corpus**.

## Quick verification

Requirements: Node.js 22 or later.

```bash
cd agent-wind-tunnel
npm ci
npm test
node agent-wind-tunnel.mjs inspect
node agent-wind-tunnel.mjs demo
npm run verify:fixture
```

No model account or API key is needed for those commands. The generated visual
report is written to:

```text
wind-tunnel-output/fixture/report.html
```

For a zero-call preview of a live experiment:

```bash
node agent-wind-tunnel.mjs run \
  --adapter openai \
  --dry-run \
  --scenario operator-doc-gap \
  --candidates direct,loop \
  --repetitions 3
```

The preview prints a conservative call envelope and does not read a key or make
an API request.

## Documentation

| Document | Question it answers |
| --- | --- |
| [Product brief](product-brief.md) | What problem does this solve, for whom, and at what maturity? |
| [Architecture](architecture.md) | What are the components, data flows, and enforced invariants? |
| [Methodology](methodology.md) | How are candidates compared and what can the results support? |
| [Threat model](threat-model.md) | What is trusted, what can fail, and what remains out of scope? |
| [Alternatives](alternatives.md) | When should a team use a prompt, an eval platform, a workflow framework, or this lab? |
| [Solution case study](case-study.md) | Which technical and business decisions does the implementation support? |
| [Walkthrough](walkthrough.md) | How can a reviewer reproduce and inspect the project? |
| [Résumé exécutif](executive-summary-fr.md) | Quel est le problème, la valeur et la limite de la démonstration? |

The enterprise pack lives under
`scenarios/enterprise-portfolio/`: nine fictional dossiers, six calibration
cases, and three separately stored but still synthetic composite cases. An
optional blinded-review kit and blank review sheet are included; no completed
human reviews, calibrated labels, or reviewer-agreement result are claimed.

## Maturity and claim boundary

Agent Wind Tunnel is an experimental reference implementation and evaluation
harness. It is not a production authorization system, formal verification
engine, general graph interpreter, or benchmark establishing that one topology
is universally superior.

The strongest current evidence concerns implementation behavior:
deterministic replay, structural validation, bounded execution, failure
handling, authority-envelope enforcement, ablation behavior, and artifact
integrity. The bounded live pilot adds a small, configuration-specific
empirical sample; it does not replace representative held-out tasks,
independent graders calibrated against human labels, organization-specific
policies, or real operational measurements required for a production
decision.
