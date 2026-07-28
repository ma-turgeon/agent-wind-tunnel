---
layout: default
title: Agent Wind Tunnel — Ten-minute walkthrough
description: Reproduce, inspect, and challenge the deterministic demonstration.
---

# Ten-minute walkthrough

This walkthrough is designed for a reviewer who wants evidence, not a narrated
tour. The default path is fully local and makes no API calls.

## Prerequisites

- Node.js 22 or later;
- npm;
- the repository and its lockfile.

Check the runtime:

```bash
node --version
npm --version
```

## 1. Install exactly what the lockfile declares

```bash
npm ci
```

Why it matters: `npm ci` refuses to rewrite dependency resolution and provides
a cleaner reproduction than an unconstrained install.

## 2. Run the adversarial test suite

```bash
npm test
```

Look for a zero exit code. The suite covers:

- malformed graph, policy, and contract rejection;
- exact node/edge/global bounds;
- hidden fixture-oracle isolation;
- retry, timeout, and parallel budget accounting;
- immutable capability grants and approval dominance;
- one-time effect simulation;
- live-call and spend guardrails;
- portable scenario-pack and price-card validation;
- byte-stable fixture artifacts.

For enforced coverage thresholds:

```bash
npm run test:coverage
```

## 3. Inspect what will execute

```bash
node agent-wind-tunnel.mjs inspect
```

Expected structure:

```text
direct                  5 nodes,  4 edges, 0 cycles
loop                    7 nodes,  8 edges, 1 cycle
parallel-review        11 nodes, 16 edges, 1 cycle
graph-max-governed     19 nodes, 30 edges, 2 cycles
```

Inspection also prints the source hash and observed Graph Max roles. It does
not make an API call or write a report.

## 4. Run the deterministic calibration

```bash
node agent-wind-tunnel.mjs demo
```

Expected recommendation ladder:

```text
Simple deterministic transform          direct
Operator-safety documentation gap       loop
Cross-domain release review             parallel-review
Consequential production deployment     graph-max-governed
```

The CLI also reports:

```text
Whole corpus: graph-max-governed
Fixture-feasible within-family ablation: graph-lean
```

These are synthetic composite fixture outcomes. They demonstrate harness
behavior and do not predict a live model’s quality.

## 5. Verify the evidence package

```bash
npm run verify:fixture
```

The verifier recomputes SHA-256 values and byte counts for every file listed in
the manifest and rejects missing or unexpected members.

Open the reader report:

```text
wind-tunnel-output/fixture/report.html
```

Then inspect the machine surfaces:

```bash
sed -n '1,120p' wind-tunnel-output/fixture/report.md
sed -n '1,3p' wind-tunnel-output/fixture/execution.ndjson
sed -n '1,3p' wind-tunnel-output/fixture/trace.ndjson
```

If `jq` is installed:

```bash
jq '.recommendations, .portfolioRecommendation' \
  wind-tunnel-output/fixture/results.json
```

## 6. Follow one claim to its evidence

Choose the consequential scenario in the HTML or JSON report and verify:

1. smaller canonical candidates miss declared hard gates;
2. the governed graph’s executed route reaches the approval node;
3. the effect event is marked simulation-only and external-effect false;
4. the execution ledger records one selected effect route;
5. the ablation without plan review fails the named fixture case.

This claim-to-route exercise is more informative than looking only at the
recommendation table.

## 7. Challenge the design

Read these tests before accepting the security language:

```text
test/execution-ledger.test.mjs
test/wind-tunnel.test.mjs
test/experiment-inputs.test.mjs
```

Useful searches:

```bash
rg -n "approval bypass|unbounded|immutable|idempot|spend cap" test
rg -n "simulationOnly|externalEffect|grantsMutated" lib test
```

Then compare the claimed boundary with [Threat model](threat-model.md).

## 8. Validate portable study inputs

The CLI can validate a Scenario Pack or Price Card without reading an API key:

```bash
node agent-wind-tunnel.mjs validate \
  --scenario-pack path/to/scenario-pack.json

node agent-wind-tunnel.mjs validate \
  --price-card price-cards/openai-standard-short-context-2026-07-28.json
```

