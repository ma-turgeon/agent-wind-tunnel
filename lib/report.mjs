import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  ensureInside,
  escapeHtml,
  mean,
  sha256,
  stableStringify,
} from "./util.mjs";

const STATUS_ICON = {
  accepted: "PASS",
  rejected: "FAIL",
  escalated: "ESC",
  mixed: "MIX",
  contract_error: "ERR",
  timeout: "ERR",
  budget_exhausted: "ERR",
  refused: "ERR",
  api_error: "ERR",
};

function writeArtifactFile(target, name, contents) {
  const destination = ensureInside(target, path.join(target, name));
  const temporary = ensureInside(
    target,
    path.join(target, `.${name}.${randomUUID()}.tmp`),
  );
  let temporaryExists = false;
  try {
    fs.writeFileSync(temporary, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    temporaryExists = true;
    fs.renameSync(temporary, destination);
    temporaryExists = false;
  } finally {
    if (temporaryExists) {
      fs.rmSync(temporary, { force: true });
    }
  }
}

function formatBps(value) {
  return `${(value / 100).toFixed(value % 100 === 0 ? 0 : 2)}%`;
}

function terminology(results) {
  const fixture = results.provenance.mode === "fixture";
  return {
    fixture,
    callLabel: fixture ? "simulated role calls" : "model calls",
    resourceLabel: fixture ? "synthetic cost units" : "token units",
    feasibleLabel: fixture ? "fixture-feasible" : "check-feasible",
    traceLabel: fixture ? "simulated role-call trace" : "model-call trace",
  };
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : Number(value).toFixed(2);
}

function formatCalls(value, terms) {
  const noun = Number(value) === 1 ? "call" : "calls";
  return `${formatNumber(value)} ${terms.fixture ? "simulated role" : "model"} ${noun}`;
}

function statusDistribution(cell) {
  return Object.entries(cell.statusCounts ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}:${count}`)
    .join(", ");
}

function meanLabel(cell) {
  return cell.repetitions > 1 ? "mean " : "";
}

function reproductionCommands(results) {
  const commands = ["cd agent-wind-tunnel", "npm ci", "npm test"];
  if (results.provenance.mode === "fixture") {
    commands.push("node agent-wind-tunnel.mjs demo");
  } else {
    const config = results.provenance.adapterConfig ?? {};
    const arguments_ = [
      "node agent-wind-tunnel.mjs run",
      "--adapter openai",
      "--dry-run",
      `--scenario ${results.scenarios.map((item) => item.id).join(",")}`,
      `--candidates ${results.blueprints.map((item) => item.id).join(",")}`,
      `--repetitions ${results.provenance.repetitions}`,
      config.model ? `--model ${config.model}` : null,
      config.reasoningEffort ? `--effort ${config.reasoningEffort}` : null,
      config.timeoutMs ? `--timeout ${config.timeoutMs}` : null,
      config.maximumLiveCalls
        ? `--max-live-calls ${config.maximumLiveCalls}`
        : null,
      config.maximumLiveSpendUsd
        ? `--max-live-spend-usd ${config.maximumLiveSpendUsd}`
        : null,
      config.reasoningMode === "pro" ? "--pro" : null,
      results.provenance.pricing ? "--price-card price-card.json" : null,
      results.provenance.scenarioPack
        ? "--scenario-pack scenario-pack.json"
        : null,
    ].filter(Boolean);
    commands.push(arguments_.join(" \\\n  "));
  }
  commands.push(
    results.provenance.mode === "fixture"
      ? "npm run verify:fixture"
      : "npm run verify:artifacts -- path/to/artifact-directory",
  );
  return commands;
}

function authorityEvents(results) {
  return results.runs.flatMap((run) =>
    run.authority.audit.map((event) => ({
      scenarioId: run.scenarioId,
      blueprintId: run.blueprintId,
      repetition: run.repetition,
      ...event,
    })),
  );
}

function graphProvenance(results) {
  const graph = results.blueprints.find(
    (blueprint) => blueprint.id === "graph-max-governed",
  );
  const transforms = graph?.source?.transforms;
  const observed = graph?.source?.derivedFrom?.inspection?.observedRoles ?? [];
  return {
    evaluated: Boolean(graph),
    sourceFile: graph?.source?.derivedFrom?.files?.join(", ") ?? "—",
    sourceHash: graph?.source?.derivedFrom?.sha256 ?? "—",
    scanKind: graph?.source?.derivedFrom?.inspection?.kind ?? "—",
    retained:
      transforms?.retainedSourceRoles ??
      observed,
    added:
      transforms?.addedRuntimeNodes ??
      graph?.source?.extensions ??
      [],
    omitted: transforms?.omittedSourceRoles ?? [],
  };
}

function failureSummary(aggregate, scenario) {
  const failures = [];
  if (aggregate.qualityBpsMean < scenario.slo.minimumQualityBps) {
    failures.push(
      `reached ${formatBps(aggregate.qualityBpsMean)} ${aggregate.repetitions > 1 ? "mean " : ""}weighted requirement coverage (minimum ${formatBps(scenario.slo.minimumQualityBps)})`,
    );
  }
  if (aggregate.contractErrors > 0) {
    failures.push(`${aggregate.contractErrors} contract error(s)`);
  }
  if (aggregate.authorityViolations > scenario.slo.maximumAuthorityViolations) {
    failures.push(`${aggregate.authorityViolations} authority violation(s)`);
  }
  if (aggregate.statuses.some((status) => status !== "accepted")) {
    failures.push(`status ${[...new Set(aggregate.statuses)].join("/")}`);
  }
  return failures.length ? failures.join(", ") : "a hard feasibility gate";
}

function causalExplanation(results, recommendation) {
  const selectedId = recommendation.blueprintId;
  const scenario = results.scenarios.find(
    (candidate) => candidate.id === recommendation.scenarioId,
  );
  if (!selectedId) {
    return recommendation.reason;
  }
  const selected = results.blueprints.find((item) => item.id === selectedId);
  const smaller = results.aggregates
    .filter(
      (item) =>
        item.scenarioId === scenario.id &&
        item.blueprintId !== selectedId &&
        item.complexity.score < selected.complexity.score,
    )
    .sort((left, right) => left.complexity.score - right.complexity.score);
  if (smaller.length === 0) {
    if (selectedId === "direct") {
      return "The direct topology satisfied every declared gate; no evaluated candidate had lower structural complexity.";
    }
    return `${selectedId} satisfied every declared gate, but no lower-complexity candidate was included in this run. It is the smallest evaluated candidate, not a comparison against omitted topologies.`;
  }
  const failed = smaller.filter((item) => !item.feasible);
  const observed = failed
    .map(
      (item) =>
        `${item.blueprintId} ${failureSummary(item, scenario)}`,
    )
    .join("; ");
  const mechanism = {
    loop: "The bounded evaluator–repair cycle was the first evaluated topology to restore the missing coverage.",
    "parallel-review":
      "The independent reviewer fan-out was the first evaluated topology to restore the missing cross-domain coverage.",
    "graph-max-governed":
      "Among evaluated candidates, plan review, specialist review, and the broker-owned approval/effect boundary were the first combination to satisfy all declared gates.",
  }[selectedId] ?? recommendation.reason;
  return `${observed || "Every smaller candidate missed a declared gate"}. ${mechanism}`;
}

function stripTrace(run) {
  const { trace: _trace, ...rest } = run;
  return rest;
}

function resultPayload(results, ablation) {
  return {
    ...results,
    runs: results.runs.map(stripTrace),
    ablation: ablation
      ? {
          ...ablation,
          runs: ablation.runs.map(stripTrace),
        }
      : null,
  };
}

function allTraceEvents(results, ablation) {
  const primary = results.runs.flatMap((run) =>
    run.trace.map((event) => ({ study: "canonical", ...event })),
  );
  const ablations = (ablation?.runs ?? []).flatMap((run) =>
    run.trace.map((event) => ({ study: "ablation", ...event })),
  );
  return [...primary, ...ablations].sort(
    (left, right) =>
      left.study.localeCompare(right.study) ||
      left.scenarioId.localeCompare(right.scenarioId) ||
      left.blueprintId.localeCompare(right.blueprintId) ||
      left.repetition - right.repetition ||
      left.sequence - right.sequence,
  );
}

function allExecutionEvents(results, ablation) {
  const flatten = (runs, study) =>
    runs.flatMap((run) =>
      (run.execution?.events ?? []).map((event) => ({
        study,
        runId: run.runId,
        scenarioId: run.scenarioId,
        blueprintId: run.blueprintId,
        repetition: run.repetition,
        ...event,
      })),
    );
  return [
    ...flatten(results.runs, "canonical"),
    ...flatten(ablation?.runs ?? [], "ablation"),
  ].sort(
    (left, right) =>
      left.study.localeCompare(right.study) ||
      left.scenarioId.localeCompare(right.scenarioId) ||
      left.blueprintId.localeCompare(right.blueprintId) ||
      left.repetition - right.repetition ||
      left.sequence - right.sequence,
  );
}

function matrixRows(results) {
  return results.scenarios.map((scenario) => {
    const cells = results.blueprints.map((blueprint) => {
      const aggregate = results.aggregates.find(
        (item) =>
          item.scenarioId === scenario.id && item.blueprintId === blueprint.id,
      );
      return {
        blueprintId: blueprint.id,
        status:
          new Set(aggregate.statuses).size === 1
            ? aggregate.statuses[0]
            : "mixed",
        qualityBps: aggregate.qualityBpsMean,
        modelCalls: aggregate.modelCallsMean,
        tokenUnits: aggregate.tokenUnitsMean,
        estimatedCost: aggregate.estimatedCostMean,
        repetitions: aggregate.repetitions,
        acceptanceRateBps: aggregate.acceptanceRateBps,
        statusCounts: aggregate.statusCounts,
        feasible: aggregate.feasible,
      };
    });
    const recommendation = results.recommendations.find(
      (item) => item.scenarioId === scenario.id,
    );
    return { scenario, cells, recommendation };
  });
}

function markdownReport(results, ablation) {
  const matrix = matrixRows(results);
  const terms = terminology(results);
  const commands = reproductionCommands(results);
  const brokerEvents = authorityEvents(results);
  const provenance = graphProvenance(results);
  const canonicalRecommendation =
    results.portfolioRecommendation.blueprintId ??
    results.portfolioRecommendation.status;
  const ablationRecommendation =
    ablation?.recommendation.blueprintId ??
    ablation?.recommendation.status;
  const lines = [
    "# Agent Wind Tunnel",
    "",
    `> ${results.provenance.claim}`,
    "",
    "## Decision",
    "",
    results.portfolioRecommendation.status === "RECOMMENDED"
      ? `Smallest evaluated canonical topology that satisfies every declared gate across this corpus: **${results.portfolioRecommendation.blueprintId}**.`
      : `Portfolio result: **${results.portfolioRecommendation.status}**.`,
    "",
    "Selection is constraint-first: authority-violating, contract-invalid, coverage-failing, or over-budget candidates are rejected before activity or structural complexity is considered.",
    "",
    "### How to read the two recommendations",
    "",
    "1. **Route per scenario:** choose the smallest evaluated canonical topology that satisfies that scenario's gates.",
    `2. **Choose a universal canonical topology:** among the candidates evaluated in this run, the result is **${canonicalRecommendation}**.`,
    ...(ablation
      ? [
          `3. **Optimize within that family:** only after choosing the governed graph family, the ablation study identifies **${ablationRecommendation}** as the leanest fixture-feasible variant in this calibration corpus.`,
        ]
      : []),
    "",
    "These answers address different questions; the ablation result does not contradict the canonical routing result.",
    "",
    "## Methodology and claim boundary",
    "",
    `- Mode: **${results.provenance.mode}**; adapter: **${results.provenance.adapter}**; repetitions: **n=${results.provenance.repetitions} per scenario × topology cell**.`,
    `- Conformance metric: **weighted requirement coverage** means passed requirement weight divided by total requirement weight. It is not a general claim of correctness.`,
      `- Semantic grader: **${results.provenance.semanticGrader ?? "unspecified"}**. ${results.provenance.evaluationBoundary ?? "Independent semantic assurance is outside this report."}`,
      results.provenance.pricing
        ? `- Estimated cost: versioned local price card, **${results.provenance.pricing.currency}**, effective **${results.provenance.pricing.effectiveDate}**, exact model **${results.provenance.pricing.model}**, tier **${results.provenance.pricing.rateProvenance.serviceTier}/${results.provenance.pricing.rateProvenance.contextTier}**. Raw token counts remain the measurement of record; derived USD is bounded by: ${results.provenance.pricing.rateProvenance.claimBoundary}`
        : "- Estimated cost: **not calculated**; no versioned price card was supplied.",
      results.provenance.scenarioPack
        ? `- Scenario-pack claim boundary: **${results.provenance.scenarioPack.claimBoundary.evaluationUse}**, source **${results.provenance.scenarioPack.provenance.sourceType}**. ${results.provenance.scenarioPack.claimBoundary.statement}`
        : "- Scenario pack: **built-in calibration corpus**.",
    terms.fixture
      ? "- Fixture activity is reported as **simulated role calls** and **synthetic cost units**. Neither is a live-model usage or dollar-cost measurement."
      : "- Live activity is reported as model calls and token units. Results are nondeterministic samples and are not pooled with fixtures.",
    "- Feasibility means every declared conformance-check, contract, authority, and budget gate passed within this run and corpus.",
    "- Consequential actions use a simulator. No external deployment or other external effect is performed.",
    ...(results.provenance.accounting
      ? [`- Budget accounting: ${results.provenance.accounting}`]
      : []),
    `- Inspect the exact inputs in [blueprints.json](blueprints.json), [policy.json](policy.json)${results.fixtureDefinitions ? ", and [fixtures.json](fixtures.json)" : ""}.`,
    "",
    "## Scenario × topology matrix",
    "",
    `| Scenario | ${results.blueprints.map((item) => item.id).join(" | ")} | Recommended |`,
    `| --- | ${results.blueprints.map(() => "---").join(" | ")} | --- |`,
    ...matrix.map(({ scenario, cells, recommendation }) => {
      const formatted = cells.map(
        (cell) =>
          `${STATUS_ICON[cell.status] ?? cell.status} · ${meanLabel(cell)}${formatBps(cell.qualityBps)} weighted coverage · ${meanLabel(cell)}${formatCalls(cell.modelCalls, terms)} · ${meanLabel(cell)}${formatNumber(cell.tokenUnits)} ${terms.resourceLabel}${cell.estimatedCost == null ? "" : ` · est. ${results.provenance.pricing.currency} ${cell.estimatedCost.toFixed(6)}`} · acceptance ${formatBps(cell.acceptanceRateBps)} · statuses ${statusDistribution(cell)} · n=${cell.repetitions}`,
      );
      return `| ${scenario.label} | ${formatted.join(" | ")} | ${recommendation.blueprintId ?? recommendation.status} |`;
    }),
    "",
    "## Why each topology earned its place",
    "",
    ...results.recommendations.flatMap((item) => {
      const scenario = results.scenarios.find((candidate) => candidate.id === item.scenarioId);
      return [
        `- **${scenario.label}:** ${item.blueprintId ?? item.status} — ${causalExplanation(results, item)}`,
      ];
    }),
    "",
    "## Canonical topology complexity",
    "",
    "| Topology | Nodes | Edges | Cycles | Approval gates | Complexity score |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...results.blueprints.map(
      (item) =>
        `| ${item.id} | ${item.complexity.nodes} | ${item.complexity.edges} | ${item.complexity.cycles} | ${item.complexity.approvals} | ${item.complexity.score} |`,
    ),
  ];

  if (ablation) {
    lines.push(
      "",
      "## Graph Max ablation ladder",
      "",
      `After the canonical study selects the governed graph family for universal coverage, the within-family ablation step selects **${ablationRecommendation}** for this calibration corpus.`,
      "",
      `| Variant | ${terms.feasibleLabel} across corpus | Failed scenarios |`,
      "| --- | --- | --- |",
      ...ablation.portfolio.map(
        (item) =>
          `| ${item.blueprintId} | ${item.feasibleAcrossCorpus ? "yes" : "no"} | ${item.failedScenarios.join(", ") || "—"} |`,
      ),
      "",
      "Within these fixtures, the lean variant retains every declared gate while removing presentation, synthesis, and speculative execution. The plan-review and security-review ablations fail named cases, so those independent checks remain load-bearing in this calibration corpus. This demonstrates harness behavior here; it does not establish universal architecture superiority.",
    );
  }

  lines.push(
    "",
    "## Graph provenance",
    "",
    ...(provenance.evaluated
      ? [
          `The governed graph is based on a **${provenance.scanKind}** of \`${provenance.sourceFile}\` (SHA-256: \`${provenance.sourceHash}\`). This is source-pattern evidence, not a general JavaScript compiler.`,
          "",
          `- Retained source roles: ${provenance.retained.join(", ") || "none"}.`,
          `- Added Wind Tunnel runtime/governance nodes: ${provenance.added.join(", ") || "none"}.`,
          `- Omitted source roles: ${provenance.omitted.join(", ") || "none"}.`,
        ]
      : [
          "Graph Max was not among the candidates evaluated in this run, so no Graph Max source-provenance claim is made.",
        ]),
    "",
    "## Authority broker audit",
    "",
    brokerEvents.length
      ? "| Scenario | Topology | Capability | Scope | Decision | Simulator invoked | External effect |\n| --- | --- | --- | --- | --- | --- | --- |\n" +
          brokerEvents
            .map(
              (event) =>
                `| ${event.scenarioId} | ${event.blueprintId} | ${event.capability ?? "—"} | ${event.scope ?? event.scopes?.join(", ") ?? "—"} | ${event.decision} | ${event.simulatorInvoked === true || (event.simulationOnly && event.executed) ? "yes" : "no"} | no |`,
            )
            .join("\n")
      : "No broker decisions were recorded. No external effect was performed.",
    "",
    "## Trace",
    "",
    `The separate \`trace.ndjson\` contains metadata for the ${terms.traceLabel}. It excludes prompt and output bodies.`,
    "The separate `execution.ndjson` records every logical graph node visit and selected edge transition, including the counter value checked against its bound.",
    "",
    "## Reproduce",
    "",
    "Requirements: Node.js 22 or later and the checked-in lockfile.",
    "",
    "```bash",
    ...commands,
    "```",
    "",
    "`verify:artifacts` checks package membership, recorded byte counts, and SHA-256 for each file listed under `manifest.json.files`. The manifest itself is not self-hashed.",
    ...(terms.fixture
      ? []
      : [
          "",
          "The live reproduction command uses `--dry-run` and therefore makes zero API calls. To collect a new empirical sample, replace it with `--confirm-live` and provide a key; nondeterministic outputs are not expected to be byte-identical.",
        ]),
    "",
    "Generated files are canonical JSON, NDJSON traces, Markdown, and dependency-free HTML.",
  );
  return `${lines.join("\n")}\n`;
}

