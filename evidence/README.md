# Public live evidence

This directory contains a deliberately narrow, publication-safe projection of
one Agent Wind Tunnel live pilot:

- [`live-pilot-2026-07-28.json`](live-pilot-2026-07-28.json) contains the
  configuration, authorization envelope, six per-run metric rows, recomputable
  aggregates, selection decision, provenance commitments, and claim boundary.
- The raw artifact bundle is retained privately. Prompt bodies, generated
  output bodies, provider request/response identifiers, and trace ledgers are
  not publication requirements and are excluded.

Verify the public record from the repository root:

```bash
npm run verify:evidence
```

The verifier fails closed on unknown fields, unsafe paths, aggregate drift,
missing repetitions, impossible authorization totals, price-card hash drift,
and a recommendation inconsistent with the declared feasible candidates.

## Interpretation

The record supports one bounded statement: in this six-run sample, both
`direct` and `loop` passed the declared local rubric and gates, while `direct`
used fewer calls and tokens and was selected as the least complex evaluated
feasible candidate.

It is not a benchmark, independent semantic evaluation, production validation,
savings claim, or provider invoice. Keep the JSON record and its
`claimBoundary` attached whenever quoting its figures.
