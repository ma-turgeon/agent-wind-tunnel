# Contributing

Thank you for helping make Agent Wind Tunnel more falsifiable, reproducible,
and useful.

This project values small, evidence-backed changes over a larger feature count.
The easiest contribution to accept is one that states the claim it affects,
adds a test that could fail, and preserves the distinction between synthetic
calibration, live empirical evidence, and production outcomes.

## Before starting

For a defect or focused documentation correction, a pull request is welcome.
For a new topology family, authority model, adapter, or schema version, open an
issue first so the executable semantics and evidence burden can be agreed
before implementation.

Security reports must follow [SECURITY.md](SECURITY.md), not a public issue.

## Development setup

Requirements: Node.js 22 or later and npm.

```bash
git clone https://github.com/ma-turgeon/agent-wind-tunnel.git
cd agent-wind-tunnel
npm ci
npm test
```

Run the complete local check:

```bash
npm run check
```

That command enforces coverage thresholds, generates and verifies a
deterministic CI fixture, recomputes the checked-in public live evidence, and
checks the publishable package contents.

## Project principles

### Hard gates before optimization

Do not let a cost, latency, activity, or complexity score compensate for a
mandatory, contract, reliability, or authority failure.

### Closed semantics

Metadata must not claim behavior the runtime does not execute. A new node kind,
role, route outcome, capability rule, or feature flag needs:

- schema and closed-shape support;
- validation and compiler binding;
- runtime behavior;
- exact execution-ledger coverage;
- failure and adversarial tests;
- reporting and documentation.

### Fail closed

Unknown permissions, unsupported contracts, unbounded routes, missing
approvals, ambiguous Price Cards, and malformed Scenario Packs should stop or
escalate rather than receive a best-effort interpretation.

### Every node earns its burden

Keep `direct` as the baseline. Add orchestration only when a declared,
important failure returns without it. Include an ablation or negative test
where practical.

### Claims follow evidence

Use these evidence labels consistently:

- **fixture/calibration:** deterministic or constructed evidence about harness
  behavior;
- **synthetic/composite:** fictional material assembled to represent a class
  of work;
- **held-out composite:** separated from calibration but still not external,
  human-labelled, or statistically representative;
- **live empirical sample:** nondeterministic model execution under the stated
  configuration;
- **production outcome:** requires actual operational or business evidence and
  is not present in this repository today.

Avoid “SOTA,” “first,” “only,” “production-safe,” “formally verified,” and
universal-superiority claims unless independently established and narrowly
defined.

## Change types

### Runtime or compiler

- Keep the change inside the declared family semantics.
- Add positive, negative, boundary, and mutation tests.
- Test atomic budget accounting where parallel work is involved.
- Preserve immutable adapter inputs and authority envelopes.
- Update the schema, architecture, threat model, and generated-report language
  if the accepted behavior changes.

### Topology family

A new family is not “just another JSON file.” Document:

1. the decision hypothesis;
2. exact nodes, outcomes, and finite bounds;
3. supported role contracts;
4. authority and approval behavior;
5. compiler-to-route binding;
6. complexity dimensions;
7. smallest baseline it should be compared against;
8. at least one case where it fails and one where it earns its place.

### Scenario Pack

Scenario Packs must use the versioned schema and include:

- unique pack and scenario IDs;
- source provenance and only public authoritative framework references;
- an explicit `evaluationUse`;
- an accurate `syntheticOrComposite` flag;
- a plain-language claim-boundary statement;
- executable or inspectable requirements;
- budgets and SLOs;
- no organizational, client, citizen, procurement, or production data without
  documented authorization.

Do not call a pack independent merely because its file is named `held-out`.

### Price Card

A Price Card must:

- use the versioned schema;
- name a currency and effective date;
- identify public rate sources;
- match exact model IDs;
- state its provenance and assumptions;
- remain an estimate input, never an invoice.

Do not copy unverified pricing from a blog, model answer, screenshot, or search
snippet. Re-run dry plans and update affected documentation when a card
changes.

### Adapter

An adapter must not choose hidden topology, read private fixture-oracle fields,
mint authority, or silently fall back to deterministic fixtures. Record the
requested and returned model/provider identity and usage available from the
provider.

### Documentation

- Lead with the supported decision and claim boundary.
- Mark every synthetic/composite result close to the table or visual.
- Link to a source file, test, artifact, or public authoritative reference.
- Keep commands runnable from the repository root.
- Update English and French executive surfaces when a material public claim
  changes.
- Do not publish street addresses, telephone numbers, credentials, private
  organizational/client data, or non-project personal records.

### SVG and static Pages assets

- Use dependency-free SVG/HTML.
- Include a `<title>` and `<desc>` in each SVG.
- Preserve readable contrast and meaningful text without relying on color.
- Avoid scripts, remote fonts, trackers, and external runtime dependencies.
- Test links from the staged Pages root.

## Tests

Run at minimum:

```bash
npm test
npm run test:coverage
npm run verify:evidence
node agent-wind-tunnel.mjs inspect
node agent-wind-tunnel.mjs demo --output .ci-output/local-doc-check
node scripts/verify-artifacts.mjs .ci-output/local-doc-check
npm run pack:check
```

For a Scenario Pack or Price Card:

```bash
node agent-wind-tunnel.mjs validate \
  --scenario-pack path/to/scenario-pack.json

node agent-wind-tunnel.mjs validate \
  --price-card price-cards/openai-standard-short-context-2026-07-28.json
```

Do not commit `node_modules`, credentials, coverage output, or generated
`wind-tunnel-output`.

## AI-assisted contributions

AI assistance is welcome when disclosed and verified. Read
[AI_COLLABORATION.md](AI_COLLABORATION.md).

In a pull request, state:

- which assistants or tools materially contributed;
- what they produced or reviewed;
- which commands and human checks verified the result;
- any uncertainty that remains.

Never paste secrets, private data, or material you are not authorized to share
into an assistant. Generated code and citations remain the contributor’s
responsibility.

## Pull request checklist

- [ ] The change has one clear purpose.
- [ ] New behavior has failure-oriented tests.
- [ ] `npm run check` passes.
- [ ] Runtime, schema, tests, docs, and report language agree.
- [ ] Synthetic/composite evidence is labeled next to the claim.
- [ ] External claims use public authoritative sources.
- [ ] No secrets, private data, personal address, or telephone number is
      included.
- [ ] Material AI assistance is disclosed.
- [ ] Security-sensitive details have not been put in a public issue.

## Review criteria

Reviewers will prioritize:

1. semantic correctness and fail-closed behavior;
2. claim discipline;
3. adversarial and regression evidence;
4. reproducibility;
5. security and privacy boundaries;
6. reader clarity;
7. feature breadth.

An accurate limitation is preferable to an unsupported capability.
