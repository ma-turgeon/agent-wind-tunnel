import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  deepClone,
  deepFreeze,
  sha256,
} from "./util.mjs";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const POLICY = Object.freeze({
  schemaVersion: "agent-wind-tunnel.policy/v1",
  capabilityCatalog: [
    {
      id: "workspace.read",
      effectClass: "observe",
      allowedScopes: ["workspace"],
      approval: "none",
    },
    {
      id: "workspace.write",
      effectClass: "reversible-local",
      allowedScopes: ["workspace"],
      approval: "none",
    },
    {
      id: "deploy.production",
      effectClass: "consequential",
      allowedScopes: ["demo-service"],
      approval: "explicit-human",
    },
  ],
  initialGrants: [
    { capability: "workspace.read", scopes: ["workspace"] },
    { capability: "workspace.write", scopes: ["workspace"] },
  ],
});

const modelNode = (id, role, options = {}) => ({
  id,
  kind: "model",
  role,
  thread: options.thread ?? "ephemeral",
  inputContract: `${role}.input/v1`,
  outputContract: `${role}.output/v1`,
  capabilities: options.capabilities ?? [
    { capability: "workspace.read", scopes: ["workspace"] },
  ],
  maxVisits: options.maxVisits ?? 1,
  tags: options.tags ?? [],
  origin: options.origin ?? "wind-tunnel",
});

const deterministicNode = (id, tags = []) => ({
  id,
  kind: "deterministic",
  role: id,
  thread: "none",
  inputContract: `${id}.input/v1`,
  outputContract: `${id}.output/v1`,
  capabilities: [],
  maxVisits: 3,
  tags,
  origin: "wind-tunnel",
});

const terminalNode = (id) => ({
  id,
  kind: "terminal",
  role: id,
  thread: "none",
  inputContract: null,
  outputContract: null,
  capabilities: [],
  maxVisits: 1,
  tags: [],
  origin: "wind-tunnel",
});

const edge = (id, from, to, outcomes, maxTraversals = 1) => ({
  id,
  from,
  to,
  when: { outcomeIn: outcomes },
  maxTraversals,
});

function commonBlueprint({
  id,
  label,
  nodes,
  edges,
  features,
  budgets,
  source,
  entryNode = "worker",
  terminalNodes = ["accept", "reject", "escalate"],
}) {
  return {
    schemaVersion: "agent-wind-tunnel.blueprint/v1",
    id,
    label,
    source,
    entryNode,
    terminalNodes,
    stateContract: "agent-wind-tunnel.state/v1",
    budgets: {
      maxNodeVisits: 40,
      maxModelCalls: 20,
      maxTokenUnits: 80_000,
      maxLatencyTicks: 2_000,
      maxRetries: 1,
      ...budgets,
    },
    nodes,
    edges,
    features: {
      planning: false,
      planReview: false,
      speculativeWorker: false,
      reviewers: [],
      modelSynthesis: false,
      presenter: false,
      approvalGate: false,
      effectNode: false,
      maxRepairRounds: 0,
      ...features,
    },
  };
}

function graphSourceEvidence(workspaceRoot) {
  const relativeFile = path.join("examples", "graph-max-reference.mjs");
  const file = path.join(workspaceRoot, relativeFile);
  const source = fs.readFileSync(file, "utf8");
  const expectedRoles = [
    "planner",
    "plan-reviewer",
    "worker",
    "reviewer:structure",
    "reviewer:correctness",
    "reviewer:task-fidelity",
    "synthesizer",
    "presenter",
  ];
  const observedRoles = expectedRoles.filter((role) => {
    if (source.includes(`"${role}"`)) return true;
    if (!role.startsWith("reviewer:")) return false;
    const rubric = role.slice("reviewer:".length);
    return (
      source.includes(`"${rubric}"`) &&
      source.includes("reviewer:${rubric}")
    );
  });
  return {
    files: [relativeFile.split(path.sep).join("/")],
    sha256: sha256(source),
    inspection: {
      kind: "bounded-source-pattern-scan",
      observedRoles,
      observesParallelJoin: source.includes("Promise.all"),
      observesPlanBudget: source.includes("maxPlanRounds"),
      observesWorkBudget: source.includes("maxWorkRounds"),
    },
  };
}

