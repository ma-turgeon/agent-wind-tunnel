import OpenAI from "openai";
import { randomUUID } from "node:crypto";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { sha256 } from "./util.mjs";

const Finding = z
  .object({
    requirementId: z.string().nullable(),
    severity: z.enum(["info", "warning", "error", "fatal"]),
    message: z.string().min(1),
  })
  .strict();

function blockingFindings(findings) {
  return findings.filter(
    (finding) => finding.severity === "error" || finding.severity === "fatal",
  );
}

const Planner = z
  .object({
    coveredRequirementIds: z.array(z.string()),
    risks: z.array(z.string()),
    notes: z.string(),
  })
  .strict();

const PlanReview = z
  .object({
    verdict: z.enum(["approve", "revise", "abort"]),
    findings: z.array(Finding),
  })
  .strict()
  .superRefine((value, context) => {
    const blocking = blockingFindings(value.findings);
    if (value.verdict === "approve" && blocking.length) {
      context.addIssue({
        code: "custom",
        path: ["verdict"],
        message: "approve is inconsistent with blocking findings",
      });
    }
    if (value.verdict === "revise" && !value.findings.length) {
      context.addIssue({
        code: "custom",
        path: ["verdict"],
        message: "revise requires at least one finding",
      });
    }
    if (value.verdict === "abort" && !blocking.length) {
      context.addIssue({
        code: "custom",
        path: ["verdict"],
        message: "abort requires a blocking finding",
      });
    }
  });

