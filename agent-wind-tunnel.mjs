#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildAblationBlueprints, runAblationStudy } from "./lib/ablations.mjs";
import {
  buildBlueprints,
  buildScenarios,
  POLICY,
} from "./lib/catalog.mjs";
import { FixtureAdapter } from "./lib/fixture-adapter.mjs";
import { createFixtureApprovalProvider } from "./lib/authority.mjs";
import { resolveOpenAIKeyConfig } from "./lib/live-config.mjs";
import {
  loadPriceCard,
  loadScenarioPack,
  validatePriceCard,
  validateScenarioPack,
} from "./lib/experiment-inputs.mjs";
import { writeArtifactPackage } from "./lib/report.mjs";
import { runWindTunnel } from "./lib/runner.mjs";
import { ensureInside } from "./lib/util.mjs";
import {
  validateBlueprint,
  validatePolicy,
  validateScenario,
} from "./lib/validate.mjs";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = packageRoot;
const RESERVED_WORKSPACE_OUTPUT_ROOTS = new Set([
  ".git",
  ".github",
  "baselines",
  "docs",
  "examples",
  "lib",
  "node_modules",
  "price-cards",
  "scenarios",
  "schemas",
  "scripts",
  "test",
]);
const packageVersion = JSON.parse(
  fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
).version;
const BOOLEAN_OPTIONS = new Set([
  "confirm-live",
  "dry-run",
  "help",
  "pro",
  "version",
]);
const GLOBAL_OPTIONS = new Set(["help", "version"]);
const COMMAND_OPTIONS = Object.freeze({
  demo: new Set(["help", "output", "scenario-pack", "version"]),
  inspect: new Set(["help", "version"]),
  run: new Set([
    "adapter",
    "candidates",
    "confirm-live",
    "dry-run",
    "effort",
    "help",
    "key-env-file",
    "max-live-calls",
    "max-live-spend-usd",
    "model",
    "output",
    "price-card",
    "pro",
    "repetitions",
    "scenario",
    "scenario-pack",
    "timeout",
    "version",
  ]),
  validate: new Set(["help", "price-card", "scenario-pack", "version"]),
  help: new Set(["help", "version"]),
});

function trustedFixtureApprovalProviderFactory({ scenario }) {
  return createFixtureApprovalProvider({
    granted: scenario.fixture.approvalGranted === true,
  });
}

export function parseArgs(argv) {
  const result = { _: [] };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "-h" || value === "-V") {
      const name = value === "-h" ? "help" : "version";
      if (seen.has(name)) throw new Error(`Duplicate option --${name}.`);
      result[name] = true;
      seen.add(name);
      continue;
    }
    if (value === "--") {
      throw new Error("Positional arguments after -- are not supported.");
    }
    if (!value.startsWith("--")) {
      if (value.startsWith("-")) throw new Error(`Unknown short option ${value}.`);
      result._.push(value);
      continue;
    }
    const option = value.slice(2);
    const equalsAt = option.indexOf("=");
    const rawName = equalsAt === -1 ? option : option.slice(0, equalsAt);
    const inlineValue = equalsAt === -1 ? null : option.slice(equalsAt + 1);
    if (!/^[a-z][a-z0-9-]*$/.test(rawName)) {
      throw new Error(`Invalid option name --${rawName}.`);
    }
    if (seen.has(rawName)) throw new Error(`Duplicate option --${rawName}.`);
    seen.add(rawName);
    if (inlineValue != null) {
      result[rawName] = inlineValue;
      continue;
    }
    if (BOOLEAN_OPTIONS.has(rawName)) {
      result[rawName] = true;
    } else if (argv[index + 1] != null && !argv[index + 1].startsWith("--")) {
      result[rawName] = argv[index + 1];
      index += 1;
    } else {
      result[rawName] = true;
    }
  }
  return result;
}

function commandFromArgs(args) {
  const command = args._[0] ?? "demo";
  if (args._.length > 1) {
    throw new Error(`Unexpected positional arguments: ${args._.slice(1).join(", ")}.`);
  }
  if (!COMMAND_OPTIONS[command]) {
    throw new Error(`Unknown command ${command}. Run help for usage.`);
  }
  return command;
}

