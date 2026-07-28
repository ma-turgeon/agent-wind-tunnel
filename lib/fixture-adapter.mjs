import { canonicalHash, uniqueSorted } from "./util.mjs";
import {
  checkRequirement,
  materializeRequirement,
  mergeArtifactMaterial,
} from "./checks.mjs";

const USAGE = {
  planner: { tokenUnits: 700, latencyTicks: 7 },
  "plan-reviewer": { tokenUnits: 420, latencyTicks: 4 },
  worker: { tokenUnits: 1_200, latencyTicks: 12 },
  "reviewer:general": { tokenUnits: 420, latencyTicks: 4 },
  "reviewer:correctness": { tokenUnits: 480, latencyTicks: 5 },
  "reviewer:security": { tokenUnits: 520, latencyTicks: 5 },
  "reviewer:task-fidelity": { tokenUnits: 440, latencyTicks: 4 },
  synthesizer: { tokenUnits: 360, latencyTicks: 3 },
  presenter: { tokenUnits: 280, latencyTicks: 3 },
};

function finding(requirementId, role) {
  return {
    requirementId,
    severity: "error",
    message: `${role} found missing evidence for ${requirementId}.`,
  };
}

function coveredIds(scenario, artifact) {
  return scenario.requirements
    .filter((requirement) => checkRequirement(requirement, artifact).passed)
    .map((requirement) => requirement.id);
}

function materialFor(scenario, requirementIds) {
  return requirementIds
    .map((id) => scenario.requirements.find((requirement) => requirement.id === id))
    .filter(Boolean)
    .reduce(
      (artifact, requirement) =>
        mergeArtifactMaterial(artifact, materializeRequirement(requirement)),
      { facts: [], sections: [], testCases: [] },
    );
}

function fixtureArtifact(scenario, covered, previousArtifact = null) {
  const material = materialFor(scenario, covered);
  const base = previousArtifact ?? {
    title: `${scenario.label} artifact`,
    summary: "",
    evidence: [],
    facts: [],
    sections: [],
    testCases: [],
  };
  const merged = mergeArtifactMaterial(base, material);
  return {
    ...merged,
    title: `${scenario.label} artifact`,
    summary: `Fixture artifact for ${scenario.id}; materialized ${covered.length}/${scenario.requirements.length} deterministic checks.`,
    evidence: uniqueSorted([
      ...(base.evidence ?? []).map((item) => item.requirementId),
      ...covered,
    ]).map((requirementId) => ({
      requirementId,
      detail: `Fixture material supplied for deterministic check ${requirementId}.`,
    })),
  };
}

export class FixtureAdapter {
  constructor({ scenarios, faults = {} }) {
    this.scenarios = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
    this.faults = faults;
    this.kind = "fixture";
    this.deterministic = true;
    this.experimentConfiguration = {
      kind: this.kind,
      deterministic: this.deterministic,
      faultsHash: canonicalHash(faults),
    };
  }

  async invoke(context) {
    const scenario = this.scenarios.get(context.scenarioId);
    if (!scenario) throw Object.assign(new Error(`Unknown fixture scenario ${context.scenarioId}.`), { code: "FIXTURE_NOT_FOUND" });
    const faultKey = `${context.scenarioId}:${context.blueprintId}:${context.role}:${context.attempt}`;
    const generalFaultKey = `${context.scenarioId}:${context.role}:${context.attempt}`;
    const fault = this.faults[faultKey] ?? this.faults[generalFaultKey];
    if (fault === "timeout") {
      throw Object.assign(new Error(`Injected timeout at ${context.role}.`), {
        code: "TIMEOUT",
        retryable: true,
      });
    }
    if (fault === "malformed") {
      return {
        callId: `fixture-${canonicalHash([context.attemptId, "malformed"]).slice(0, 16)}`,
        model: "fixture-model",
        output: { malformed: true },
        usage: USAGE[context.role] ?? { tokenUnits: 100, latencyTicks: 1 },
      };
    }

    const allRequirementIds = scenario.requirements.map((item) => item.id);
    let output;
    if (context.role === "planner") {
      const hasFeedback = (context.input.feedback ?? []).length > 0;
      const omitted = hasFeedback ? [] : scenario.fixture.planOmissions;
      output = {
        coveredRequirementIds: allRequirementIds.filter((id) => !omitted.includes(id)),
        risks: scenario.riskTier === "consequential" ? ["consequential-effect", "rollback"] : [],
        notes: hasFeedback ? "Revised deterministic fixture plan." : "Initial deterministic fixture plan.",
      };
    } else if (context.role === "plan-reviewer") {
      const covered = new Set(context.input.plan.coveredRequirementIds);
      const missing = allRequirementIds.filter((id) => !covered.has(id));
      output = {
        verdict: missing.length ? "revise" : "approve",
        findings: missing.map((id) => finding(id, context.role)),
      };
    } else if (context.role === "worker") {
      let covered;
      if (context.input.previousArtifact) {
        const repaired = (context.input.feedback ?? [])
          .map((item) => item.requirementId)
          .filter(Boolean);
        covered = uniqueSorted([
          ...coveredIds(scenario, context.input.previousArtifact),
          ...repaired,
        ]);
      } else {
        const planMissing = context.input.plan
          ? allRequirementIds.filter((id) => !context.input.plan.coveredRequirementIds.includes(id))
          : scenario.fixture.planOmissions;
        const missing = new Set([
          ...scenario.fixture.initialArtifactDefects,
          ...planMissing,
        ]);
        covered = allRequirementIds.filter((id) => !missing.has(id));
      }
      output = {
        artifact: fixtureArtifact(
          scenario,
          covered,
          context.input.previousArtifact ?? null,
        ),
        evidence: [`fixture:${context.scenarioId}`, `attempt:${context.attempt}`],
      };
    } else if (context.role.startsWith("reviewer:")) {
      const rubric = context.role.slice("reviewer:".length);
      const detectors = scenario.fixture.detectors[rubric] ?? [];
      const covered = new Set(coveredIds(scenario, context.input.artifact));
      const missing = detectors.filter((id) => !covered.has(id));
      output = {
        verdict: missing.length ? "revise" : "pass",
        findings: missing.map((id) => finding(id, context.role)),
      };
    } else if (context.role === "synthesizer") {
      const findings = context.input.findings ?? [];
      output = {
        verdict: findings.length ? "revise" : "pass",
        findings,
      };
    } else if (context.role === "presenter") {
      output = {
        summary: `${scenario.label} completed under ${context.blueprintId}.`,
        recommendation: "Use the smallest topology that continues to satisfy the declared SLOs.",
      };
    } else {
      throw Object.assign(new Error(`Fixture adapter does not implement ${context.role}.`), {
        code: "ROLE_NOT_IMPLEMENTED",
      });
    }

    return {
      callId: `fixture-${canonicalHash([context.attemptId, output]).slice(0, 16)}`,
      model: "fixture-model",
      output,
      usage: {
        ...(USAGE[context.role] ?? { tokenUnits: 100, latencyTicks: 1 }),
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        latencyMs: 0,
      },
    };
  }
}