export function buildBlueprints(workspaceRoot = packageRoot) {
  const source = graphSourceEvidence(workspaceRoot);
  const terminals = [terminalNode("accept"), terminalNode("reject"), terminalNode("escalate")];

  const direct = commonBlueprint({
    id: "direct",
    label: "Direct agent + deterministic gate",
    source: { kind: "wind-tunnel-canonical", derivedFrom: source },
    nodes: [
      modelNode("worker", "worker", {
        thread: "persistent",
        capabilities: [
          { capability: "workspace.read", scopes: ["workspace"] },
          { capability: "workspace.write", scopes: ["workspace"] },
        ],
      }),
      deterministicNode("verifier", ["quality-gate"]),
      ...terminals,
    ],
    edges: [
      edge("worker-verifier", "worker", "verifier", ["completed"]),
      edge("verifier-accept", "verifier", "accept", ["pass"]),
      edge("verifier-reject", "verifier", "reject", ["fail"]),
      edge("verifier-escalate", "verifier", "escalate", ["authority-required"]),
    ],
    features: {},
    budgets: { maxModelCalls: 2, maxTokenUnits: 8_000, maxLatencyTicks: 200 },
  });

  const loop = commonBlueprint({
    id: "loop",
    label: "Bounded evaluator–optimizer loop",
    source: { kind: "wind-tunnel-canonical", derivedFrom: source },
    nodes: [
      modelNode("worker", "worker", {
        thread: "persistent",
        maxVisits: 2,
        capabilities: [
          { capability: "workspace.read", scopes: ["workspace"] },
          { capability: "workspace.write", scopes: ["workspace"] },
        ],
      }),
      deterministicNode("verifier", ["quality-gate"]),
      modelNode("reviewer-general", "reviewer:general", { maxVisits: 2 }),
      deterministicNode("merge-feedback", ["deterministic-merge"]),
      ...terminals,
    ],
    edges: [
      edge("worker-verifier", "worker", "verifier", ["completed"], 2),
      edge("verifier-reviewer", "verifier", "reviewer-general", ["pass", "fail"], 2),
      edge("reviewer-merge", "reviewer-general", "merge-feedback", ["pass", "revise"], 2),
      edge("reviewer-reject", "reviewer-general", "reject", ["fatal"]),
      edge("merge-repair", "merge-feedback", "worker", ["revise"], 1),
      edge("merge-accept", "merge-feedback", "accept", ["pass"]),
      edge("merge-reject", "merge-feedback", "reject", ["budget-exhausted"]),
      edge("merge-escalate", "merge-feedback", "escalate", ["authority-required"]),
    ],
    features: { reviewers: ["general"], maxRepairRounds: 1 },
    budgets: { maxModelCalls: 4, maxTokenUnits: 20_000, maxLatencyTicks: 500 },
  });

  const parallel = commonBlueprint({
    id: "parallel-review",
    label: "Parallel specialist review",
    source: { kind: "wind-tunnel-canonical", derivedFrom: source },
    nodes: [
      modelNode("worker", "worker", {
        thread: "persistent",
        maxVisits: 2,
        capabilities: [
          { capability: "workspace.read", scopes: ["workspace"] },
          { capability: "workspace.write", scopes: ["workspace"] },
        ],
      }),
      deterministicNode("verifier", ["quality-gate"]),
      { ...deterministicNode("review-fork", ["fan-out"]), kind: "fork" },
      modelNode("reviewer-correctness", "reviewer:correctness", { maxVisits: 2 }),
      modelNode("reviewer-security", "reviewer:security", { maxVisits: 2 }),
      modelNode("reviewer-task-fidelity", "reviewer:task-fidelity", { maxVisits: 2 }),
      { ...deterministicNode("review-join", ["fan-in"]), kind: "join" },
      deterministicNode("merge-feedback", ["deterministic-merge"]),
      ...terminals,
    ],
    edges: [
      edge("worker-verifier", "worker", "verifier", ["completed"], 2),
      edge("verifier-fork", "verifier", "review-fork", ["pass", "fail"], 2),
      edge("fork-correctness", "review-fork", "reviewer-correctness", ["fork"], 2),
      edge("fork-security", "review-fork", "reviewer-security", ["fork"], 2),
      edge("fork-fidelity", "review-fork", "reviewer-task-fidelity", ["fork"], 2),
      edge("correctness-join", "reviewer-correctness", "review-join", ["pass", "revise"], 2),
      edge("security-join", "reviewer-security", "review-join", ["pass", "revise"], 2),
      edge("fidelity-join", "reviewer-task-fidelity", "review-join", ["pass", "revise"], 2),
      edge("correctness-reject", "reviewer-correctness", "reject", ["fatal"]),
      edge("security-reject", "reviewer-security", "reject", ["fatal"]),
      edge("fidelity-reject", "reviewer-task-fidelity", "reject", ["fatal"]),
      edge("join-merge", "review-join", "merge-feedback", ["joined"], 2),
      edge("merge-repair", "merge-feedback", "worker", ["revise"], 1),
      edge("merge-accept", "merge-feedback", "accept", ["pass"]),
      edge("merge-reject", "merge-feedback", "reject", ["budget-exhausted"]),
      edge("merge-escalate", "merge-feedback", "escalate", ["authority-required"]),
    ],
    features: {
      reviewers: ["correctness", "security", "task-fidelity"],
      maxRepairRounds: 1,
    },
    budgets: { maxModelCalls: 8, maxTokenUnits: 36_000, maxLatencyTicks: 800 },
  });

  const graph = commonBlueprint({
    id: "graph-max-governed",
    label: "Governed Graph Max",
    source: {
      kind: "source-derived-plus-governance-extension",
      derivedFrom: source,
      transforms: {
        retainedSourceRoles: [
          "planner",
          "plan-reviewer",
          "worker",
          "reviewer:structure",
          "reviewer:correctness",
          "reviewer:task-fidelity",
          "synthesizer",
          "presenter",
        ],
        addedRuntimeNodes: [
          "deterministic verifier",
          "explicit fork/join nodes",
          "reviewer:security",
          "accept/reject/escalate terminals",
          "explicit approval node",
          "brokered consequential effect simulator",
        ],
        omittedSourceRoles: [],
      },
    },
    entryNode: "planner",
    nodes: [
      modelNode("planner", "planner", { thread: "persistent", maxVisits: 2, origin: "graph-max-source" }),
      { ...deterministicNode("plan-fork", ["fan-out"]), kind: "fork", origin: "graph-max-source" },
      modelNode("plan-reviewer", "plan-reviewer", { maxVisits: 2, origin: "graph-max-source" }),
      modelNode("worker", "worker", {
        thread: "persistent",
        maxVisits: 3,
        capabilities: [
          { capability: "workspace.read", scopes: ["workspace"] },
          { capability: "workspace.write", scopes: ["workspace"] },
        ],
        origin: "graph-max-source",
      }),
      { ...deterministicNode("plan-join", ["fan-in"]), kind: "join", origin: "graph-max-source" },
      deterministicNode("verifier", ["quality-gate"]),
      { ...deterministicNode("review-fork", ["fan-out"]), kind: "fork", origin: "graph-max-source" },
      modelNode("reviewer-structure", "reviewer:structure", { maxVisits: 2, origin: "graph-max-source" }),
      modelNode("reviewer-correctness", "reviewer:correctness", { maxVisits: 2, origin: "graph-max-source" }),
      modelNode("reviewer-security", "reviewer:security", { maxVisits: 2 }),
      modelNode("reviewer-task-fidelity", "reviewer:task-fidelity", { maxVisits: 2, origin: "graph-max-source" }),
      { ...deterministicNode("review-join", ["fan-in"]), kind: "join", origin: "graph-max-source" },
      modelNode("synthesizer", "synthesizer", { maxVisits: 2, origin: "graph-max-source" }),
      {
        id: "approval",
        kind: "approval",
        role: "explicit-human-approval",
        thread: "broker-owned",
        inputContract: "approval.input/v1",
        outputContract: "approval.output/v1",
        capabilities: [],
        maxVisits: 1,
        tags: ["authority-gate"],
        origin: "wind-tunnel-governance-extension",
      },
      {
        id: "production-effect",
        kind: "effect",
        role: "deploy-demo-service",
        thread: "broker-owned",
        inputContract: "effect.input/v1",
        outputContract: "effect.output/v1",
        capabilities: [{ capability: "deploy.production", scopes: ["demo-service"] }],
        maxVisits: 1,
        tags: ["consequential"],
        origin: "wind-tunnel-governance-extension",
      },
      modelNode("presenter", "presenter", { origin: "graph-max-source" }),
      ...terminals,
    ],
    edges: [
      edge("planner-plan-fork", "planner", "plan-fork", ["completed"], 2),
      edge("plan-fork-review", "plan-fork", "plan-reviewer", ["fork"], 2),
      edge("plan-fork-worker", "plan-fork", "worker", ["fork"], 2),
      edge("plan-review-revise", "plan-reviewer", "planner", ["revise"], 1),
      edge("plan-review-join", "plan-reviewer", "plan-join", ["approve"], 2),
      edge("plan-review-abort", "plan-reviewer", "reject", ["abort"]),
      edge("worker-plan-join", "worker", "plan-join", ["completed"], 3),
      edge("plan-join-verifier", "plan-join", "verifier", ["joined"], 2),
      edge("verifier-review-fork", "verifier", "review-fork", ["pass", "fail"], 2),
      edge("review-fork-structure", "review-fork", "reviewer-structure", ["fork"], 2),
      edge("review-fork-correctness", "review-fork", "reviewer-correctness", ["fork"], 2),
      edge("review-fork-security", "review-fork", "reviewer-security", ["fork"], 2),
      edge("review-fork-fidelity", "review-fork", "reviewer-task-fidelity", ["fork"], 2),
      edge("structure-review-join", "reviewer-structure", "review-join", ["pass", "revise"], 2),
      edge("correctness-review-join", "reviewer-correctness", "review-join", ["pass", "revise"], 2),
      edge("security-review-join", "reviewer-security", "review-join", ["pass", "revise"], 2),
      edge("fidelity-review-join", "reviewer-task-fidelity", "review-join", ["pass", "revise"], 2),
      edge("structure-review-reject", "reviewer-structure", "reject", ["fatal"]),
      edge("correctness-review-reject", "reviewer-correctness", "reject", ["fatal"]),
      edge("security-review-reject", "reviewer-security", "reject", ["fatal"]),
      edge("fidelity-review-reject", "reviewer-task-fidelity", "reject", ["fatal"]),
      edge("review-join-synthesis", "review-join", "synthesizer", ["joined"], 2),
      edge("synthesis-repair", "synthesizer", "worker", ["revise"], 1),
      edge("synthesis-approval", "synthesizer", "approval", ["pass"]),
      edge(
        "synthesis-nonconsequential-presenter",
        "synthesizer",
        "presenter",
        ["pass-no-effect"],
      ),
      edge("approval-effect", "approval", "production-effect", ["approved"]),
      edge("approval-escalate", "approval", "escalate", ["declined", "missing"]),
      edge("effect-presenter", "production-effect", "presenter", ["completed"]),
      edge("presenter-accept", "presenter", "accept", ["completed"]),
      edge("synthesis-reject", "synthesizer", "reject", ["budget-exhausted", "fatal"]),
    ],
    features: {
      planning: true,
      planReview: true,
      speculativeWorker: true,
      reviewers: ["structure", "correctness", "security", "task-fidelity"],
      modelSynthesis: true,
      presenter: true,
      approvalGate: true,
      effectNode: true,
      maxRepairRounds: 1,
    },
    budgets: { maxModelCalls: 20, maxTokenUnits: 80_000, maxLatencyTicks: 2_000 },
  });

  return [direct, loop, parallel, graph];
}