function chartSvg(results) {
  const terms = terminology(results);
  const width = 920;
  const height = 360;
  const margin = { left: 78, right: 190, top: 48, bottom: 66 };
  const portfolio = results.blueprints.map((blueprint) => {
    const cases = results.aggregates.filter(
      (item) => item.blueprintId === blueprint.id,
    );
    return {
      id: blueprint.id,
      complexity: blueprint.complexity.score,
      calls: mean(cases.map((item) => item.modelCallsMean)),
      feasible: cases.every((item) => item.feasible),
    };
  });
  const maxComplexity = Math.max(...portfolio.map((item) => item.complexity), 1);
  const maxCalls = Math.max(...portfolio.map((item) => item.calls), 1);
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const x = (value) => margin.left + (value / maxComplexity) * plotWidth;
  const y = (value) => margin.top + plotHeight - (value / maxCalls) * plotHeight;
  const tickFractions = [0, 0.25, 0.5, 0.75, 1];
  const grid = tickFractions
    .map((fraction) => {
      const gridX = margin.left + plotWidth * fraction;
      const gridY = margin.top + plotHeight * (1 - fraction);
      const xValue = Math.round(maxComplexity * fraction);
      const yValue = Math.round(maxCalls * fraction * 100) / 100;
      return [
        `<line x1="${gridX}" y1="${margin.top}" x2="${gridX}" y2="${margin.top + plotHeight}" class="grid"/>`,
        `<line x1="${margin.left}" y1="${gridY}" x2="${margin.left + plotWidth}" y2="${gridY}" class="grid"/>`,
        `<text x="${gridX}" y="${margin.top + plotHeight + 22}" text-anchor="middle" class="axis-label">${xValue}</text>`,
        `<text x="${margin.left - 12}" y="${gridY + 4}" text-anchor="end" class="axis-label">${formatNumber(yValue)}</text>`,
      ].join("");
    })
    .join("");
  const points = portfolio
    .map((item, index) => {
      const pointX = x(item.complexity);
      const pointY = y(item.calls);
      const dy = index % 2 === 0 ? -14 : 22;
      return [
        `<circle cx="${pointX}" cy="${pointY}" r="8" class="${item.feasible ? "point feasible" : "point"}"/>`,
        `<text x="${pointX + 11}" y="${pointY + dy}" class="point-label">${escapeHtml(item.id)}</text>`,
      ].join("");
    })
    .join("");
  return `
  <svg viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="tradeoff-title tradeoff-desc">
    <title id="tradeoff-title">Topology complexity and activity trade-off scatter</title>
    <desc id="tradeoff-desc">Each point is a canonical topology. The horizontal axis is structural complexity and the vertical axis is mean ${escapeHtml(terms.callLabel)}. Green points satisfy every declared gate across this corpus; red points do not.</desc>
    <style>
      .grid{stroke:#26334c;stroke-width:1}.axis{stroke:#7890b8;stroke-width:1.5}
      .point{fill:#f97373;stroke:#1a2235;stroke-width:3}.point.feasible{fill:#59d6a7}
      .point-label,.axis-label{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;fill:#c8d5ec}
      .axis-title{font:13px Inter,system-ui,sans-serif;fill:#9fb1cf}
    </style>
    ${grid}
    <line x1="${margin.left}" y1="${margin.top + plotHeight}" x2="${margin.left + plotWidth}" y2="${margin.top + plotHeight}" class="axis"/>
    <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotHeight}" class="axis"/>
    ${points}
    <text x="${margin.left + plotWidth / 2}" y="${height - 16}" text-anchor="middle" class="axis-title">Structural complexity →</text>
    <text x="19" y="${margin.top + plotHeight / 2}" text-anchor="middle" transform="rotate(-90 19 ${margin.top + plotHeight / 2})" class="axis-title">Mean ${escapeHtml(terms.callLabel)} →</text>
  </svg>`;
}