A Scenario Pack must include provenance and a claim boundary. A Price Card must
declare its source provenance, currency, effective date, and exact supported
model rates. Invalid or mismatched inputs fail closed.

The repository’s `scenarios/enterprise-portfolio/` directory demonstrates a
calibration/held-out dossier structure. Treat those materials according to the
claim boundary stored in each pack; a filename such as `held-out.json` is not
by itself proof of independence.

The same directory includes `review-kit.md` and a blank `review-sheet.csv` for
optional blinded human review. The repository contains no completed sheets,
human-label calibration, or measured reviewer agreement.

## 9. Preview a live comparison without spending

```bash
node agent-wind-tunnel.mjs run \
  --adapter openai \
  --dry-run \
  --scenario operator-doc-gap \
  --candidates direct,loop \
  --repetitions 3
```

The command prints a conservative call envelope, reads no credential, and
makes zero API calls.

To include a conservative cost envelope:

```bash
node agent-wind-tunnel.mjs run \
  --adapter openai \
  --dry-run \
  --scenario operator-doc-gap \
  --candidates direct,loop \
  --repetitions 3 \
  --price-card price-cards/openai-standard-short-context-2026-07-28.json
```

The estimate prices the declared per-run token budgets using the highest
applicable exact-model token rate in the supplied versioned card. It is a
planning ceiling, not a provider invoice.

## 10. Inspect the completed bounded live pilot

Do not spend tokens merely to repeat the published pilot. Inspect the checked-in
[curated evidence](../evidence/live-pilot-2026-07-28.json) or its
[visual summary](https://ma-turgeon.github.io/agent-wind-tunnel/live-pilot.html).

The projection records one synthetic scenario, one OpenAI
model/configuration, `direct` and `loop`, and three repetitions per candidate.
All six runs passed the declared deterministic structural/lexical rubric. With
quality tied under that rubric, `direct` was selected as the less complex
candidate. The sample recorded nine calls, 12,019 tokens, zero retries, and a
USD 0.08756 local Price Card estimate.

Check the boundary as carefully as the result: `semanticGrader` is `none`,
declared test-case strings were not executed, no Graph Max candidate was run,
and the sample is not a benchmark, production result, savings or ROI study, or
provider invoice.

## 11. Understand the live safety gate

Confirmed live execution requires all of the following:

- `--confirm-live`;
- a valid exact-model `--price-card`;
- an explicit `--max-live-spend-usd`;
- a call envelope at or below `--max-live-calls`;
- a spend envelope at or below the explicit cap;
- an OpenAI API key resolved from the approved environment or key file.

Do not run a confirmed study merely to complete this walkthrough. The offline
calibration and curated live projection are sufficient to review the
implementation and completed pilot. If another live study is authorized,
start with a narrow matched comparison and retain the exact configuration.

## Reading map

| If you have… | Read |
| --- | --- |
| 2 minutes | [Product brief](product-brief.md) |
| 8 minutes | [Solution case study](case-study.md) |
| 15 minutes | [Architecture](architecture.md) |
| 20 minutes | [Methodology](methodology.md) |
| Security responsibility | [Threat model](threat-model.md) and [SECURITY.md](../SECURITY.md) |
| A build-vs-buy decision | [Alternatives](alternatives.md) |

## Troubleshooting

### Node version error

Use Node.js 22 or later. The package declares its supported engine in
`package.json`.

### `npm ci` reports lockfile mismatch

Do not replace the lockfile to force the walkthrough. Confirm that the checkout
is complete and unchanged.

### Fixture verification fails

Re-run the deterministic demo, then inspect the verifier’s exact missing,
unexpected, byte-count, or hash error. A modified artifact is expected to
fail.

### Dry-run says `BLOCKED`

The default matrix can exceed the call ceiling. Select fewer scenarios or
candidates. A dry-run intentionally exits without making calls.

### Confirmed live mode rejects the plan before reading a key

Supply a validated exact-model Price Card and an explicit spend cap, then make
the scenario/candidate/repetition matrix small enough to fit both the call and
spend envelopes.

### Consequential live case escalates

That is expected. No live human approval provider is included, so the runtime
fails closed rather than simulate human approval in live mode.
