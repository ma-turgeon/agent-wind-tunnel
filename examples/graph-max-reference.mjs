/**
 * Compact, provider-neutral reference graph used by Agent Wind Tunnel's
 * provenance demonstration. Model execution remains an injected dependency.
 */
const BLOCKING = new Set(["error", "fatal"]);

function blocking(findings = []) {
  return findings.some((finding) => BLOCKING.has(finding.severity));
}

async function call(invokeAgent, role, payload) {
  const response = await invokeAgent({ role, payload });
  if (!response || typeof response !== "object" || !response.output) {
    throw new Error(`${role} returned an invalid response envelope.`);
  }
  return response.output;
}

export async function graphMaxReference({
  task,
  invokeAgent,
  verifyArtifact,
  maxPlanRounds = 2,
  maxWorkRounds = 2,
}) {
  if (typeof task !== "string" || !task.trim()) {
    throw new TypeError("task must be a non-empty string.");
  }
  if (typeof invokeAgent !== "function" || typeof verifyArtifact !== "function") {
    throw new TypeError("invokeAgent and verifyArtifact are required.");
  }

  let plan = await call(invokeAgent, "planner", { task });
  let work = null;
  for (let round = 1; round <= maxPlanRounds; round += 1) {
    const [review, speculativeWork] = await Promise.all([
      call(invokeAgent, "plan-reviewer", { task, plan, round }),
      call(invokeAgent, "worker", { task, plan, round }),
    ]);
    if (review.verdict === "approve" && !blocking(review.findings)) {
      work = speculativeWork;
      break;
    }
    if (round === maxPlanRounds) throw new Error("Plan review budget exhausted.");
    plan = await call(invokeAgent, "planner", {
      task,
      previousPlan: plan,
      feedback: review.findings,
    });
  }

  for (let round = 1; round <= maxWorkRounds; round += 1) {
    const verification = await verifyArtifact({ task, plan, artifact: work.artifact });
    const rubrics = ["structure", "correctness", "task-fidelity"];
    const reviews = await Promise.all(
      rubrics.map((rubric) =>
        call(invokeAgent, `reviewer:${rubric}`, {
          task,
          plan,
          work,
          verification,
          rubric,
        })),
    );
    const synthesis = await call(invokeAgent, "synthesizer", {
      task,
      plan,
      work,
      verification,
      reviews,
    });
    if (
      verification.ok &&
      reviews.every((review) => review.verdict === "pass" && !blocking(review.findings)) &&
      synthesis.verdict === "pass" &&
      !blocking(synthesis.findings)
    ) {
      const presentation = await call(invokeAgent, "presenter", {
        task,
        acceptedArtifact: work.artifact,
      });
      return { status: "pass", plan, artifact: work.artifact, presentation };
    }
    if (round === maxWorkRounds) throw new Error("Work review budget exhausted.");
    work = await call(invokeAgent, "worker", {
      task,
      plan,
      previousWork: work,
      feedback: [
        ...(verification.findings ?? []),
        ...reviews.flatMap((review) => review.findings ?? []),
        ...(synthesis.findings ?? []),
      ],
    });
  }
  throw new Error("Unreachable graph termination.");
}