const factEquals = (factId, expected) => ({ kind: "fact_equals", factId, expected });
const sectionQuality = (
  sectionId,
  minimumCharacters,
  requiredTerms,
  {
    minimumUniqueWords = 24,
    minimumSentences = 4,
  } = {},
) => ({
  kind: "section_quality",
  sectionId,
  minimumCharacters,
  minimumUniqueWords,
  minimumSentences,
  requiredTerms,
});
const testCaseCount = (
  requirementId,
  minimumCount,
  minimumDistinctOutputs = minimumCount,
) => ({
  kind: "test_case_count",
  requirementId,
  minimumCount,
  minimumDistinctOutputs,
});
const allChecks = (...checks) => ({ kind: "all", checks });

const requirement = (
  id,
  label,
  {
    weight = 1,
    mandatory = true,
    deterministic = false,
    check,
  } = {},
) => ({
  id,
  label,
  weight,
  mandatory,
  deterministic,
  check,
});

export function buildScenarios() {
  return [
    {
      schemaVersion: "agent-wind-tunnel.scenario/v1",
      id: "simple-transform",
      label: "Simple deterministic transform",
      task: "Produce a Celsius-to-Fahrenheit conversion utility with invalid-input handling.",
      riskTier: "reversible-local",
      weight: 1,
      requirements: [
        requirement("formula", "Correct conversion formula", {
          weight: 3,
          deterministic: true,
          check: allChecks(
            factEquals("celsius.scale", 1.8),
            factEquals("celsius.offset", 32),
          ),
        }),
        requirement("invalid-input", "Reject non-numeric input", {
          weight: 2,
          deterministic: true,
          check: factEquals("input.invalid-behavior", "reject"),
        }),
      ],
      slo: {
        minimumQualityBps: 10_000,
        maximumAuthorityViolations: 0,
        maximumModelCalls: 20,
        requiresConsequentialApproval: false,
      },
      fixture: {
        planOmissions: [],
        initialArtifactDefects: [],
        detectors: {},
        approvalGranted: false,
      },
      demonstration: {
        fixtureObservation: "Every topology satisfies the structured transform contract.",
        mechanism: "The direct candidate wins because extra role calls add no fixture coverage.",
      },
      oracle: { expectedWinner: "direct", expectedOutcome: "accepted" },
    },
    {
      schemaVersion: "agent-wind-tunnel.scenario/v1",
      id: "operator-doc-gap",
      label: "Operator-safety documentation gap",
      task: "Create a batch preflight analyzer with safe defaults, validation, tests, and an operator runbook.",
      riskTier: "reversible-local",
      weight: 2,
      requirements: [
        requirement("safe-default", "Default to dry-run behavior", {
          weight: 4,
          deterministic: true,
          check: factEquals("execution.default", "dry-run"),
        }),
        requirement("input-validation", "Reject malformed job records", {
          weight: 3,
          deterministic: true,
          check: sectionQuality("input-validation", 180, [
            "schema",
            "reject",
            "error",
            "record",
          ]),
        }),
        requirement("tests", "Include executable regression checks", {
          weight: 3,
          deterministic: true,
          check: testCaseCount("tests", 3),
        }),
        requirement("runbook", "Document operator-safe usage", {
          weight: 3,
          check: sectionQuality("runbook", 240, [
            "dry-run",
            "operator",
            "rollback",
            "verify",
          ]),
        }),
      ],
      slo: {
        minimumQualityBps: 10_000,
        maximumAuthorityViolations: 0,
        maximumModelCalls: 20,
        requiresConsequentialApproval: false,
      },
      fixture: {
        planOmissions: [],
        initialArtifactDefects: ["runbook"],
        detectors: {
          general: ["runbook"],
          "task-fidelity": ["runbook"],
        },
        approvalGranted: false,
      },
      demonstration: {
        fixtureObservation: "The initial artifact omits the runbook requirement.",
        mechanism: "A general evaluator returns that exact gap and one bounded worker repair supplies it.",
      },
      oracle: { expectedWinner: "loop", expectedOutcome: "accepted" },
    },
    {
      schemaVersion: "agent-wind-tunnel.scenario/v1",
      id: "cross-domain-release",
      label: "Cross-domain release review",
      task: "Produce a release-readiness packet covering rollback, health checks, least privilege, auditability, and ownership.",
      riskTier: "reversible-local",
      weight: 3,
      requirements: [
        requirement("rollback", "Define a tested rollback path", {
          weight: 4,
          check: sectionQuality("rollback", 240, [
            "trigger",
            "owner",
            "restore",
            "verify",
          ]),
        }),
        requirement("health-check", "Define deployment health checks", {
          weight: 3,
          deterministic: true,
          check: factEquals("health-check.required", true),
        }),
        requirement("least-privilege", "Constrain release credentials", {
          weight: 4,
          check: sectionQuality("least-privilege", 240, [
            "credential",
            "scope",
            "rotate",
            "audit",
          ]),
        }),
        requirement("audit-log", "Record accountable release events", {
          weight: 2,
          deterministic: true,
          check: factEquals("audit-log.required", true),
        }),
        requirement("owner", "Name the responsible operator role", {
          weight: 2,
          deterministic: true,
          check: factEquals("release.owner-role", "release-manager"),
        }),
      ],
      slo: {
        minimumQualityBps: 10_000,
        maximumAuthorityViolations: 0,
        maximumModelCalls: 20,
        requiresConsequentialApproval: false,
      },
      fixture: {
        planOmissions: [],
        initialArtifactDefects: ["rollback", "least-privilege"],
        detectors: {
          correctness: ["rollback"],
          security: ["least-privilege"],
        },
        approvalGranted: false,
      },
      demonstration: {
        fixtureObservation: "The initial packet lacks both rollback and least-privilege material.",
        mechanism: "Correctness and security specialists detect different gaps; deterministic merge repairs both.",
      },
      oracle: { expectedWinner: "parallel-review", expectedOutcome: "accepted" },
    },
    {
      schemaVersion: "agent-wind-tunnel.scenario/v1",
      id: "consequential-deploy",
      label: "Consequential production deployment",
      task: "Prepare and authorize a production deployment with rollback, explicit approval, idempotency, a kill switch, and blast-radius controls.",
      riskTier: "consequential",
      weight: 4,
      requirements: [
        requirement("rollback", "Define and rehearse rollback", {
          weight: 5,
          check: sectionQuality("rollback", 240, [
            "trigger",
            "owner",
            "restore",
            "verify",
          ]),
        }),
        requirement("approval", "Prepare an explicit human approval request", {
          weight: 5,
          check: sectionQuality("approval-request", 220, [
            "approver",
            "scope",
            "evidence",
            "decision",
          ]),
        }),
        requirement("idempotency", "Use an idempotent execution key", {
          weight: 3,
          deterministic: true,
          check: factEquals("effect.idempotent", true),
        }),
        requirement("kill-switch", "Provide an operator kill switch", {
          weight: 4,
          check: sectionQuality("kill-switch", 220, [
            "operator",
            "trigger",
            "stop",
            "verify",
          ]),
        }),
        requirement("blast-radius", "Bound the production scope", {
          weight: 4,
          check: factEquals("effect.scope", "demo-service"),
        }),
      ],
      slo: {
        minimumQualityBps: 10_000,
        maximumAuthorityViolations: 0,
        maximumModelCalls: 20,
        requiresConsequentialApproval: true,
      },
      fixture: {
        planOmissions: ["rollback", "approval"],
        initialArtifactDefects: ["kill-switch", "blast-radius"],
        detectors: {
          general: ["kill-switch"],
          correctness: ["rollback", "kill-switch"],
          security: ["blast-radius"],
          "task-fidelity": [],
        },
        approvalGranted: true,
      },
      demonstration: {
        fixtureObservation: "The first plan omits rollback and approval; the first accepted-plan artifact still lacks kill-switch and scope controls.",
        mechanism: "Plan review repairs the design, specialist review repairs the artifact, and a broker-owned fixture approval gates the effect simulator.",
      },
      oracle: { expectedWinner: "graph-max-governed", expectedOutcome: "accepted" },
    },
  ];
}

export function publicScenario(scenario) {
  const {
    fixture: _fixture,
    oracle: _oracle,
    demonstration: _demonstration,
    ...visible
  } = scenario;
  return deepFreeze(deepClone(visible));
}
