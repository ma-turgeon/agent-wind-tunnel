# Security policy

## Project status

Agent Wind Tunnel is a local experimental harness and reference implementation.
It is not a production authorization system, sandbox, identity provider,
deployment service, billing system, or formal verification engine.

Only the current `main` branch is actively reviewed. There is no long-term
support or security-response SLA.

## Reporting a vulnerability

Please do not open a public issue containing exploit details, credentials,
private task data, or a working proof of concept.

Preferred reporting path:

1. Use the repository’s
   [private vulnerability reporting](https://github.com/ma-turgeon/agent-wind-tunnel/security/advisories/new)
   if it is available.
2. If private reporting is unavailable, open a minimal public issue requesting
   a private reporting channel. Do not include exploit details, credentials,
   secrets, or sensitive reproduction data.

Include, through the private channel:

- affected commit or version;
- environment and reproduction steps;
- expected and observed behavior;
- security impact;
- the smallest safe proof of concept;
- whether any credential or real data may have been exposed;
- suggested mitigation, if known.

The maintainer will acknowledge when practical, validate the scope, and
coordinate disclosure. Response times are best effort.

## High-value report areas

- capability or scope escalation outside the immutable envelope;
- approval bypass or approval-binding replay;
- execution of an undeclared or unbounded graph route;
- duplicate consequential simulation despite idempotency;
- live calls made without explicit confirmation or above a declared ceiling;
- API key or sensitive prompt/output disclosure;
- output path traversal;
- report injection;
- Scenario Pack or Price Card provenance bypass;
- artifact verifier accepting modified or unexpected files;
- public live-evidence verification accepting inconsistent usage, pricing,
  provenance, or recommendation data;
- dependency or workflow compromise.

## Security boundaries

### What the code attempts to enforce

- closed graph, contract, and policy shapes;
- explicit node, edge, model-call, retry, and global visit bounds;
- immutable initial capability grants;
- approval dominance before a consequential simulated effect;
- approval binding to a specific run, artifact, capability, scope, and effect;
- one-time, data-only effect simulation;
- no arbitrary effect callback;
- explicit live confirmation;
- call and spend envelopes checked before credential resolution;
- metadata-only trace artifacts without prompt/output bodies;
- output confinement and manifest integrity checks.

### What it does not provide

- operating-system, browser, code, tool, or network sandboxing;
- authentication or production IAM;
- tenant isolation;
- authenticated human approval;
- real deployment or rollback;
- distributed idempotency and reconciliation;
- cryptographic report signing or external attestation;
- semantic prompt-injection resistance;
- secure handling of regulated or classified data;
- provider invoice reconciliation;
- production monitoring or incident response.

Read the full [threat model](docs/threat-model.md).

## API key safety

The deterministic demonstration needs no API key.

For an authorized live experiment:

- use `--dry-run` first;
- use a dedicated, least-privilege project key;
- prefer an approved secret manager or a protected local environment file;
- never put a key in a Blueprint, Scenario Pack, Price Card, report, trace,
  shell argument, commit, screenshot, or issue;
- set restrictive local file permissions;
- choose a narrow scenario/candidate/repetition matrix;
- review both call and spend envelopes;
- rotate a key immediately if exposure is suspected.

Confirmed live mode requires a validated exact-model Price Card, an explicit
spend cap, and a plan below both the call and spend ceilings. Those controls
reduce accidental use; they are not a substitute for provider-side budgets and
alerts.

## Sensitive data

Do not use organizational, client, citizen, procurement, production, personal,
regulated, or confidential data unless the full local and provider environment
has been separately authorized.

The enterprise portfolio cases in this repository are fictional composites.
Do not replace them with real dossiers in a public contribution.

## Dependencies and automation

The repository uses a lockfile, CI checks, package-content checks, and CodeQL.
These reduce risk but do not establish supply-chain safety. Review dependency
updates, action revisions, generated diffs, and effective package contents.

## Safe research

Keep tests local and non-destructive. Do not target systems, accounts, models,
or data you do not own or have explicit permission to test. The included
effect path must remain a data-only simulation in this repository.
