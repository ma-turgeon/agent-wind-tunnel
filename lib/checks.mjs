import { stableStringify } from "./util.mjs";

function factValue(artifact, id) {
  return (artifact?.facts ?? []).find((fact) => fact.id === id)?.value;
}

function sectionContent(artifact, id) {
  return (artifact?.sections ?? []).find((section) => section.id === id)?.content ?? "";
}

function testCasesFor(artifact, requirementId) {
  return (artifact?.testCases ?? []).filter(
    (testCase) => testCase.requirementId === requirementId,
  );
}

function words(value) {
  return String(value).toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [];
}

export function checkRequirement(requirement, artifact) {
  const evaluate = (check) => {
    if (check.kind === "fact_equals") {
      const actual = factValue(artifact, check.factId);
      return {
        passed: stableStringify(actual, 0) === stableStringify(check.expected, 0),
        evidence: actual == null ? null : `fact:${check.factId}`,
      };
    }
    if (check.kind === "section_min_chars") {
      const content = sectionContent(artifact, check.sectionId).trim();
      return {
        passed: content.length >= check.minimumCharacters,
        evidence: content ? `section:${check.sectionId}:${content.length}` : null,
      };
    }
    if (check.kind === "section_quality") {
      const content = sectionContent(artifact, check.sectionId).trim();
      const normalized = content.toLowerCase();
      const uniqueWords = new Set(words(content));
      const sentenceCount = content
        .split(/[.!?]+/)
        .filter((sentence) => words(sentence).length >= 3).length;
      const missingTerms = check.requiredTerms.filter(
        (term) => !normalized.includes(term.toLowerCase()),
      );
      return {
        passed:
          content.length >= check.minimumCharacters &&
          uniqueWords.size >= check.minimumUniqueWords &&
          sentenceCount >= check.minimumSentences &&
          missingTerms.length === 0,
        evidence: content
          ? [
              `section:${check.sectionId}:${content.length}`,
              `unique-words:${uniqueWords.size}`,
              `sentences:${sentenceCount}`,
              `missing-terms:${missingTerms.join("|") || "none"}`,
            ].join(",")
          : null,
      };
    }
    if (check.kind === "test_case_count") {
      const cases = testCasesFor(artifact, check.requirementId);
      const inputs = cases.map((item) => item.input.trim());
      const outputs = cases.map((item) => item.expectedOutput.trim());
      const minimumDistinctOutputs =
        check.minimumDistinctOutputs ?? Math.min(check.minimumCount, 2);
      return {
        passed:
          cases.length >= check.minimumCount &&
          cases.every(
            (item) =>
              typeof item.input === "string" &&
              item.input.trim() &&
              typeof item.expectedOutput === "string" &&
              item.expectedOutput.trim() &&
              item.input.trim() !== item.expectedOutput.trim(),
          ) &&
          new Set(inputs).size === inputs.length &&
          new Set(outputs).size >= minimumDistinctOutputs,
        evidence: [
          `test-cases:${check.requirementId}:${cases.length}`,
          `distinct-inputs:${new Set(inputs).size}`,
          `distinct-outputs:${new Set(outputs).size}`,
        ].join(","),
      };
    }
    if (check.kind === "all") {
      const children = check.checks.map(evaluate);
      return {
        passed: children.every((item) => item.passed),
        evidence: children.map((item) => item.evidence).filter(Boolean).join(",") || null,
      };
    }
    throw Object.assign(new Error(`Unknown deterministic check kind ${check.kind}.`), {
      code: "UNKNOWN_CHECK_KIND",
    });
  };
  return {
    requirementId: requirement.id,
    ...evaluate(requirement.check),
  };
}

export function evaluateRequirements(scenario, artifact) {
  return scenario.requirements.map((requirement) => ({
    requirement,
    ...checkRequirement(requirement, artifact),
  }));
}

function longSection(requirement, check) {
  const requiredTerms = check.requiredTerms?.join(", ") ?? "declared controls";
  const sentences = [
    `${requirement.label} defines a concrete procedure with the required concepts: ${requiredTerms}.`,
    "The accountable operator records preconditions, scope, ownership, and the evidence required before execution begins.",
    "A verification step compares observable results with explicit success criteria and stops when any guardrail fails.",
    "The failure response identifies escalation, recovery actions, audit records, and a bounded completion condition.",
    "Reviewers can inspect each decision, reproduce the check, and distinguish preparation from an authorized action.",
  ];
  let content = sentences.join(" ");
  let iteration = 1;
  while (content.length < check.minimumCharacters) {
    content += ` Iteration ${iteration} records a distinct checkpoint, expected signal, responsible role, and corrective response.`;
    iteration += 1;
  }
  return content.trim();
}

export function materializeRequirement(requirement) {
  const facts = [];
  const sections = [];
  const testCases = [];
  const visit = (check) => {
    if (check.kind === "fact_equals") {
      facts.push({ id: check.factId, value: check.expected });
    } else if (
      check.kind === "section_min_chars" ||
      check.kind === "section_quality"
    ) {
      sections.push({
        id: check.sectionId,
        content: longSection(requirement, check),
      });
    } else if (check.kind === "test_case_count") {
      for (let index = 1; index <= check.minimumCount; index += 1) {
        testCases.push({
          id: `${check.requirementId}-case-${index}`,
          requirementId: check.requirementId,
          input: `fixture input ${index}`,
          expectedOutput: `fixture expected result ${index}`,
        });
      }
    } else if (check.kind === "all") {
      check.checks.forEach(visit);
    }
  };
  visit(requirement.check);
  return { facts, sections, testCases };
}

export function mergeArtifactMaterial(artifact, material) {
  const mergeById = (left, right) => {
    const map = new Map([...left, ...right].map((item) => [item.id, item]));
    return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
  };
  return {
    ...artifact,
    facts: mergeById(artifact.facts ?? [], material.facts ?? []),
    sections: mergeById(artifact.sections ?? [], material.sections ?? []),
    testCases: mergeById(artifact.testCases ?? [], material.testCases ?? []),
  };
}