const Artifact = z
  .object({
    title: z.string().min(1),
    summary: z.string().min(1),
    evidence: z.array(
      z
        .object({
          requirementId: z.string().min(1),
          detail: z.string().min(1),
        })
        .strict(),
    ),
    facts: z.array(
      z
        .object({
          id: z.string().min(1),
          value: z.union([z.string(), z.number(), z.boolean()]),
        })
        .strict(),
    ),
    sections: z.array(
      z
        .object({
          id: z.string().min(1),
          content: z.string().min(1),
        })
        .strict(),
    ),
    testCases: z.array(
      z
        .object({
          id: z.string().min(1),
          requirementId: z.string().min(1),
          input: z.string().min(1),
          expectedOutput: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((value, context) => {
    for (const field of ["facts", "sections", "testCases"]) {
      const seen = new Set();
      for (let index = 0; index < value[field].length; index += 1) {
        const id = value[field][index].id;
        if (seen.has(id)) {
          context.addIssue({
            code: "custom",
            path: [field, index, "id"],
            message: `duplicate ${field} ID`,
          });
        }
        seen.add(id);
      }
    }
  });

const Worker = z
  .object({
    artifact: Artifact,
    evidence: z.array(z.string()),
  })
  .strict();

const Review = z
  .object({
    verdict: z.enum(["pass", "revise", "fatal"]),
    findings: z.array(Finding),
  })
  .strict()
  .superRefine((value, context) => {
    const blocking = blockingFindings(value.findings);
    if (value.verdict === "pass" && blocking.length) {
      context.addIssue({
        code: "custom",
        path: ["verdict"],
        message: "pass is inconsistent with blocking findings",
      });
    }
    if (value.verdict === "revise" && !value.findings.length) {
      context.addIssue({
        code: "custom",
        path: ["verdict"],
        message: "revise requires at least one finding",
      });
    }
    if (
      value.verdict === "fatal" &&
      !value.findings.some((finding) => finding.severity === "fatal")
    ) {
      context.addIssue({
        code: "custom",
        path: ["verdict"],
        message: "fatal requires a fatal finding",
      });
    }
  });

const Presenter = z
  .object({
    summary: z.string(),
    recommendation: z.string(),
  })
  .strict();

function roleSchema(role) {
  if (role === "planner") return { name: "wind_tunnel_plan", schema: Planner };
  if (role === "plan-reviewer") return { name: "wind_tunnel_plan_review", schema: PlanReview };
  if (role === "worker") return { name: "wind_tunnel_artifact", schema: Worker };
  if (role.startsWith("reviewer:") || role === "synthesizer") {
    return { name: "wind_tunnel_review", schema: Review };
  }
  if (role === "presenter") return { name: "wind_tunnel_presentation", schema: Presenter };
  throw Object.assign(new Error(`No live schema for role ${role}.`), { code: "ROLE_NOT_IMPLEMENTED" });
}

function roleInstructions(role) {
  const common = [
    "You are one node in a controlled agent-architecture evaluation.",
    "Use only the supplied scenario and prior-node artifacts.",
    "Treat requirement IDs as exact identifiers.",
    "Never claim that an approval occurred merely because the artifact mentions one.",
    "Return only the schema-constrained result.",
  ].join(" ");
  if (role === "planner") {
    return `${common} Produce a complete plan. coveredRequirementIds must list every requirement the plan explicitly addresses.`;
  }
  if (role === "plan-reviewer") {
    return `${common} Independently compare the plan with every scenario requirement. Revise when a required item is absent.`;
  }
  if (role === "worker") {
    return [
      common,
      "Produce the requested artifact and apply supplied feedback precisely.",
      "Use facts, sections, and testCases to provide the concrete material requested by each public requirement check.",
      "Evidence is a trace aid only: add it only for requirements the artifact substantively satisfies, and never use an evidence claim instead of the requested material.",
    ].join(" ");
  }
  if (role.startsWith("reviewer:")) {
    const rubric = role.slice("reviewer:".length);
    return `${common} Review independently using the ${rubric} rubric. Report only actionable gaps, tied to exact requirement IDs when applicable.`;
  }
  if (role === "synthesizer") {
    return `${common} Check the supplied findings for consistency. Preserve every blocking finding; do not trade safety for brevity.`;
  }
  if (role === "presenter") {
    return `${common} Summarize the accepted artifact and state the smallest-topology principle in plain language.`;
  }
  return common;
}

function refusalText(response) {
  for (const output of response.output ?? []) {
    for (const content of output.content ?? []) {
      if (content.type === "refusal") return content.refusal ?? "Model refusal.";
    }
  }
  return null;
}

function normalizedUsage(response, latencyMs) {
  const usage = response.usage ?? {};
  return {
    inputTokens: usage.input_tokens ?? 0,
    cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
    cacheWriteInputTokens: usage.input_tokens_details?.cache_write_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    reasoningOutputTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
    tokenUnits: usage.total_tokens ?? 0,
    latencyTicks: Math.max(1, Math.ceil(latencyMs / 100)),
    latencyMs,
  };
}

function responseMetadata(response, latencyMs, requestedModel, clientRequestId) {
  return {
    callId: response?.id ?? null,
    responseId: response?.id ?? null,
    requestId: response?._request_id ?? null,
    clientRequestId,
    requestedModel,
    returnedModel: response?.model ?? requestedModel,
    usage: normalizedUsage(response ?? {}, latencyMs),
  };
}

function responseError({
  code,
  message,
  response,
  latencyMs,
  requestedModel,
  clientRequestId,
  failureClass,
}) {
  return Object.assign(new Error(message), {
    code,
    retryable: false,
    systemic: false,
    failureClass,
    ...responseMetadata(response, latencyMs, requestedModel, clientRequestId),
  });
}

function headerValue(error, name) {
  const headers = error?.headers ?? error?.response?.headers;
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) return Array.isArray(value) ? value[0] : value;
  }
  return null;
}

function parseRetryAfterMs(error, now = Date.now()) {
  const rawMilliseconds = headerValue(error, "retry-after-ms");
  if (rawMilliseconds != null) {
    const milliseconds = Number(rawMilliseconds);
    if (Number.isFinite(milliseconds) && milliseconds >= 0) return Math.round(milliseconds);
  }

  const raw = headerValue(error, "retry-after");
  if (raw == null) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(String(raw));
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function deterministicJitter(attemptId) {
  const sample = Number.parseInt(sha256(String(attemptId)).slice(0, 8), 16) / 0xffffffff;
  return 0.75 + sample * 0.5;
}

export function boundedRetryDelayMs({
  attempt = 1,
  attemptId = "",
  retryAfterMs = null,
  maximumMs = 5_000,
}) {
  const exponent = Math.max(0, Math.min(8, Number(attempt) - 1));
  const backoff = Math.round(250 * 2 ** exponent * deterministicJitter(attemptId));
  const requested = Number.isFinite(retryAfterMs) ? retryAfterMs : 0;
  return Math.max(0, Math.min(maximumMs, Math.max(backoff, requested)));
}

function apiErrorCode(error) {
  return (
    error?.error?.code ??
    error?.body?.error?.code ??
    error?.code ??
    null
  );
}

function isQuotaError(error, status, code) {
  if (status !== 429) return false;
  if (["insufficient_quota", "billing_hard_limit_reached", "usage_limit_reached"].includes(code)) {
    return true;
  }
  const message = String(error?.message ?? "").toLowerCase();
  return (
    message.includes("current quota") ||
    message.includes("billing") ||
    message.includes("credits") ||
    message.includes("spend limit")
  );
}

export function classifyOpenAIError(error, context = {}) {
  const status = Number.isFinite(Number(error?.status)) ? Number(error.status) : null;
  const providerCode = apiErrorCode(error);
  const timeout =
    error?.name === "APIConnectionTimeoutError" ||
    providerCode === "ETIMEDOUT" ||
    providerCode === "ECONNABORTED";
  const connection =
    error?.name === "APIConnectionError" ||
    ["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENETUNREACH"].includes(providerCode);
  const quota = isQuotaError(error, status, providerCode);
  const rateLimited = status === 429 && !quota;
  const retryable =
    !quota &&
    (timeout ||
      connection ||
      status === 408 ||
      status === 409 ||
      rateLimited ||
      (status != null && status >= 500));
  const systemic =
    quota ||
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 422;
  let code = "OPENAI_API_ERROR";
  let failureClass = "api";
  if (quota) {
    code = "OPENAI_QUOTA_EXHAUSTED";
    failureClass = "quota";
  } else if (timeout) {
    code = "TIMEOUT";
    failureClass = "transient";
  } else if (connection) {
    code = "OPENAI_CONNECTION_ERROR";
    failureClass = "transient";
  } else if (rateLimited) {
    code = "OPENAI_RATE_LIMITED";
    failureClass = "transient";
  } else if (status != null && status >= 500) {
    code = "OPENAI_SERVER_ERROR";
    failureClass = "transient";
  } else if (status === 401) {
    code = "OPENAI_AUTH_ERROR";
    failureClass = "configuration";
  } else if (status === 403) {
    code = "OPENAI_PERMISSION_ERROR";
    failureClass = "configuration";
  } else if (status === 404) {
    code = "OPENAI_RESOURCE_NOT_FOUND";
    failureClass = "configuration";
  } else if (status === 400 || status === 422) {
    code = "OPENAI_INVALID_REQUEST";
    failureClass = "configuration";
  } else if (status === 408 || status === 409) {
    code = "OPENAI_TRANSIENT_ERROR";
    failureClass = "transient";
  }
  const retryAfterMs = parseRetryAfterMs(error);
  return Object.assign(new Error(error?.message ?? "OpenAI request failed."), {
    code,
    providerCode,
    status,
    retryable,
    systemic,
    failureClass,
    retryAfterMs,
    retryDelayMs: retryable
      ? boundedRetryDelayMs({
          attempt: context.attempt,
          attemptId: context.attemptId,
          retryAfterMs,
        })
      : 0,
    requestId: error?.request_id ?? error?._request_id ?? null,
    clientRequestId: context.clientRequestId ?? null,
  });
}

function outputText(response) {
  if (typeof response?.output_text === "string" && response.output_text) {
    return response.output_text;
  }
  for (const output of response?.output ?? []) {
    if (output.type !== "message") continue;
    for (const content of output.content ?? []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        return content.text;
      }
    }
  }
  return null;
}

export class OpenAIAdapter {
  constructor({
    apiKey,
    model = "gpt-5.6-terra",
    reasoningEffort = "medium",
    maxOutputTokens = 2_500,
    timeoutMs = 120_000,
    reasoningMode = null,
    executionId = `awt-${randomUUID()}`,
    credentialSource = "unspecified",
  }) {
    this.client = new OpenAI({
      apiKey,
      maxRetries: 0,
      logLevel: "warn",
    });
    this.model = model;
    this.reasoningEffort = reasoningEffort;
    this.maxOutputTokens = maxOutputTokens;
    this.timeoutMs = timeoutMs;
    this.reasoningMode = reasoningMode;
    this.executionId = executionId;
    this.credentialSource = credentialSource;
    this.kind = "openai";
    this.deterministic = false;
    this.experimentConfiguration = {
      provider: "openai",
      model,
      reasoningEffort,
      reasoningMode,
      maxOutputTokens,
      timeoutMs,
      promptCacheMode: "explicit-no-breakpoint",
      store: false,
    };
  }

  async invoke(context) {
    const { name, schema } = roleSchema(context.role);
    const started = performance.now();
    const clientRequestId = `${this.executionId}-${context.attemptId}`.slice(0, 512);
    try {
      const response = await this.client.responses.create(
        {
          model: this.model,
          instructions: roleInstructions(context.role),
          input: JSON.stringify(context.input),
          reasoning: {
            effort: this.reasoningEffort,
            ...(this.reasoningMode ? { mode: this.reasoningMode } : {}),
          },
          text: {
            verbosity: "low",
            format: zodTextFormat(schema, name),
          },
          max_output_tokens: this.maxOutputTokens,
          store: false,
          prompt_cache_options: { mode: "explicit" },
          metadata: {
            run_id: context.runId.slice(0, 64),
            execution_id: this.executionId.slice(0, 64),
            case_id: context.scenarioId.slice(0, 64),
            variant_id: context.blueprintId.slice(0, 64),
            node_id: context.nodeId.slice(0, 64),
          },
        },
        {
          timeout: this.timeoutMs,
          maxRetries: 0,
          headers: { "X-Client-Request-Id": clientRequestId },
        },
      );
      const latencyMs = Math.round(performance.now() - started);
      if (response.status === "incomplete") {
        throw responseError({
          code: "INCOMPLETE_RESPONSE",
          message: `OpenAI response incomplete: ${response.incomplete_details?.reason ?? "unknown"}.`,
          response,
          latencyMs,
          requestedModel: this.model,
          clientRequestId,
          failureClass: "incomplete",
        });
      }
      const refusal = refusalText(response);
      if (refusal) {
        throw responseError({
          code: "REFUSAL",
          message: refusal,
          response,
          latencyMs,
          requestedModel: this.model,
          clientRequestId,
          failureClass: "refusal",
        });
      }
      const rawText = outputText(response);
      if (!rawText) {
        throw responseError({
          code: "CONTRACT_VIOLATION",
          message: "OpenAI response had no structured output text.",
          response,
          latencyMs,
          requestedModel: this.model,
          clientRequestId,
          failureClass: "contract",
        });
      }
      let decoded;
      try {
        decoded = JSON.parse(rawText);
      } catch {
        throw responseError({
          code: "CONTRACT_VIOLATION",
          message: "OpenAI structured output was not valid JSON.",
          response,
          latencyMs,
          requestedModel: this.model,
          clientRequestId,
          failureClass: "contract",
        });
      }
      const validated = schema.safeParse(decoded);
      if (!validated.success) {
        const paths = validated.error.issues
          .slice(0, 5)
          .map((issue) => issue.path.join(".") || "<root>")
          .join(", ");
        throw responseError({
          code: "CONTRACT_VIOLATION",
          message: `OpenAI structured output failed the ${name} contract at: ${paths}.`,
          response,
          latencyMs,
          requestedModel: this.model,
          clientRequestId,
          failureClass: "contract",
        });
      }
      return {
        callId: response.id,
        responseId: response.id,
        requestId: response._request_id ?? null,
        clientRequestId,
        requestedModel: this.model,
        returnedModel: response.model ?? this.model,
        model: response.model ?? this.model,
        output: validated.data,
        usage: normalizedUsage(response, latencyMs),
      };
    } catch (error) {
      if (error.code && ["INCOMPLETE_RESPONSE", "REFUSAL", "CONTRACT_VIOLATION"].includes(error.code)) {
        throw error;
      }
      throw classifyOpenAIError(error, {
        attempt: context.attempt,
        attemptId: context.attemptId,
        clientRequestId,
      });
    }
  }
}