function htmlReport(results, ablation) {
  const matrix = matrixRows(results);
  const terms = terminology(results);
  const commands = reproductionCommands(results);
  const provenance = graphProvenance(results);
  const recommendation = results.portfolioRecommendation.blueprintId ??
    results.portfolioRecommendation.status;
  const ablationRecommendation =
    ablation?.recommendation.blueprintId ??
    ablation?.recommendation.status;
  const brokerEvents = authorityEvents(results);
  const matrixHead = results.blueprints
    .map((item) => `<th scope="col">${escapeHtml(item.id)}</th>`)
    .join("");
  const matrixBody = matrix
    .map(({ scenario, cells, recommendation: scenarioRecommendation }) => `
      <tr>
        <th scope="row">${escapeHtml(scenario.label)}</th>
        ${cells
          .map(
            (cell) => `
          <td class="${cell.feasible ? "pass" : "fail"}">
            <strong>${escapeHtml(STATUS_ICON[cell.status] ?? cell.status)}</strong>
            <span>${escapeHtml(meanLabel(cell))}${escapeHtml(formatBps(cell.qualityBps))} weighted coverage</span>
            <small>${escapeHtml(meanLabel(cell))}${escapeHtml(formatCalls(cell.modelCalls, terms))}</small>
            <small>${escapeHtml(meanLabel(cell))}${escapeHtml(formatNumber(cell.tokenUnits))} ${escapeHtml(terms.resourceLabel)}</small>
            ${cell.estimatedCost == null ? "" : `<small>estimated ${escapeHtml(results.provenance.pricing.currency)} ${escapeHtml(cell.estimatedCost.toFixed(6))}</small>`}
            <small>acceptance ${escapeHtml(formatBps(cell.acceptanceRateBps))} · ${escapeHtml(statusDistribution(cell))} · n=${escapeHtml(cell.repetitions)}</small>
          </td>`,
          )
          .join("")}
        <td class="recommended">${escapeHtml(scenarioRecommendation.blueprintId ?? scenarioRecommendation.status)}</td>
      </tr>`)
    .join("");
  const cards = results.recommendations
    .map((item) => {
      const scenario = results.scenarios.find((candidate) => candidate.id === item.scenarioId);
      return `
      <article class="card">
        <p class="eyebrow">${escapeHtml(scenario.riskTier)}</p>
        <h3>${escapeHtml(scenario.label)}</h3>
        <p class="choice">${escapeHtml(item.blueprintId ?? item.status)}</p>
        <p>${escapeHtml(causalExplanation(results, item))}</p>
      </article>`;
    })
    .join("");
  const ablationRows = (ablation?.portfolio ?? [])
    .map(
      (item) => `
      <tr>
        <th scope="row">${escapeHtml(item.blueprintId)}</th>
        <td class="${item.feasibleAcrossCorpus ? "pass-text" : "fail-text"}">${item.feasibleAcrossCorpus ? escapeHtml(terms.feasibleLabel) : `not ${escapeHtml(terms.feasibleLabel)}`}</td>
        <td>${escapeHtml(item.failedScenarios.join(", ") || "—")}</td>
      </tr>`,
    )
    .join("");
  const traceRows = allTraceEvents(results, null)
    .slice(0, 120)
    .map(
      (event) => `
      <tr>
        <th scope="row">${escapeHtml(event.scenarioId)}</th>
        <td>${escapeHtml(event.blueprintId)}</td>
        <td>${escapeHtml(event.role)}</td>
        <td>${escapeHtml(event.status)}</td>
        <td>${escapeHtml(event.usage?.tokenUnits ?? 0)}</td>
      </tr>`,
    )
    .join("");
  const authorityRows = brokerEvents
    .map(
      (event) => `
      <tr>
        <th scope="row">${escapeHtml(event.scenarioId)}</th>
        <td>${escapeHtml(event.blueprintId)}</td>
        <td>${escapeHtml(event.capability ?? "—")}</td>
        <td>${escapeHtml(event.scope ?? event.scopes?.join(", ") ?? "—")}</td>
        <td>${escapeHtml(event.decision)}</td>
        <td>${event.simulatorInvoked === true || (event.simulationOnly && event.executed) ? "yes" : "no"}</td>
        <td>no</td>
      </tr>`,
    )
    .join("");
  const roleList = (items) =>
    items.length
      ? `<ul>${items.map((item) => `<li><code>${escapeHtml(item)}</code></li>`).join("")}</ul>`
      : "<p>None.</p>";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Wind Tunnel</title>
  <style>
    :root{color-scheme:dark;--bg:#090d16;--panel:#111827;--panel2:#162033;--line:#28354d;--text:#eef4ff;--muted:#9fb1cf;--mint:#59d6a7;--red:#f97373;--amber:#f8c15c;--violet:#a98cff}
    *{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 12% 0,#172643 0,transparent 32%),var(--bg);color:var(--text);font:15px/1.55 Inter,ui-sans-serif,system-ui,sans-serif}
    main{width:min(1220px,calc(100% - 32px));margin:auto;padding:48px 0 80px}
    h1{font-size:clamp(2.5rem,7vw,5.8rem);line-height:.92;margin:.2em 0;letter-spacing:-.065em}h2{font-size:1.55rem;margin:2.6em 0 .8em}h3{margin:.2em 0 .45em;font-size:1.05rem}
    p{color:var(--muted)}a{color:var(--mint)}li{color:var(--muted);margin:.35em 0}.eyebrow{text-transform:uppercase;letter-spacing:.14em;font:700 11px/1.2 ui-monospace,monospace;color:var(--violet)}
    .hero{display:grid;grid-template-columns:1.6fr 1fr;gap:24px;align-items:end;margin-bottom:36px}.hero-copy{max-width:790px}.hero-copy>p{font-size:1.1rem}.decision{background:linear-gradient(145deg,#18243a,#101827);border:1px solid var(--line);border-radius:22px;padding:24px}.decision strong{font-size:1.6rem;color:var(--mint);display:block;word-break:break-word}.notice{border-left:3px solid var(--amber);padding:12px 16px;background:#151a25;color:#d8c69c;border-radius:0 10px 10px 0}
    .cards{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px;min-height:190px}.card .choice{font:700 16px ui-monospace,monospace;color:var(--mint)}
    .method,.provenance{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px}.method ol{margin:.4em 0 0;padding-left:1.35em}.provenance-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.provenance-grid>section{background:var(--panel2);border-radius:12px;padding:14px}.provenance-grid ul{padding-left:1.25em}
    .table-wrap{overflow:auto;border:1px solid var(--line);border-radius:16px;background:var(--panel);max-width:100%}.table-wrap:focus{outline:3px solid var(--violet);outline-offset:3px}table{border-collapse:collapse;width:100%;min-width:850px}caption{text-align:left;padding:14px 15px;color:var(--muted);font-weight:650}th,td{padding:13px 15px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}thead th{position:sticky;top:0;background:#172137;color:#c7d5ed;font-size:12px}tbody th{color:#e7efff}.pass{background:rgba(89,214,167,.08)}.fail{background:rgba(249,115,115,.08)}td strong,td span,td small{display:block}.pass strong,.pass-text{color:var(--mint)}.fail strong,.fail-text{color:var(--red)}td small{color:var(--muted)}.recommended{color:var(--violet);font-weight:750}
    .chart{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:12px}.chart svg{width:100%;height:auto}
    details{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:15px;margin-top:18px}summary{cursor:pointer;font-weight:700}.reproduce{background:#0c1322;border:1px solid var(--line);border-radius:14px;padding:16px;overflow:auto}.footer{margin-top:46px;padding-top:20px;border-top:1px solid var(--line);font-size:13px}
    code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;color:#d9e4fa}
    @media(max-width:900px){.hero{grid-template-columns:1fr}.cards{grid-template-columns:1fr 1fr}.provenance-grid{grid-template-columns:1fr}}@media(max-width:560px){main{width:min(100% - 20px,1220px);padding-top:26px}.cards{grid-template-columns:1fr}}
  </style>
</head>
<body>
<main>
  <section class="hero">
    <div class="hero-copy">
      <p class="eyebrow">Architecture laboratory · ${escapeHtml(results.provenance.mode)}</p>
      <h1>Agent Wind Tunnel</h1>
      <p>Find the smallest evaluated agent topology that survives declared conformance-check, reliability, budget, and authority constraints.</p>
    </div>
    <aside class="decision">
      <p class="eyebrow">Whole-corpus recommendation</p>
      <strong>${escapeHtml(recommendation)}</strong>
      <p>${escapeHtml(results.portfolioRecommendation.reason)}</p>
    </aside>
  </section>
  <p class="notice"><strong>Provenance:</strong> ${escapeHtml(results.provenance.claim)}</p>

  <h2>How to read the result</h2>
  <section class="method">
    <ol>
      <li><strong>Route per scenario:</strong> select the smallest evaluated canonical topology that satisfies that scenario's gates.</li>
      <li><strong>Choose one universal canonical topology:</strong> among candidates evaluated in this run, that answer is <code>${escapeHtml(recommendation)}</code>.</li>
      ${ablation ? `<li><strong>Optimize within the selected family:</strong> the separate ablation step identifies <code>${escapeHtml(ablationRecommendation)}</code> as the leanest ${escapeHtml(terms.feasibleLabel)} graph-family variant in this calibration corpus.</li>` : ""}
    </ol>
    <p>These are different decisions, so the canonical recommendation and within-family ablation result do not conflict.</p>
  </section>

  <h2>Methodology and claim boundary</h2>
  <section class="method">
    <p><strong>Mode:</strong> ${escapeHtml(results.provenance.mode)} · <strong>Adapter:</strong> ${escapeHtml(results.provenance.adapter)} · <strong>Sample:</strong> n=${escapeHtml(results.provenance.repetitions)} per scenario × topology cell.</p>
    <p><strong>Conformance metric:</strong> weighted requirement coverage (passed requirement weight ÷ total requirement weight), not a general correctness score.</p>
    <p><strong>Semantic grader:</strong> ${escapeHtml(results.provenance.semanticGrader ?? "unspecified")}. ${escapeHtml(results.provenance.evaluationBoundary ?? "Independent semantic assurance is outside this report.")}</p>
    <p><strong>Estimated cost:</strong> ${results.provenance.pricing ? `${escapeHtml(results.provenance.pricing.currency)} using a versioned local price card effective ${escapeHtml(results.provenance.pricing.effectiveDate)} for exact model ${escapeHtml(results.provenance.pricing.model)}, tier ${escapeHtml(results.provenance.pricing.rateProvenance.serviceTier)}/${escapeHtml(results.provenance.pricing.rateProvenance.contextTier)}. Raw token counts remain the measurement of record; derived USD is bounded by: ${escapeHtml(results.provenance.pricing.rateProvenance.claimBoundary)}` : "not calculated because no versioned price card was supplied."}</p>
    <p><strong>Scenario-pack claim boundary:</strong> ${results.provenance.scenarioPack ? `${escapeHtml(results.provenance.scenarioPack.claimBoundary.evaluationUse)} · source ${escapeHtml(results.provenance.scenarioPack.provenance.sourceType)}. ${escapeHtml(results.provenance.scenarioPack.claimBoundary.statement)}` : "built-in calibration corpus."}</p>
    <p>${terms.fixture ? "Activity is reported as simulated role calls and synthetic cost units; neither is live-model usage or dollar cost." : "Activity is reported as model calls and token units; these are nondeterministic empirical samples and are not pooled with fixture results."}</p>
    <p>Feasibility means every declared conformance-check, contract, authority, and budget gate passed within this run and corpus. Consequential effects are simulated only; no external effect is performed.</p>
    ${results.provenance.accounting ? `<p><strong>Budget accounting:</strong> ${escapeHtml(results.provenance.accounting)}</p>` : ""}
    <p>Inspect the exact inputs in <a href="blueprints.json">blueprints.json</a>, <a href="policy.json">policy.json</a>${results.fixtureDefinitions ? ', and <a href="fixtures.json">fixtures.json</a>' : ""}.</p>
  </section>

  <h2>Scenario routing</h2>
  <section class="cards">${cards}</section>

  <h2>Scenario × topology matrix</h2>
  <div class="table-wrap" role="region" aria-label="Scenario by topology results" tabindex="0">
    <table>
      <caption>Each cell shows status, mean metrics when n&gt;1, acceptance rate, status distribution, and repetitions.</caption>
      <thead><tr><th scope="col">Scenario</th>${matrixHead}<th scope="col">Recommended</th></tr></thead>
      <tbody>${matrixBody}</tbody>
    </table>
  </div>

  <h2>Complexity–activity trade-off scatter</h2>
  <p>Green points satisfy every declared gate across this corpus; red points do not. Lower activity cannot compensate for a failed hard gate.</p>
  <div class="chart">${chartSvg(results)}</div>

  ${
    ablation
      ? `<h2>Graph Max ablation ladder</h2>
  <p>After the canonical study selects the governed graph family for universal coverage, within-family optimization selects <strong>${escapeHtml(ablationRecommendation)}</strong> in this calibration corpus.</p>
  <div class="table-wrap" role="region" aria-label="Graph Max ablation results" tabindex="0">
    <table>
      <caption>Removing a node or behavior is justified only when every declared corpus gate still passes.</caption>
      <thead><tr><th scope="col">Variant</th><th scope="col">Corpus status</th><th scope="col">Failed scenarios</th></tr></thead>
      <tbody>${ablationRows}</tbody>
    </table>
  </div>
  <p>The lean result demonstrates behavior within this fixture calibration; it does not establish universal architecture superiority.</p>`
      : ""
  }

  <h2>Graph provenance</h2>
  ${
    provenance.evaluated
      ? `<section class="provenance">
    <p>The governed graph is based on a <strong>${escapeHtml(provenance.scanKind)}</strong> of <code>${escapeHtml(provenance.sourceFile)}</code> (SHA-256 <code>${escapeHtml(provenance.sourceHash)}</code>). This is source-pattern evidence, not a general JavaScript compiler.</p>
    <div class="provenance-grid">
      <section><h3>Retained source roles</h3>${roleList(provenance.retained)}</section>
      <section><h3>Added runtime/governance nodes</h3>${roleList(provenance.added)}</section>
      <section><h3>Omitted source roles</h3>${roleList(provenance.omitted)}</section>
    </div>
  </section>`
      : "<p>Graph Max was not among the candidates evaluated in this run, so no Graph Max source-provenance claim is made.</p>"
  }

  <h2>Authority broker audit</h2>
  <p>${brokerEvents.length ? `${brokerEvents.length} broker ${brokerEvents.length === 1 ? "decision" : "decisions"} recorded.` : "No broker decisions were recorded."} The simulator is isolated from external systems; external effect is always <strong>no</strong>.</p>
  ${brokerEvents.length ? `
  <div class="table-wrap" role="region" aria-label="Authority broker decisions" tabindex="0">
    <table>
      <caption>Broker decisions are distinct from role-call trace events.</caption>
      <thead><tr><th scope="col">Scenario</th><th scope="col">Topology</th><th scope="col">Capability</th><th scope="col">Scope</th><th scope="col">Decision</th><th scope="col">Simulator invoked</th><th scope="col">External effect</th></tr></thead>
      <tbody>${authorityRows}</tbody>
    </table>
  </div>` : ""}

  <h2>Execution trace</h2>
  <p>The role-call trace is metadata-only and separate from the authority audit; prompt and output bodies are excluded. The exact graph-node and edge-transition ledger is packaged separately as <code>execution.ndjson</code> and embedded per run in <code>results.json</code>.</p>
  <details>
    <summary>Show canonical ${escapeHtml(terms.traceLabel)} (${results.runs.reduce((sum, run) => sum + run.trace.length, 0)} events)</summary>
    <div class="table-wrap" role="region" aria-label="Canonical execution trace" tabindex="0">
      <table>
        <caption>Up to 120 canonical trace events are shown here; the complete trace is in trace.ndjson.</caption>
        <thead><tr><th scope="col">Scenario</th><th scope="col">Topology</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">${escapeHtml(terms.resourceLabel)}</th></tr></thead>
        <tbody>${traceRows}</tbody>
      </table>
    </div>
  </details>

  <h2>Reproduce and verify</h2>
  <p>Requires Node.js 22 or later and the checked-in lockfile.</p>
  <pre class="reproduce"><code>${escapeHtml(commands.join("\n"))}</code></pre>
  <p><code>verify:artifacts</code> checks package membership, recorded byte counts, and SHA-256 for every file listed under <code>manifest.json.files</code>. The manifest itself is not self-hashed.</p>
  ${terms.fixture ? "" : "<p>The live reproduction command is a zero-call dry run. Replace <code>--dry-run</code> with <code>--confirm-live</code> and provide a key to collect a new empirical sample; nondeterministic outputs are not expected to be byte-identical.</p>"}

  <p class="footer">Run ID: <code>${escapeHtml(results.runId)}</code>. Generated mode: <code>${escapeHtml(results.provenance.mode)}</code>.</p>
</main>
</body>
</html>
`;
}

export function writeArtifactPackage({
  results,
  ablation = null,
  outputDir,
  projectRoot,
}) {
  const target = ensureInside(projectRoot, outputDir);
  fs.mkdirSync(target, { recursive: true });
  const payload = resultPayload(results, ablation);
  const trace = allTraceEvents(results, ablation)
    .map((event) => stableStringify(event, 0))
    .join("\n");
  const execution = allExecutionEvents(results, ablation)
    .map((event) => stableStringify(event, 0))
    .join("\n");
  const files = {
    "blueprints.json": `${stableStringify({
      schemaVersion: "agent-wind-tunnel.blueprint-set/v1",
      blueprints: results.blueprintIR,
    })}\n`,
    "policy.json": `${stableStringify(results.policySnapshot)}\n`,
    ...(results.pricingSnapshot
      ? { "price-card.json": `${stableStringify(results.pricingSnapshot)}\n` }
      : {}),
    ...(results.scenarioPackSnapshot
      ? {
          "scenario-pack.json": `${stableStringify(
            results.scenarioPackSnapshot,
          )}\n`,
        }
      : {}),
    ...(results.fixtureDefinitions
      ? {
          "fixtures.json": `${stableStringify({
            schemaVersion: "agent-wind-tunnel.fixture-set/v1",
            fixtures: results.fixtureDefinitions,
          })}\n`,
        }
      : {}),
    "results.json": `${stableStringify(payload)}\n`,
    "execution.ndjson": execution ? `${execution}\n` : "",
    "trace.ndjson": trace ? `${trace}\n` : "",
    "report.md": markdownReport(results, ablation),
    "report.html": htmlReport(results, ablation),
  };
  for (const [name, contents] of Object.entries(files)) {
    writeArtifactFile(target, name, contents);
  }
  const manifest = {
    schemaVersion: "agent-wind-tunnel.manifest/v1",
    harnessVersion: results.provenance.harnessVersion ?? "unknown",
    runId: results.runId,
    generatedAt: results.generatedAt,
    mode: results.provenance.mode,
    deterministic: results.provenance.deterministic,
    files: Object.fromEntries(
      Object.entries(files).map(([name, contents]) => [
        name,
        { sha256: sha256(contents), bytes: Buffer.byteLength(contents) },
      ]),
    ),
    sources: [
      {
        label: "OpenAI model guidance",
        href: "https://developers.openai.com/api/docs/guides/latest-model",
      },
      {
        label: "OpenAI Structured Outputs",
        href: "https://developers.openai.com/api/docs/guides/structured-outputs",
      },
      {
        label: "OpenAI evaluation best practices",
        href: "https://developers.openai.com/api/docs/guides/evaluation-best-practices",
      },
    ],
  };
  writeArtifactFile(
    target,
    "manifest.json",
    `${stableStringify(manifest)}\n`,
  );
  return {
    outputDir: target,
    manifest,
    files: ["manifest.json", ...Object.keys(files)],
  };
}
