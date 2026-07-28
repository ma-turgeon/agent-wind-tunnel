import {
  canonicalHash,
  deepClone,
  deepFreeze,
} from "./util.mjs";
import {
  compileAuthorityEnvelope,
  validateBlueprint,
  validateScenario,
} from "./validate.mjs";

function immutableCopy(value) {
  return deepFreeze(deepClone(value));
}

function defaultApprovalProvider() {
  return {
    kind: "unconfigured",
    requestApproval(binding) {
      return {
        decision: "escalated",
        bindingHash: binding.bindingHash,
        reason: "No external approval provider is configured.",
      };
    },
  };
}

export function createFixtureApprovalProvider({
  granted = false,
  approvedBy = "fixture-human",
} = {}) {
  return deepFreeze({
    kind: "fixture",
    requestApproval(binding) {
      return {
        decision: granted ? "approved" : "declined",
        bindingHash: binding.bindingHash,
        approvedBy: granted ? approvedBy : null,
        reason: granted
          ? "The deterministic fixture approval was granted."
          : "The deterministic fixture approval was not granted.",
      };
    },
  });
}

function providerMethod(provider) {
  if (typeof provider === "function") return provider;
  if (typeof provider?.requestApproval === "function") {
    return provider.requestApproval.bind(provider);
  }
  return null;
}

function providerKind(provider) {
  if (typeof provider?.kind === "string" && provider.kind) return provider.kind;
  return typeof provider === "function" ? "function" : "invalid";
}

function scopeIsGranted(grants, capability, scopes) {
  const grant = grants.find((candidate) => candidate.capability === capability);
  return Boolean(grant && scopes.every((scope) => grant.scopes.includes(scope)));
}

