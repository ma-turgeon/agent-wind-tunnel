import { invariant } from "./util.mjs";

const SEVERITIES = new Set(["info", "warning", "error", "fatal"]);
const REVIEW_VERDICTS = new Set(["pass", "revise", "fatal"]);
const PLAN_VERDICTS = new Set(["approve", "revise", "abort"]);

export function validateFindings(findings, role) {
  invariant(Array.isArray(findings), "CONTRACT_VIOLATION", `${role} returned no findings array.`);
  for (const finding of findings) {
    invariant(finding && typeof finding === "object", "CONTRACT_VIOLATION", `${role} returned a malformed finding.`);
    invariant(SEVERITIES.has(finding.severity), "CONTRACT_VIOLATION", `${role} returned invalid severity.`);
    invariant(typeof finding.message === "string" && finding.message, "CONTRACT_VIOLATION", `${role} returned no finding message.`);
    invariant(
      finding.requirementId == null || typeof finding.requirementId === "string",
      "CONTRACT_VIOLATION",
      `${role} returned an invalid requirement ID.`,
    );
  }
  return findings;
}

function validateArtifact(artifact) {
  invariant(
    artifact && typeof artifact === "object" && !Array.isArray(artifact),
    "CONTRACT_VIOLATION",
    "worker returned no artifact.",
  );
  invariant(
    typeof artifact.title === "string" && artifact.title.trim(),
    "CONTRACT_VIOLATION",
    "worker artifact has no title.",
  );
  invariant(
    typeof artifact.summary === "string" && artifact.summary.trim(),
    "CONTRACT_VIOLATION",
    "worker artifact has no summary.",
  );
  invariant(
    Array.isArray(artifact.evidence),
    "CONTRACT_VIOLATION",
    "worker artifact has no evidence array.",
  );
  for (const item of artifact.evidence) {
    invariant(
      typeof item?.requirementId === "string" &&
        item.requirementId.trim() &&
        typeof item?.detail === "string" &&
        item.detail.trim(),
      "CONTRACT_VIOLATION",
      "worker artifact contains malformed evidence.",
    );
  }
  invariant(
    Array.isArray(artifact.facts),
    "CONTRACT_VIOLATION",
    "worker artifact has no facts array.",
  );
  for (const fact of artifact.facts) {
    invariant(
      typeof fact?.id === "string" &&
        fact.id.trim() &&
        ["string", "number", "boolean"].includes(typeof fact.value),
      "CONTRACT_VIOLATION",
      "worker artifact contains a malformed fact.",
    );
  }
  invariant(
    Array.isArray(artifact.sections),
    "CONTRACT_VIOLATION",
    "worker artifact has no sections array.",
  );
  for (const section of artifact.sections) {
    invariant(
      typeof section?.id === "string" &&
        section.id.trim() &&
        typeof section?.content === "string" &&
        section.content.trim(),
      "CONTRACT_VIOLATION",
      "worker artifact contains a malformed section.",
    );
  }
  invariant(
    Array.isArray(artifact.testCases),
    "CONTRACT_VIOLATION",
    "worker artifact has no testCases array.",
  );
  for (const testCase of artifact.testCases) {
    invariant(
      typeof testCase?.id === "string" &&
        testCase.id.trim() &&
        typeof testCase?.requirementId === "string" &&
        testCase.requirementId.trim() &&
        typeof testCase?.input === "string" &&
        testCase.input.trim() &&
        typeof testCase?.expectedOutput === "string" &&
        testCase.expectedOutput.trim(),
      "CONTRACT_VIOLATION",
      "worker artifact contains a malformed test case.",
    );
  }
  for (const [label, items] of [
    ["facts", artifact.facts],
    ["sections", artifact.sections],
    ["testCases", artifact.testCases],
  ]) {
    const ids = items.map((item) => item.id);
    invariant(
      new Set(ids).size === ids.length,
      "CONTRACT_VIOLATION",
      `worker artifact contains duplicate ${label} IDs.`,
    );
  }
  return artifact;
}

