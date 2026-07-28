# Enterprise Agentic-AI Portfolio case pack

This case pack is a fictional, experience-grounded composite for demonstrating
Agent Wind Tunnel. It does not contain organizational, client, citizen, procurement,
or production data.

The nine initiative dossiers use normalized capacity points rather than hours,
headcount, dollars, or claimed savings. Six scenarios form a deliberately
constructed calibration set. Three additional scenarios are isolated in a
separate held-out file, but remain synthetic composite evidence—not an external
benchmark or independent validation.

The scoring concepts are informed by:

- NIST AI Risk Management Framework 1.0;
- the Government of Canada Algorithmic Impact Assessment;
- the Government of Canada Directive on Automated Decision-Making.

Validate both packs without model calls:

```bash
node agent-wind-tunnel.mjs validate \
  --scenario-pack scenarios/enterprise-portfolio/calibration.json

node agent-wind-tunnel.mjs validate \
  --scenario-pack scenarios/enterprise-portfolio/held-out.json
```

Run the deterministic calibration pack:

```bash
node agent-wind-tunnel.mjs demo \
  --scenario-pack scenarios/enterprise-portfolio/calibration.json \
  --output wind-tunnel-output/enterprise-portfolio-calibration
```

The fixture oracles are part of the disclosed calibration story. They prove
that the harness distinguishes the designed cases; they do not prove that a
real model or production task distribution will produce the same winners.

For future human calibration, give reviewers only `dossiers.json`,
`review-kit.md`, and a copy of `review-sheet.csv`. The repository intentionally
ships no completed review sheets and makes no independent-human-validation
claim.