export function createAuthorityBroker({
  policy,
  scenario,
  blueprint,
  runId,
  approvalProvider,
}) {
  validateBlueprint(blueprint, policy);
  validateScenario(scenario);
  const compiledAuthority = immutableCopy(
    compileAuthorityEnvelope(blueprint, policy),
  );
  const frozenGrants = immutableCopy(policy.initialGrants);
  const resolvedProvider = approvalProvider ?? defaultApprovalProvider();
  const requestApproval = providerMethod(resolvedProvider);
  const audit = [];
  const approvalTokens = new Map();
  const idempotencyMemo = new Map();
  const effectMemo = new Map();
  let effectExecutorCalls = 0;

  function record(event) {
    const stored = immutableCopy(event);
    audit.push(stored);
    return immutableCopy(stored);
  }

  function requestPermission({ capability, scopes, requestedBy }) {
    const normalizedScopes = [...new Set(scopes ?? [])].sort();
    const nodeRequests = compiledAuthority.capabilityRequests.filter(
      (request) =>
        (request.nodeId === requestedBy ||
          blueprint.nodes.find((node) => node.id === request.nodeId)?.role === requestedBy) &&
        request.capability === capability &&
        normalizedScopes.includes(request.scope),
    );
    const fullyCompiled =
      normalizedScopes.length > 0 &&
      normalizedScopes.every((scope) =>
        nodeRequests.some((request) => request.scope === scope),
      );
    const withinEnvelope = scopeIsGranted(
      frozenGrants,
      capability,
      normalizedScopes,
    );
    const allowed = fullyCompiled && withinEnvelope;
    return record({
      type: "permission-request",
      capability,
      scopes: normalizedScopes,
      requestedBy,
      compiledForRequester: fullyCompiled,
      decision: allowed ? "granted-within-envelope" : "escalated",
      reason: allowed
        ? "The request is already inside the immutable initial grant envelope."
        : fullyCompiled
          ? "The compiled node requests authority outside the immutable initial grants."
          : "The requested authority is not compiled into the requesting graph node.",
      grantsMutated: false,
    });
  }

  function resolveConsequentialEffect({
    capability,
    scope,
    effectNodeId,
  } = {}) {
    const candidates = compiledAuthority.consequentialEffects.filter(
      (request) =>
        (!capability || request.capability === capability) &&
        (!scope || request.scope === scope) &&
        (!effectNodeId || request.nodeId === effectNodeId),
    );
    if (candidates.length !== 1) return null;
    return candidates[0];
  }

  function authorizeConsequentialEffect({
    artifact,
    capability,
    scope,
    effectNodeId,
    idempotencyKey,
  } = {}) {
    if (!scenario.slo.requiresConsequentialApproval) {
      return immutableCopy({
        required: false,
        allowed: true,
        executed: false,
      });
    }

    const effect = resolveConsequentialEffect({
      capability,
      scope,
      effectNodeId,
    });
    if (!effect || effect.dominatingApprovalNodeIds.length !== 1) {
      const event = record({
        type: "effect-authorization",
        capability: capability ?? null,
        scope: scope ?? null,
        effectNodeId: effectNodeId ?? null,
        decision: "escalated",
        reason:
          "The compiled graph has no unique consequential effect dominated by one approval node.",
        executed: false,
        simulationOnly: true,
        externalEffect: false,
      });
      return immutableCopy({
        required: true,
        allowed: false,
        executed: false,
        event,
      });
    }
    if (artifact === undefined || artifact === null) {
      const event = record({
        type: "effect-authorization",
        capability: effect.capability,
        scope: effect.scope,
        effectNodeId: effect.nodeId,
        decision: "escalated",
        reason:
          "An accepted artifact is required before an approval binding can be issued.",
        executed: false,
        simulationOnly: true,
        externalEffect: false,
      });
      return immutableCopy({
        required: true,
        allowed: false,
        executed: false,
        event,
      });
    }

    const artifactHash = canonicalHash(artifact);
    const bindingCore = {
      runId,
      scenarioId: scenario.id,
      blueprintId: blueprint.id,
      artifactHash,
      approvalNodeId: effect.dominatingApprovalNodeIds[0],
      effectNodeId: effect.nodeId,
      capability: effect.capability,
      scope: effect.scope,
    };
    const bindingHash = canonicalHash(bindingCore);
    const binding = immutableCopy({ ...bindingCore, bindingHash });
    const resolvedIdempotencyKey =
      idempotencyKey ?? `effect-${bindingHash.slice(0, 24)}`;
    const priorByKey = idempotencyMemo.get(resolvedIdempotencyKey);
    if (priorByKey?.bindingHash !== undefined && priorByKey.bindingHash !== bindingHash) {
        const event = record({
          type: "effect-idempotency-conflict",
          capability: effect.capability,
          scope: effect.scope,
          effectNodeId: effect.nodeId,
          bindingHash,
          idempotencyKey: resolvedIdempotencyKey,
          decision: "denied",
          reason:
            "The idempotency key is already bound to a different run, artifact, capability, or scope.",
          executed: false,
          simulationOnly: true,
          externalEffect: false,
        });
        return immutableCopy({
          required: true,
          allowed: false,
          executed: false,
          event,
        });
    }
    const prior = priorByKey ?? effectMemo.get(bindingHash);
    if (prior) {
      if (!priorByKey) idempotencyMemo.set(resolvedIdempotencyKey, prior);
      const event = record({
        type: "effect-idempotency-replay",
        capability: effect.capability,
        scope: effect.scope,
        effectNodeId: effect.nodeId,
        bindingHash,
        idempotencyKey: resolvedIdempotencyKey,
        approvalTokenId: prior.result.event?.approvalTokenId ?? null,
        decision: prior.result.event?.decision ?? "approved",
        executed: false,
        originalExecuted: prior.result.executed,
        simulationOnly: true,
        externalEffect: false,
      });
      return immutableCopy({
        ...prior.result,
        replayed: true,
        event,
      });
    }

    function memoize(result) {
      const memo = { bindingHash, result };
      idempotencyMemo.set(resolvedIdempotencyKey, memo);
      effectMemo.set(bindingHash, memo);
    }

    let providerDecision;
    try {
      providerDecision = requestApproval?.(binding);
      if (
        providerDecision &&
        typeof providerDecision === "object" &&
        typeof providerDecision.then === "function"
      ) {
        throw Object.assign(
          new Error("Approval providers must return a synchronous decision."),
          { code: "ASYNC_APPROVAL_PROVIDER_UNSUPPORTED" },
        );
      }
    } catch (error) {
      providerDecision = {
        decision: "escalated",
        bindingHash,
        reason: `Approval provider failed closed (${error.code ?? error.name ?? "ERROR"}).`,
      };
    }
    if (!providerDecision || typeof providerDecision !== "object") {
      providerDecision = {
        decision: "escalated",
        bindingHash,
        reason: "Approval provider returned no decision.",
      };
    }
    const decision = ["approved", "declined", "escalated"].includes(
      providerDecision.decision,
    )
      ? providerDecision.decision
      : "escalated";
    const bindingMatches = providerDecision.bindingHash === bindingHash;
    if (decision !== "approved" || !bindingMatches) {
      const event = record({
        type: "effect-authorization",
        capability: effect.capability,
        scope: effect.scope,
        effectNodeId: effect.nodeId,
        bindingHash,
        idempotencyKey: resolvedIdempotencyKey,
        approvalProvider: providerKind(resolvedProvider),
        decision: bindingMatches ? decision : "escalated",
        reason: bindingMatches
          ? providerDecision.reason ?? "Approval was not granted."
          : "Approval response was not bound to this exact run, artifact, capability, and scope.",
        executed: false,
        simulationOnly: true,
        externalEffect: false,
      });
      const result = immutableCopy({
        required: true,
        allowed: false,
        executed: false,
        event,
      });
      memoize(result);
      return immutableCopy(result);
    }

    const approvalTokenId = `approval-${canonicalHash([
      bindingHash,
      providerDecision.approvedBy ?? null,
      providerDecision.approvalId ?? null,
    ]).slice(0, 24)}`;
    approvalTokens.set(approvalTokenId, {
      tokenId: approvalTokenId,
      bindingHash,
      runId,
      artifactHash,
      capability: effect.capability,
      scope: effect.scope,
      consumed: false,
    });
    const token = approvalTokens.get(approvalTokenId);
    if (token.consumed || token.bindingHash !== bindingHash) {
      const event = record({
        type: "effect-authorization",
        capability: effect.capability,
        scope: effect.scope,
        effectNodeId: effect.nodeId,
        bindingHash,
        approvalTokenId,
        idempotencyKey: resolvedIdempotencyKey,
        decision: "denied",
        reason: "Approval token is invalid or has already been consumed.",
        executed: false,
        simulationOnly: true,
        externalEffect: false,
      });
      const result = immutableCopy({
        required: true,
        allowed: false,
        executed: false,
        event,
      });
      memoize(result);
      return immutableCopy(result);
    }

    // Consume before invoking the built-in, data-only simulator so a one-time
    // approval can never be replayed as a second simulated execution.
    token.consumed = true;
    effectExecutorCalls += 1;
    const simulatorResult = immutableCopy({
      status: "completed",
      simulationOnly: true,
      externalEffect: false,
      bindingHash,
      approvalTokenId,
      idempotencyKey: resolvedIdempotencyKey,
    });

    const event = record({
      type: "effect-authorization",
      capability: effect.capability,
      scope: effect.scope,
      effectNodeId: effect.nodeId,
      bindingHash,
      artifactHash,
      approvalTokenId,
      idempotencyKey: resolvedIdempotencyKey,
      approvalProvider: providerKind(resolvedProvider),
      approvedBy: providerDecision.approvedBy ?? null,
      decision: "approved",
      executed: true,
      simulatorStatus: simulatorResult?.status ?? "completed",
      simulationOnly: true,
      externalEffect: false,
    });
    const result = immutableCopy({
      required: true,
      allowed: true,
      executed: true,
      event,
    });
    memoize(result);
    return immutableCopy(result);
  }

  return deepFreeze({
    requestPermission,
    authorizeConsequentialEffect,
    snapshot() {
      return immutableCopy({
        frozenGrants,
        compiledAuthority,
        audit,
        effectExecutorCalls,
        approvalProvider: providerKind(resolvedProvider),
        approvalTokens: [...approvalTokens.values()]
          .map((token) => ({ ...token }))
          .sort((left, right) => left.tokenId.localeCompare(right.tokenId)),
      });
    },
  });
}
