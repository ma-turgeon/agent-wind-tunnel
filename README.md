# Agent Wind Tunnel

[![CI](https://github.com/ma-turgeon/agent-wind-tunnel/actions/workflows/ci.yml/badge.svg)](https://github.com/ma-turgeon/agent-wind-tunnel/actions/workflows/ci.yml)
[![CodeQL](https://github.com/ma-turgeon/agent-wind-tunnel/actions/workflows/codeql.yml/badge.svg)](https://github.com/ma-turgeon/agent-wind-tunnel/actions/workflows/codeql.yml)
[![Pages](https://github.com/ma-turgeon/agent-wind-tunnel/actions/workflows/pages.yml/badge.svg)](https://github.com/ma-turgeon/agent-wind-tunnel/actions/workflows/pages.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Agent Wind Tunnel compares bounded agent architectures under the same declared
task, reliability, budget, and authority constraints. Candidates that miss a
hard gate are rejected; among those that pass, the least complex evaluated
design wins.

> Every agent node must earn its cost and authority.

[Project site](https://ma-turgeon.github.io/agent-wind-tunnel/) ·
[Solution case study](docs/case-study.md) ·
[Ten-minute walkthrough](docs/walkthrough.md) ·
[Résumé exécutif en français](docs/executive-summary-fr.md)

![Scenario and policy move through validation, bounded execution, hard gates, and minimum-feasible selection](docs/assets/selection-pipeline.svg)

## The decision it supports

Teams can add planners, critics, repair loops, specialist reviewers, and
approval stages faster than they can prove those components help. Each added
component also adds calls, latency, state, failure modes, maintenance, and
permission surface.

Agent Wind Tunnel treats topology as an experimental variable:

```text
     Scenario + SLO + Trusted Policy + Blueprint
                       │
                       ▼
     Static Graph/Contract/Authority Validation
                       │
                       ▼
      Exact Bounded Node/Edge Execution Ledger
                       │
                       ▼
 Conformance → Reliability → Authority → Budget Gates
                       │
                       ▼
     Pareto Pruning → Least Complex Feasible Option
                       │
                       ▼
       Reproducible Machine and Reader Evidence
```

**The project includes four canonical families**:

| Candidate | Intended mechanism |
| --- | --- |
| `direct` | Worker plus deterministic verification |
| `loop` | One bounded evaluator/repair cycle |
| `parallel-review` | Independent specialist review branches and a bounded repair path |
| `graph-max-governed` | Planning, plan review, specialist review, synthesis/repair, and an approval/effect boundary |

This is a closed-world compiler for those families and checked-in Graph Max
ablations. It is not an arbitrary graph interpreter.

## What the deterministic demonstration shows

The built-in cases are **synthetic composites deliberately calibrated to
exercise the harness**:

| Calibration case | Smallest canonical candidate that passes its declared fixture gates |
| --- | --- |
| Simple deterministic transform | `direct` |
| Operator-safety documentation gap | `loop` |
| Cross-domain release review | `parallel-review` |
| Consequential deployment simulation | `graph-max-governed` |

Across all four built-in cases, the smallest one canonical candidate that
passes is `graph-max-governed`. A second-stage ablation then identifies
`graph-lean` as the least complex fixture-feasible variant within that family.

Those are calibration results, not claims about live-model quality, production
readiness, organizational outcomes, or universal architecture superiority.

## Enterprise portfolio scenario pack

The repository also includes nine fictional, public-framework-informed composite
initiative dossiers:

```text
scenarios/enterprise-portfolio/dossiers.json
```

Six cases form a disclosed calibration pack:

```text
scenarios/enterprise-portfolio/calibration.json
```

Its deterministic recommendations are:

| Composite calibration case | Recommended candidate |
| --- | --- |
| Portfolio intake completeness | `direct` |
| Capacity-feasible portfolio ranking | `loop` |
| Cross-department data-sharing risk triage | `parallel-review` |
| High-impact citizen-service approval routing | `graph-max-governed` |
| Benefits evidence-gap resolution | `loop` |
| Cross-functional dependency review | `parallel-review` |

Three additional fictional composite cases are isolated from calibration:

```text
scenarios/enterprise-portfolio/held-out.json
```

They recommend `parallel-review` for procurement copilot selection, `loop` for
the service-desk assistant pilot, and `graph-max-governed` for eligibility
decision support. Both packs select `graph-max-governed` as the smallest
universal canonical candidate across their respective cases.

The held-out file is useful for a bounded demonstration, but it is still
synthetic composite evidence. It was not collected from production and is not
external, human-labelled, or statistically representative validation. Both
packs carry machine-validated provenance and claim-boundary fields.

An optional blinded-review kit is provided at
[`scenarios/enterprise-portfolio/review-kit.md`](scenarios/enterprise-portfolio/review-kit.md)
with a blank
[`review-sheet.csv`](scenarios/enterprise-portfolio/review-sheet.csv).
The repository contains no completed review sheets, calibrated human labels,
or measured reviewer agreement.

## Quick verification

Requirements: Node.js 22 or later. The test matrix covers Node 22 and 24.

```bash
git clone https://github.com/ma-turgeon/agent-wind-tunnel.git
cd agent-wind-tunnel
npm ci
npm test
node agent-wind-tunnel.mjs inspect
node agent-wind-tunnel.mjs demo
npm run verify:fixture
```

No API key or model account is required. The deterministic demo normally
completes locally in well under a minute and writes:

```text
wind-tunnel-output/fixture/report.html
```

For coverage thresholds plus packaging and artifact checks:

```bash
npm run check
```

GitHub CI runs the core suite on Node 22 and 24, then independently regenerates
and enforces both the enterprise calibration baseline and the separated
held-out baseline.

## Validate and run a Scenario Pack

Validation is offline:

```bash
node agent-wind-tunnel.mjs validate \
  --scenario-pack scenarios/enterprise-portfolio/calibration.json

node agent-wind-tunnel.mjs validate \
  --scenario-pack scenarios/enterprise-portfolio/held-out.json
```

Run the deterministic enterprise calibration:

```bash
node agent-wind-tunnel.mjs demo \
  --scenario-pack scenarios/enterprise-portfolio/calibration.json \
  --output wind-tunnel-output/enterprise-portfolio-calibration
```

Run the separated fictional composite cases:

```bash
node agent-wind-tunnel.mjs demo \
  --scenario-pack scenarios/enterprise-portfolio/held-out.json \
  --output wind-tunnel-output/enterprise-portfolio-held-out
```

A portable pack must declare whether it is calibration or held-out, whether it
is synthetic/composite, and a plain-language claim boundary. The runtime
validates and retains that evidence metadata.

## Preview live work without spending

This dry run reads no key and makes zero API calls:

```bash
node agent-wind-tunnel.mjs run \
  --adapter openai \
  --dry-run \
  --scenario operator-doc-gap \
  --candidates direct,loop \
  --repetitions 3
```

It prints a conservative call envelope. Add a versioned exact-model Price Card
to preview a conservative spend envelope:

```bash
node agent-wind-tunnel.mjs run \
  --adapter openai \
  --dry-run \
  --scenario operator-doc-gap \
  --candidates direct,loop \
  --repetitions 3 \
  --price-card price-cards/openai-standard-short-context-2026-07-28.json
```

Confirmed live execution additionally requires:

- `--confirm-live`;
- an exact-model `--price-card`;
- an explicit `--max-live-spend-usd`;
- a plan within both `--max-live-calls` and the spend cap;
- an `OPENAI_API_KEY` resolved from the process environment or an explicit key
  file.

The CLI checks the call and spend envelopes before reading a credential.
Versioned price-card snapshots and realized usage estimates are retained in
artifacts. Estimates are planning evidence, not provider invoices.

Live mode uses the official OpenAI SDK and Responses API. It uses structured
role outputs, `store: false`, bounded application-owned retries, and no silent
fixture fallback. Live runs are nondeterministic empirical samples and are
never pooled with fixture results.

The consequential live scenario has no human-approval connector and therefore
fails closed at that boundary.

## Bounded live pilot

On 2026-07-28, a pre-authorized pilot compared `direct` and `loop` on the
synthetic `operator-doc-gap` scenario using `gpt-5.6-terra` at medium reasoning
effort. Each candidate ran three times.

| Candidate | Accepted | Quality under the declared rubric | Mean calls | Mean token units | Mean price-card estimate |
| --- | ---: | ---: | ---: | ---: | ---: |
| `direct` | 3/3 | 10,000 bps | 1 | 1,393 | US$0.0125575 |
| `loop` | 3/3 | 10,000 bps | 2 | 2,613.333 | US$0.01662917 |

Across all six runs, the harness recorded 9 model calls, 12,019 tokens, zero
retries, zero authority violations, zero contract failures, and an estimated
US$0.08756 under the checked-in price card. Because both candidates passed and
tied on the local rubric, the harness recommended `direct` as the least complex
evaluated feasible option.

This is one nondeterministic sample, not a benchmark. The rubric uses declared
structural and lexical checks; no independent semantic grader was configured.
Latency summaries from three observations per candidate are not stable
performance estimates, and cost is not a provider invoice.

[Read the live-pilot page](https://ma-turgeon.github.io/agent-wind-tunnel/live-pilot.html) ·
[Inspect the machine-readable evidence](evidence/live-pilot-2026-07-28.json) ·
[Review the evidence publication boundary](evidence/README.md)

## What a reviewer can verify

- Every accepted node and edge is named and bounded.
- Static validation rejects unsupported shapes, contracts, routes,
  capabilities, and authority combinations.
- Runtime accounting records every logical node visit and selected edge,
  including deterministic, fork/join, approval, effect, and terminal nodes.
- Model calls require immutable initial grants for their compiled
  capabilities.
- Every path to a consequential simulated effect must be dominated by an
  approval node.
- Approval is bound to the run, artifact, capability, scope, and effect;
  simulator execution is one-time and idempotent.
- Parallel call/visit budgets are reserved before dispatch.
- Fixture adapter inputs exclude private fixture-oracle fields.
- Fixture output is byte-stable and its package membership, byte counts, and
  hashes can be verified.
- Portable Scenario Packs and Price Cards retain source hashes and provenance.
- Live plans require explicit call and spend authorization.

## Evidence package

The fixture report contains:

```text
wind-tunnel-output/fixture/
├── manifest.json
├── blueprints.json
├── policy.json
├── fixtures.json
├── results.json
├── execution.ndjson
├── trace.ndjson
├── report.md
└── report.html
```

Portable studies additionally retain their Scenario Pack, and priced live
studies retain their Price Card. `trace.ndjson` contains metadata rather than
prompt/output bodies. `execution.ndjson` records the logical graph route.

`npm run verify:fixture` recomputes declared SHA-256 hashes and byte counts and
rejects missing or unexpected package members. The manifest intentionally does
not hash itself.

## Claim boundary

The strongest current claim is:

> Within the checked-in deterministic synthetic composite calibrations, the
> harness selects the expected smallest feasible candidates, enforces its
> declared graph and authority invariants, exposes load-bearing ablations, and
> produces a reproducible evidence package.

Separately, the dated six-run live pilot demonstrates that the bounded live
adapter and selection path completed one narrow direct-versus-loop comparison.
Both candidates passed its declared local rubric, and the harness selected
`direct` because the loop did not improve that rubric score while adding calls,
tokens, observed elapsed time, estimated cost, and structural complexity.

The repository does **not** establish:

- that one topology is universally better;
- live semantic quality on representative organizational tasks;
- production safety, real IAM, or real deployment authorization;
- provider billing accuracy;
- production cost savings, adoption, scale, incidents, or ROI;
- formal verification or general dynamic graph execution.

See [Limitations](docs/limitations.md), [Methodology](docs/methodology.md), and
[Threat model](docs/threat-model.md).

## Documentation map

| Document | Audience and purpose |
| --- | --- |
| [Pages guide](docs/index.md) | Public reader entry point |
| [Product brief](docs/product-brief.md) | Product, operations, and engineering leaders |
| [Solution case study](docs/case-study.md) | Technical and business decisions, evidence, and limitations |
| [Architecture](docs/architecture.md) | Engineers reviewing components and invariants |
| [Methodology](docs/methodology.md) | Evaluation owners reviewing validity |
| [Threat model](docs/threat-model.md) | Security and risk reviewers |
| [Alternatives](docs/alternatives.md) | Build-vs-buy and tool-selection decisions |
| [Limitations](docs/limitations.md) | Fast interpretation boundary |
| [Ten-minute walkthrough](docs/walkthrough.md) | Independent reviewers |
| [Public live evidence](evidence/README.md) | Reviewers checking the bounded live pilot and its claim boundary |
| [Résumé exécutif](docs/executive-summary-fr.md) | Décideurs francophones |
| [AI collaboration](AI_COLLABORATION.md) | Development provenance and verification |
| [Contributing](CONTRIBUTING.md) | Contribution process and claim discipline |
| [Security](SECURITY.md) | Vulnerability reporting and safe use |

## Project status

Agent Wind Tunnel is an experimental reference implementation and evaluation
harness. It is suitable for study, reproduction, extension, and architecture
discussion. Production adoption requires representative held-out work,
repeated live trials, independent graders calibrated against human labels,
real platform controls, and an organization-specific threat model.

## Public sources

- [OpenAI: Evaluate agent workflows](https://developers.openai.com/api/docs/guides/agent-evals)
- [OpenAI: Trace grading](https://developers.openai.com/api/docs/guides/trace-grading)
- [OpenAI: Responses API migration guidance](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- [OpenAI: Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [NIST AI Risk Management Framework 1.0](https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-ai-rmf-10)
- [Government of Canada Algorithmic Impact Assessment](https://www.canada.ca/en/government/system/digital-government/digital-government-innovations/responsible-use-ai/algorithmic-impact-assessment.html)
- [Government of Canada Directive on Automated Decision-Making](https://www.tbs-sct.canada.ca/pol/doc-eng.aspx?id=32592)

## License and security

Released under the [MIT License](LICENSE).

Use [SECURITY.md](SECURITY.md) for vulnerability-reporting guidance.
