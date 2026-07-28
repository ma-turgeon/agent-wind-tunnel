# AI collaboration and development provenance

## Disclosure

Agent Wind Tunnel was developed with substantial AI-assisted collaboration
under human direction. OpenAI Codex was used for activities including:

- interpreting and formalizing the initial workflow graph;
- exploring product and ecosystem context;
- drafting and refactoring implementation code;
- proposing schemas, contracts, and adversarial tests;
- reviewing topology, budget, authority, and failure invariants;
- generating and revising documentation and diagrams;
- checking claim boundaries and identifying overstatement;
- running local verification and reporting failures for correction.

Multiple AI assistants also informed the broader exploratory documentation that
preceded this repository. This file does not claim that an assistant
independently designed, verified, or owns the project.

## Human responsibility

The human maintainer directed the objective, selected the project scope,
supplied source material, reviewed decisions and claim boundaries, authorized
tool use, and remains responsible for what is published.

AI output is treated as a proposal, not evidence. Responsibility for code,
security, privacy, citations, licensing, and public claims remains human.

## Verification model

AI-generated or AI-modified work was checked through a combination of:

- direct source inspection;
- closed schemas and contracts;
- deterministic unit, integration, mutation, and adversarial tests;
- exact execution-ledger assertions;
- fixture-oracle isolation tests;
- authority-bypass and budget-boundary tests;
- deterministic replay and byte comparison;
- generated artifact membership, byte-count, and hash verification;
- live dry-run call/spend planning;
- one explicitly authorized, bounded live comparison whose raw bundle was
  verified locally and reduced to a metrics-only public projection;
- public-evidence checks that recompute totals, pricing, aggregates, the
  Pareto frontier, and the recommendation;
- explicit limitations and threat-model review;
- public authoritative documentation for external product and governance
  references.

Passing tests establish the behavior they cover. They do not make model output
semantically correct, prove the absence of vulnerabilities, establish
production safety, or validate a business outcome.

## Why AI assistance is disclosed

For an agent-evaluation project, hiding the development harness would undermine
the project’s own evidence standard. Disclosure helps a reviewer distinguish:

- human objectives and accountability;
- assistant-generated proposals;
- executable verification;
- synthetic fixture assumptions;
- independent external evidence, which remains limited.

The relevant engineering standard is not how quickly an assistant produced
text. It is whether the resulting system has a coherent decision model,
failure-oriented tests, reproducible evidence, explicit boundaries, and human
accountability.

## Known provenance limitations

- Conversation transcripts are not packaged as a complete, stable build log.
- AI suggestions that were rejected are not exhaustively recorded.
- The same human/AI collaboration contributed to implementation, tests, and
  documentation, so internal agreement is not independent validation.
- The deterministic fixture corpus was deliberately calibrated.
- The published live pilot is one synthetic scenario with three repetitions
  per candidate and no independent semantic grader.
- Its raw prompt/output and trace material is intentionally not public; hashes
  are commitments to retained files, not external attestation.
- Public authoritative sources support external concepts, but they do not
  endorse this project.
- Repository tests and reviews can miss defects.

An independent code review, external reproduction, and separately owned
held-out study would provide stronger evidence.

## Data handling

The public repository is intended to contain fictional composite scenarios,
public references, source code, generated calibration evidence, and a curated
metrics-only live evidence record. Raw live prompts, outputs, request/response
identifiers, and trace ledgers are excluded.

AI tools must not receive or reproduce:

- API keys or credentials;
- street addresses or telephone numbers;
- private organizational, client, citizen, procurement, or production data;
- non-project personal records;
- regulated or copyrighted material without authorization.

## Citation and product guidance

External factual claims should use public authoritative sources. OpenAI API and
product behavior should cite current official OpenAI developer documentation.
Governance-framework references should point to the relevant government or
standards body.

An assistant’s recollection, a search-result snippet, a social post, or another
model’s answer is not a sufficient source for a material public claim.

## Rules for future AI-assisted contributions

Contributors using AI assistance should:

1. disclose the assistant/tool and the material task it performed;
2. inspect every proposed change;
3. run the project’s complete checks;
4. add failure-oriented tests for new behavior;
5. verify every external citation at its primary source;
6. label synthetic, composite, held-out, and live evidence correctly;
7. avoid generated dependencies or licenses that have not been reviewed;
8. keep secrets and private data out of prompts and artifacts;
9. record remaining uncertainty in the pull request;
10. never attribute accountability or approval to an AI system.

Suggested pull-request disclosure:

```text
AI assistance:
- Tool/model:
- Material contribution:
- Human review performed:
- Verification commands:
- Remaining uncertainty:
```

## Reproducibility requirements

The project does not ask reviewers to trust either a person or an AI assistant.
It asks them to inspect the contracts, run the tests, reproduce the fixture,
challenge the failure cases, and keep the claim within the evidence boundary.