function validateOptions(args, command) {
  const allowed = COMMAND_OPTIONS[command] ?? GLOBAL_OPTIONS;
  const unknown = Object.keys(args).filter((name) => name !== "_" && !allowed.has(name));
  if (unknown.length) {
    throw new Error(`Unknown option(s) for ${command}: ${unknown.map((name) => `--${name}`).join(", ")}.`);
  }
  for (const name of Object.keys(args)) {
    if (name === "_" || BOOLEAN_OPTIONS.has(name)) continue;
    if (args[name] === true || String(args[name]).length === 0) {
      throw new Error(`--${name} requires a value.`);
    }
  }
}

function booleanOption(args, name) {
  const value = args[name];
  if (value == null) return false;
  if (value === true || value === "true") return true;
  if (value === "false") return false;
  throw new Error(`--${name} must be true or false when a value is supplied.`);
}

function integerOption(args, name, defaultValue, minimum, maximum) {
  const value = Number(args[name] ?? defaultValue);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function numberOption(args, name, defaultValue, minimum, maximum) {
  if (args[name] == null) return defaultValue;
  const value = Number(args[name]);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} must be a number from ${minimum} to ${maximum}.`);
  }
  return value;
}

function stringOption(args, name, defaultValue) {
  const value = String(args[name] ?? defaultValue);
  if (!value.trim()) throw new Error(`--${name} must not be empty.`);
  return value;
}

function selectById(items, rawIds, label) {
  if (!rawIds) return items;
  const ids = new Set(String(rawIds).split(",").map((value) => value.trim()).filter(Boolean));
  const selected = items.filter((item) => ids.has(item.id));
  const missing = [...ids].filter((id) => !items.some((item) => item.id === id));
  if (missing.length) throw new Error(`Unknown ${label}: ${missing.join(", ")}.`);
  return selected;
}

function createExecutionId() {
  const timestamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14);
  return `awt-${timestamp}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export function buildLiveCallPlan({
  blueprints,
  scenarios,
  repetitions,
  maximumAllowed,
  pricing = null,
  maximumSpendUsd = null,
}) {
  const entries = [];
  let upperBound = 0;
  let spendUpperBoundUsd = 0;
  const maximumRate = pricing
    ? Math.max(
        pricing.model.inputUsdPerMillionTokens,
        pricing.model.cachedInputUsdPerMillionTokens,
        pricing.model.cacheWriteInputUsdPerMillionTokens,
        pricing.model.outputUsdPerMillionTokens,
      )
    : null;
  for (const scenario of scenarios) {
    for (const blueprint of blueprints) {
      const perRepetition = Math.min(
        blueprint.budgets.maxModelCalls,
        scenario.slo.maximumModelCalls,
      );
      const calls = perRepetition * repetitions;
      const tokenBudget = blueprint.budgets.maxTokenUnits * repetitions;
      const spendUsd = pricing
        ? (tokenBudget * maximumRate) / 1_000_000
        : null;
      upperBound += calls;
      spendUpperBoundUsd += spendUsd ?? 0;
      entries.push({
        scenarioId: scenario.id,
        blueprintId: blueprint.id,
        perRepetition,
        repetitions,
        calls,
        tokenBudget,
        spendUsd,
      });
    }
  }
  spendUpperBoundUsd = pricing
    ? Math.ceil(spendUpperBoundUsd * 1_000_000) / 1_000_000
    : null;
  return {
    entries,
    upperBound,
    maximumAllowed,
    withinLimit: upperBound <= maximumAllowed,
    spendUpperBoundUsd,
    maximumSpendUsd,
    withinSpendLimit:
      pricing && maximumSpendUsd != null
        ? spendUpperBoundUsd <= maximumSpendUsd
        : null,
    pricingMethod: pricing
      ? "Declared per-run token budgets priced at the card's highest exact-model token rate."
      : null,
  };
}

function livePlanText({
  plan,
  model,
  effort,
  pro,
  timeoutMs,
  credentialSource,
  dryRun,
  confirmed,
}) {
  const mode = dryRun
    ? "dry run (zero API calls)"
    : confirmed
      ? "confirmed live execution"
      : "live execution pending explicit confirmation";
  const lines = [
    "",
    "AGENT WIND TUNNEL — LIVE CALL PLAN",
    "=".repeat(72),
    `Mode: ${mode}`,
    `Model: ${model}`,
    `Reasoning: ${effort}${pro ? " + pro mode" : ""}`,
    `Timeout per call: ${timeoutMs} ms`,
    `Credential source: ${credentialSource}`,
    "",
    "Maximum call envelope:",
  ];
  for (const entry of plan.entries) {
    lines.push(
      `  ${entry.scenarioId} × ${entry.blueprintId}: ${entry.calls} ` +
        `(${entry.perRepetition}/repetition × ${entry.repetitions})` +
        (entry.spendUsd == null
          ? ""
          : ` · conservative spend ${entry.spendUsd.toFixed(6)} USD`),
    );
  }
  lines.push(
    "",
    `Upper bound: ${plan.upperBound} calls`,
    `Configured live-call ceiling: ${plan.maximumAllowed}`,
    `Ceiling check: ${plan.withinLimit ? "PASS" : "BLOCKED"}`,
    ...(plan.spendUpperBoundUsd == null
      ? ["Spend envelope: unavailable without --price-card"]
      : [
          `Conservative spend envelope: ${plan.spendUpperBoundUsd.toFixed(6)} USD`,
          `Configured live-spend ceiling: ${
            plan.maximumSpendUsd == null
              ? "NOT SUPPLIED"
              : `${plan.maximumSpendUsd.toFixed(6)} USD`
          }`,
          `Spend ceiling check: ${
            plan.withinSpendLimit == null
              ? "NOT EVALUATED"
              : plan.withinSpendLimit
                ? "PASS"
                : "BLOCKED"
          }`,
          `Spend method: ${plan.pricingMethod}`,
        ]),
    "The upper bound is conservative; an accepted run may stop earlier.",
  );
  return lines.join("\n");
}

function summary(results) {
  const lines = [
    "",
    "AGENT WIND TUNNEL",
    "=".repeat(72),
    `Mode: ${results.provenance.mode} (${results.provenance.deterministic ? "deterministic fixture" : "live empirical"})`,
    "",
  ];
  for (const recommendation of results.recommendations) {
    const scenario = results.scenarios.find((item) => item.id === recommendation.scenarioId);
    lines.push(
      `${scenario.label.padEnd(38)} ${recommendation.blueprintId ?? recommendation.status}`,
    );
  }
  lines.push(
    "",
    `Whole corpus: ${results.portfolioRecommendation.blueprintId ?? results.portfolioRecommendation.status}`,
    `Claim boundary: ${
      results.provenance.scenarioPack?.claimBoundary.statement ??
      results.provenance.claim
    }`,
  );
  return lines.join("\n");
}

export function resolveWorkspaceOutput(
  candidate,
  workspaceRoot = process.cwd(),
) {
  const root = path.resolve(workspaceRoot);
  const target = ensureInside(
    root,
    path.resolve(workspaceRoot, String(candidate)),
  );
  const relative = path.relative(root, target);
  const [outputRoot] = relative.split(path.sep);
  if (
    relative === "" ||
    RESERVED_WORKSPACE_OUTPUT_ROOTS.has(outputRoot)
  ) {
    throw Object.assign(
      new Error(
        `Output must use a dedicated generated directory inside ${root}: ${target}`,
      ),
      { code: "UNSAFE_OUTPUT_PATH" },
    );
  }
  return target;
}

async function demo(args) {
  const blueprints = buildBlueprints(projectRoot);
  const scenarioPack = args["scenario-pack"]
    ? loadScenarioPack(String(args["scenario-pack"]), {
        candidateIds: blueprints.map((item) => item.id),
      })
    : null;
  const scenarios = scenarioPack?.scenarios ?? buildScenarios();
  const adapter = new FixtureAdapter({ scenarios });
  const results = await runWindTunnel({
    blueprints,
    scenarios,
    adapter,
    policy: POLICY,
    repetitions: 1,
    mode: "fixture",
    approvalProviderFactory: trustedFixtureApprovalProviderFactory,
    scenarioPack,
  });
  const ablation = await runAblationStudy({
    blueprints,
    scenarios,
    adapter,
    policy: POLICY,
    approvalProviderFactory: trustedFixtureApprovalProviderFactory,
  });
  const workspaceRoot = process.cwd();
  const outputDir = resolveWorkspaceOutput(
    args.output === true || args.output == null
      ? "wind-tunnel-output/fixture"
      : String(args.output),
    workspaceRoot,
  );
  const written = writeArtifactPackage({
    results,
    ablation,
    outputDir,
    projectRoot: workspaceRoot,
  });
  console.log(summary(results));
  console.log(
    `\nFixture-feasible within-family ablation: ${
      ablation.recommendation.blueprintId ?? ablation.recommendation.status
    }`,
  );
  console.log(`Report: ${path.join(written.outputDir, "report.html")}`);
  if (!results.fixtureExpectationsPassed) {
    throw new Error("Fixture recommendations no longer match the declared calibration cases.");
  }
}

function inspect() {
  const blueprints = buildBlueprints(projectRoot);
  console.log("\nAGENT WIND TUNNEL — BLUEPRINT INSPECTION");
  console.log("=".repeat(72));
  for (const blueprint of blueprints) {
    const result = validateBlueprint(blueprint, POLICY);
    console.log(
      `${blueprint.id.padEnd(24)} valid  nodes=${String(result.nodeCount).padStart(2)} edges=${String(result.edgeCount).padStart(2)} cycles=${result.cycleCount}`,
    );
  }
  const graph = blueprints.find((item) => item.id === "graph-max-governed");
  console.log(`\nGraph source SHA-256: ${graph.source.derivedFrom.sha256}`);
  console.log(`Observed roles: ${graph.source.derivedFrom.inspection.observedRoles.join(", ")}`);
  const transforms = graph.source.transforms ?? {};
  console.log(
    `Retained source roles: ${(transforms.retainedSourceRoles ?? []).join(", ") || "none recorded"}`,
  );
  console.log(
    `Added runtime nodes: ${(transforms.addedRuntimeNodes ?? []).join(", ") || "none recorded"}`,
  );
  console.log(
    `Omitted source roles: ${(transforms.omittedSourceRoles ?? []).join(", ") || "none"}`,
  );
  console.log(`Ablation variants: ${buildAblationBlueprints(blueprints).length}`);
}

function validateInputs(args) {
  const blueprints = buildBlueprints(projectRoot);
  const candidateIds = blueprints.map((item) => item.id);
  const policy = validatePolicy(POLICY);
  const scenarioPack = args["scenario-pack"]
    ? loadScenarioPack(String(args["scenario-pack"]), { candidateIds })
    : null;
  const scenarios = scenarioPack?.scenarios ?? buildScenarios();
  const scenarioValidations = scenarios.map(validateScenario);
  const blueprintValidations = blueprints.map((blueprint) =>
    validateBlueprint(blueprint, POLICY),
  );
  const priceCard = args["price-card"]
    ? loadPriceCard(String(args["price-card"]))
    : null;
  if (scenarioPack) validateScenarioPack(scenarioPack.pack, candidateIds);
  if (priceCard) validatePriceCard(priceCard.card);

  console.log("\nAGENT WIND TUNNEL — INPUT VALIDATION");
  console.log("=".repeat(72));
  console.log(
    `Policy: valid (${policy.capabilityCount} capabilities, ${policy.initialGrantCount} initial grants)`,
  );
  console.log(`Blueprints: valid (${blueprintValidations.length})`);
  console.log(
    `Scenarios: valid (${scenarioValidations.length})${scenarioPack ? ` · pack=${scenarioPack.validation.id} · sha256=${scenarioPack.source.sha256}` : " · built-in"}`,
  );
  if (scenarioPack) {
    console.log(
      `Claim boundary: ${scenarioPack.pack.claimBoundary.evaluationUse} · source=${scenarioPack.pack.provenance.sourceType} · synthetic/composite=${scenarioPack.pack.claimBoundary.syntheticOrComposite}`,
    );
  }
  if (priceCard) {
    console.log(
      `Price card: valid (${priceCard.validation.modelCount} models, ${priceCard.card.currency}, effective ${priceCard.card.effectiveDate}, tier=${priceCard.card.provenance.serviceTier}/${priceCard.card.provenance.contextTier}) · sha256=${priceCard.source.sha256}`,
    );
  } else {
    console.log("Price card: not supplied");
  }
}

async function run(args) {
  const adapterName = stringOption(args, "adapter", "fixture");
  if (adapterName === "fixture") {
    const suppliedLiveOptions = [
      "candidates",
      "confirm-live",
      "dry-run",
      "effort",
      "key-env-file",
      "max-live-calls",
      "max-live-spend-usd",
      "model",
      "price-card",
      "pro",
      "repetitions",
      "scenario",
      "timeout",
    ].filter((name) => args[name] != null);
    if (suppliedLiveOptions.length) {
      throw new Error(
        `Live option(s) require --adapter openai: ${suppliedLiveOptions.map((name) => `--${name}`).join(", ")}.`,
      );
    }
    return demo(args);
  }
  if (adapterName !== "openai") throw new Error(`Unsupported adapter ${adapterName}.`);

  const allBlueprints = buildBlueprints(projectRoot);
  const scenarioPack = args["scenario-pack"]
    ? loadScenarioPack(String(args["scenario-pack"]), {
        candidateIds: allBlueprints.map((item) => item.id),
      })
    : null;
  const allScenarios = scenarioPack?.scenarios ?? buildScenarios();
  const blueprints = selectById(
    allBlueprints,
    args.candidates ?? "direct,loop,parallel-review,graph-max-governed",
    "candidate",
  );
  const scenarios = selectById(
    allScenarios,
    args.scenario ?? (scenarioPack ? null : "operator-doc-gap"),
    "scenario",
  );
  const repetitions = integerOption(args, "repetitions", 3, 1, 10);
  const maximumLiveCalls = integerOption(args, "max-live-calls", 40, 1, 10_000);
  const timeoutMs = integerOption(args, "timeout", 120_000, 1_000, 600_000);
  const model = stringOption(args, "model", "gpt-5.6-terra");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(model)) {
    throw new Error("--model contains unsupported characters or is too long.");
  }
  const reasoningEffort = stringOption(args, "effort", "medium");
  const allowedEfforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
  if (!allowedEfforts.has(reasoningEffort)) {
    throw new Error("--effort must be one of: none, minimal, low, medium, high, xhigh, max.");
  }
  const pro = booleanOption(args, "pro");
  const priceCard = args["price-card"]
    ? loadPriceCard(String(args["price-card"]), { modelId: model })
    : null;
  const maximumLiveSpendUsd = numberOption(
    args,
    "max-live-spend-usd",
    null,
    0.000001,
    1_000_000,
  );
  if (maximumLiveSpendUsd != null && !priceCard) {
    throw new Error("--max-live-spend-usd requires --price-card.");
  }
  const dryRun = booleanOption(args, "dry-run");
  const confirmed = booleanOption(args, "confirm-live");
  if (dryRun && confirmed) {
    throw new Error("--dry-run and --confirm-live are mutually exclusive.");
  }
  const plan = buildLiveCallPlan({
    blueprints,
    scenarios,
    repetitions,
    maximumAllowed: maximumLiveCalls,
    pricing: priceCard,
    maximumSpendUsd: maximumLiveSpendUsd,
  });
  const credentialSource = args["key-env-file"] ? "key-env-file" : "environment";
  console.log(
    livePlanText({
      plan,
      model,
      effort: reasoningEffort,
      pro,
      timeoutMs,
      credentialSource: `${credentialSource}${dryRun || !confirmed ? " (not read)" : ""}`,
      dryRun,
      confirmed,
    }),
  );
  if (priceCard) {
    console.log(
      `Price card: ${priceCard.source.name} · ${priceCard.card.currency} · effective ${priceCard.card.effectiveDate} · ${priceCard.card.provenance.serviceTier}/${priceCard.card.provenance.contextTier} · exact model match`,
    );
  }
  if (dryRun) return;
  if (!confirmed) {
    throw Object.assign(
      new Error(
        "No API calls were made. Inspect with --dry-run or explicitly authorize this bounded run with --confirm-live.",
      ),
      { code: "LIVE_CONFIRMATION_REQUIRED" },
    );
  }
  const executionId = createExecutionId();
  const workspaceRoot = process.cwd();
  const outputDir = resolveWorkspaceOutput(
    args.output == null
      ? `wind-tunnel-output/live-${model.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}/${executionId}`
      : path.join(String(args.output), executionId),
    workspaceRoot,
  );
  if (!plan.withinLimit) {
    throw Object.assign(
      new Error(
        `The ${plan.upperBound}-call envelope exceeds --max-live-calls=${maximumLiveCalls}. Select fewer cases/repetitions or explicitly raise the ceiling.`,
      ),
      { code: "LIVE_CALL_LIMIT_EXCEEDED" },
    );
  }
  if (!priceCard || maximumLiveSpendUsd == null) {
    throw Object.assign(
      new Error(
        "Confirmed live execution requires --price-card and an explicit --max-live-spend-usd. No credentials were read.",
      ),
      { code: "LIVE_SPEND_GUARD_REQUIRED" },
    );
  }
  if (!plan.withinSpendLimit) {
    throw Object.assign(
      new Error(
        `The conservative ${plan.spendUpperBoundUsd.toFixed(6)} USD envelope exceeds --max-live-spend-usd=${maximumLiveSpendUsd}. Select fewer cases/repetitions or explicitly raise the cap.`,
      ),
      { code: "LIVE_SPEND_LIMIT_EXCEEDED" },
    );
  }
  const keyConfig = resolveOpenAIKeyConfig({
    environment: process.env,
    envFile: args["key-env-file"] ? String(args["key-env-file"]) : null,
    workspaceRoot: process.cwd(),
  });
  const [{ OpenAIAdapter }] = await Promise.all([import("./lib/openai-adapter.mjs")]);
  const adapter = new OpenAIAdapter({
    apiKey: keyConfig.apiKey,
    model,
    reasoningEffort,
    reasoningMode: pro ? "pro" : null,
    timeoutMs,
    executionId,
    credentialSource: keyConfig.source,
  });
  const results = await runWindTunnel({
    blueprints,
    scenarios,
    adapter,
    policy: POLICY,
    repetitions,
    mode: "live",
    includeExpectedFixtureChecks: false,
    executionId,
    pricing: priceCard,
    scenarioPack,
  });
  results.provenance.executionId = executionId;
  results.provenance.adapterConfig = {
    provider: "openai",
    model,
    reasoningEffort,
    reasoningMode: pro ? "pro" : null,
    timeoutMs,
    promptCacheMode: "explicit-no-breakpoint",
    credentialSource: keyConfig.source,
    maximumLiveCalls,
    plannedCallUpperBound: plan.upperBound,
    maximumLiveSpendUsd,
    plannedSpendUpperBoundUsd: plan.spendUpperBoundUsd,
    scenarioPack: scenarioPack?.source ?? null,
  };
  const written = writeArtifactPackage({
    results,
    outputDir,
    projectRoot: workspaceRoot,
  });
  console.log(summary(results));
  console.log(`\nReport: ${path.join(written.outputDir, "report.html")}`);
}