function validateVerdictConsistency(role, output) {
  const blocking = output.findings.filter(
    (finding) => finding.severity === "error" || finding.severity === "fatal",
  );
  if (role === "plan-reviewer") {
    invariant(
      output.verdict !== "approve" || blocking.length === 0,
      "CONTRACT_VIOLATION",
      "plan-reviewer approved with blocking findings.",
    );
    invariant(
      output.verdict !== "revise" || output.findings.length > 0,
      "CONTRACT_VIOLATION",
      "plan-reviewer requested revision without findings.",
    );
    invariant(
      output.verdict !== "abort" || blocking.length > 0,
      "CONTRACT_VIOLATION",
      "plan-reviewer aborted without a blocking finding.",
    );
    return;
  }
  invariant(
    output.verdict !== "pass" || blocking.length === 0,
    "CONTRACT_VIOLATION",
    `${role} passed with blocking findings.`,
  );
  invariant(
    output.verdict !== "revise" || output.findings.length > 0,
    "CONTRACT_VIOLATION",
    `${role} requested revision without findings.`,
  );
  invariant(
    output.verdict !== "fatal" ||
      output.findings.some((finding) => finding.severity === "fatal"),
    "CONTRACT_VIOLATION",
    `${role} returned fatal without a fatal finding.`,
  );
}

export function validateRoleOutput(role, output) {
  invariant(output && typeof output === "object" && !Array.isArray(output), "CONTRACT_VIOLATION", `${role} returned no object.`);

  if (role === "planner") {
    invariant(Array.isArray(output.coveredRequirementIds), "CONTRACT_VIOLATION", "planner returned no coveredRequirementIds.");
    invariant(Array.isArray(output.risks), "CONTRACT_VIOLATION", "planner returned no risks array.");
    invariant(typeof output.notes === "string", "CONTRACT_VIOLATION", "planner returned no notes.");
  } else if (role === "worker") {
    validateArtifact(output.artifact);
    invariant(Array.isArray(output.evidence), "CONTRACT_VIOLATION", "worker returned no evidence summary.");
  } else if (role === "plan-reviewer") {
    invariant(PLAN_VERDICTS.has(output.verdict), "CONTRACT_VIOLATION", "plan-reviewer returned invalid verdict.");
    validateFindings(output.findings, role);
    validateVerdictConsistency(role, output);
  } else if (role.startsWith("reviewer:") || role === "synthesizer") {
    invariant(REVIEW_VERDICTS.has(output.verdict), "CONTRACT_VIOLATION", `${role} returned invalid verdict.`);
    validateFindings(output.findings, role);
    validateVerdictConsistency(role, output);
  } else if (role === "presenter") {
    invariant(typeof output.summary === "string", "CONTRACT_VIOLATION", "presenter returned no summary.");
    invariant(typeof output.recommendation === "string", "CONTRACT_VIOLATION", "presenter returned no recommendation.");
  } else {
    invariant(false, "CONTRACT_VIOLATION", `Unknown role contract: ${role}.`);
  }
  return output;
}

export function validateRoleReferences(role, output, scenario) {
  const allowed = new Set(scenario.requirements.map((requirement) => requirement.id));
  const requireKnown = (requirementId, source) => {
    invariant(
      allowed.has(requirementId),
      "CONTRACT_VIOLATION",
      `${role} referenced unknown requirement ${requirementId} in ${source}.`,
    );
  };
  if (role === "worker") {
    for (const item of output.artifact.evidence) {
      requireKnown(item.requirementId, "artifact evidence");
    }
    for (const item of output.artifact.testCases) {
      requireKnown(item.requirementId, "artifact test case");
    }
  }
  for (const finding of output.findings ?? []) {
    if (finding.requirementId != null) {
      requireKnown(finding.requirementId, "findings");
    }
  }
  return output;
}

export function dedupeFindings(findings) {
  const byKey = new Map();
  for (const finding of findings) {
    const key = [
      finding.requirementId ?? "",
      finding.severity,
      finding.message,
    ].join("\u0000");
    if (!byKey.has(key)) byKey.set(key, finding);
  }
  return [...byKey.values()].sort((left, right) => {
    return (
      (left.requirementId ?? "").localeCompare(right.requirementId ?? "") ||
      left.severity.localeCompare(right.severity) ||
      left.message.localeCompare(right.message)
    );
  });
}