export function helpText() {
  const candidates = buildBlueprints(projectRoot).map((item) => item.id).join(", ");
  const scenarios = buildScenarios().map((item) => item.id).join(", ");
  return `
Agent Wind Tunnel v${packageVersion}

Usage:
  node agent-wind-tunnel.mjs demo [--output wind-tunnel-output/fixture]
  node agent-wind-tunnel.mjs inspect
  node agent-wind-tunnel.mjs validate [--scenario-pack path] [--price-card path]
  node agent-wind-tunnel.mjs run --adapter openai --dry-run [options]
  node agent-wind-tunnel.mjs run --adapter openai --confirm-live [options]
  node agent-wind-tunnel.mjs --version

Live options:
  --scenario <id[,id]>       Default: operator-doc-gap; all cases in a supplied pack
  --scenario-pack <path>     Replace built-in cases with a validated JSON pack
  --candidates <id[,id]>     Default: all four canonical candidates
  --repetitions <1..10>      Default: 3
  --model <model-id>         Default: gpt-5.6-terra
  --effort <level>           none|minimal|low|medium|high|xhigh|max
  --timeout <ms>             1000..600000; default: 120000
  --key-env-file <path>      Read OPENAI_API_KEY without printing it
  --pro                      Enable GPT-5.6 pro mode as an explicit experiment
  --dry-run                  Print the bounded call plan; make zero API calls
  --confirm-live             Explicitly authorize the planned API calls
  --max-live-calls <n>       Hard call-envelope ceiling; default: 40
  --price-card <path>        Add versioned, exact-model cost estimates
  --max-live-spend-usd <n>   Required explicit spend cap for confirmed live runs
  --output <directory>       Base directory; execution ID is appended

Candidate IDs:
  ${candidates}

Scenario IDs:
  ${scenarios}

Boolean flags accept =true or =false. Unknown flags and extra arguments fail.
`;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const command = commandFromArgs(args);
    validateOptions(args, command);
    if (booleanOption(args, "version")) {
      console.log(packageVersion);
    } else if (booleanOption(args, "help") || command === "help") {
      console.log(helpText());
    } else if (command === "demo") {
      await demo(args);
    } else if (command === "inspect") {
      inspect(args);
    } else if (command === "validate") {
      validateInputs(args);
    } else if (command === "run") {
      await run(args);
    }
    return 0;
  } catch (error) {
    console.error(`Agent Wind Tunnel failed [${error.code ?? error.name ?? "ERROR"}]: ${error.message}`);
    return 1;
  }
}

export function isCliEntrypoint(
  invokedPath,
  moduleUrl = import.meta.url,
) {
  if (!invokedPath) return false;
  const modulePath = fileURLToPath(moduleUrl);
  try {
    return fs.realpathSync(invokedPath) === fs.realpathSync(modulePath);
  } catch {
    return path.resolve(invokedPath) === path.resolve(modulePath);
  }
}

if (isCliEntrypoint(process.argv[1])) {
  process.exitCode = await main();
}
