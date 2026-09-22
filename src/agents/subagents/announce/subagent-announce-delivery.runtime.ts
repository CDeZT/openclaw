/**
 * Runtime dependency owner for subagent announcement delivery.
 *
 * Tests override this module's delivery capabilities while origin routing keeps
 * using the direct runtime exports below.
 */
import "../../../auto-reply/reply/queue.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { tryResolveLegacyCompatibilityAgentId } from "../../../config/legacy.default-agent-owner.js";
import { resolveSessionStorePathCore } from "../../../config/sessions.js";
import { loadSessionEntryReadOnly as loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import { withConfiguredSessionEntryReader } from "../../../config/sessions/session-entry-configured-worker-read.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../../../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { callGateway } from "../../../gateway/call.js";
import { bindGatewayLifecycleRequest } from "../../../gateway/server-recovery-runtime-context.js";
import { sendMessage } from "../../../infra/outbound/message.js";
import "../../../infra/outbound/best-effort-delivery.js";
import "../../../infra/outbound/bound-delivery-router.js";
import "../../../infra/outbound/conversation-id.js";
import {
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../../../routing/session-key.js";
import "../../../plugins/hook-runner-global.js";
import { resolveActiveEmbeddedRunSessionId } from "../../embedded-agent-runner/active-run-projections.js";
import type { EmbeddedAgentQueueMessageOptions } from "../../embedded-agent-runner/run-state.js";
import {
  formatEmbeddedAgentQueueFailureSummary,
  isEmbeddedAgentRunActive,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  queueGuardedEmbeddedAgentMessageWithOutcomeAsync,
  resolveEmbeddedRunAbandonment,
  type EmbeddedAgentQueueMessageOutcome,
} from "../../embedded-agent-runner/runs.js";
import { SourceOwnerChangedError } from "./subagent-announce-delivery-retry.js";
import { dispatchGatewayMethodInProcess } from "./subagent-announce.runtime.js";
import { resolveRequesterStoreKey } from "./subagent-requester-store-key.js";
export { resolveQueueSettings } from "../../../auto-reply/reply/queue.js";
export { resolveExternalBestEffortDeliveryTarget } from "../../../infra/outbound/best-effort-delivery.js";
export { createBoundDeliveryRouter } from "../../../infra/outbound/bound-delivery-router.js";
export { resolveConversationIdFromTargets } from "../../../infra/outbound/conversation-id.js";
export { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";

export { formatEmbeddedAgentQueueFailureSummary, isEmbeddedAgentRunActive };

export type SubagentAnnounceDeliveryDeps = {
  callGateway: typeof callGateway;
  dispatchGatewayMethodInProcess: typeof dispatchGatewayMethodInProcess;
  getRuntimeConfig: typeof getRuntimeConfig;
  getRequesterSessionActivity: (
    requesterSessionKey: string,
    requesterAgentId?: string,
    preparedRequester?: RequesterSessionEntryResult,
  ) => {
    sessionId?: string;
    isActive: boolean;
  };
  resolveRequesterSessionAbandonment: (
    requesterSessionKey: string,
    sessionId?: string,
  ) => ReturnType<typeof resolveEmbeddedRunAbandonment>;
  loadSessionEntry: typeof loadSessionEntry;
  withConfiguredSessionEntryReader: typeof withConfiguredSessionEntryReader;
  loadRequesterSessionEntry: typeof loadRequesterSessionEntry;
  withRequesterSessionReader: typeof withRequesterSessionReader;
  queueEmbeddedAgentMessageWithOutcome: (
    sessionId: string,
    text: string,
    options?: EmbeddedAgentQueueMessageOptions,
  ) => EmbeddedAgentQueueMessageOutcome | Promise<EmbeddedAgentQueueMessageOutcome>;
  queueGuardedEmbeddedAgentMessageWithOutcome: typeof queueGuardedEmbeddedAgentMessageWithOutcomeAsync;
  sendMessage: typeof sendMessage;
};

type RequesterSessionEntryResult = {
  cfg: ReturnType<typeof getRuntimeConfig>;
  entry: ReturnType<typeof loadSessionEntry>;
  canonicalKey: string;
  agentId?: string;
  storePath?: string;
};

export type SubagentRequesterSessionRead = {
  requester: RequesterSessionEntryResult;
  /** Accept this exact row in the consuming frame, after any intervening await. */
  assertCurrent: () => void;
};

export type SubagentRequesterSessionReader = {
  kind: "durable" | "incognito" | "unavailable";
  read: () => SubagentRequesterSessionRead | Promise<SubagentRequesterSessionRead>;
  /** Retained physical/routing ownership, not freshness of an earlier row. */
  assertCurrent: () => void;
};

export function tryResolveSubagentRequesterAgentId(
  cfg: OpenClawConfig,
  requesterSessionKey: string,
  explicitAgentId?: string,
): string | undefined {
  const requestedAgentId = explicitAgentId?.trim() ? normalizeAgentId(explicitAgentId) : undefined;
  const parsedAgentId = parseAgentSessionKey(requesterSessionKey)?.agentId;
  if (requestedAgentId && parsedAgentId && requestedAgentId !== parsedAgentId) {
    return undefined;
  }
  const persistedStoreOwner = resolvePersistedSessionStoreOwnerForKey(cfg, requesterSessionKey);
  if (persistedStoreOwner.kind === "retired") {
    return undefined;
  }
  if (
    requestedAgentId &&
    persistedStoreOwner.kind === "configured" &&
    requestedAgentId !== persistedStoreOwner.agentId
  ) {
    return undefined;
  }
  const resolvedAgentId = requestedAgentId ?? parsedAgentId;
  if (resolvedAgentId) {
    return resolvedAgentId;
  }
  return (
    (persistedStoreOwner.kind === "configured" ? persistedStoreOwner.agentId : undefined) ??
    tryResolveLegacyCompatibilityAgentId(cfg)
  );
}

function resolveRequesterSessionEntryTarget(requesterSessionKey: string, explicitAgentId?: string) {
  const cfg = subagentAnnounceDeliveryDeps.getRuntimeConfig();
  const rawStorageKey = requesterSessionKey.trim();
  const canonicalKey = resolveRequesterStoreKey(cfg, requesterSessionKey, explicitAgentId);
  const configuredMainKey = normalizeMainKey(cfg.session?.mainKey);
  const storageKey =
    rawStorageKey === "main" || rawStorageKey === configuredMainKey ? canonicalKey : rawStorageKey;
  const agentId = tryResolveSubagentRequesterAgentId(cfg, rawStorageKey, explicitAgentId);
  const storePath = agentId
    ? resolveSessionStorePathCore(cfg.session?.store, { agentId })
    : undefined;
  return { cfg, canonicalKey, storageKey, agentId, storePath };
}

function loadDefaultRequesterSessionEntry(
  requesterSessionKey: string,
  explicitAgentId?: string,
): RequesterSessionEntryResult {
  const { storageKey, ...target } = resolveRequesterSessionEntryTarget(
    requesterSessionKey,
    explicitAgentId,
  );
  if (!target.agentId || !target.storePath) {
    return { cfg: target.cfg, entry: undefined, canonicalKey: target.canonicalKey };
  }
  const entry = subagentAnnounceDeliveryDeps.loadSessionEntry({
    storePath: target.storePath,
    sessionKey: storageKey,
    agentId: target.agentId,
    clone: false,
  });
  return { ...target, entry };
}

async function withDefaultRequesterSessionReader<T>(
  requesterSessionKey: string,
  explicitAgentId: string | undefined,
  operation: (reader: SubagentRequesterSessionReader) => T | Promise<T>,
): Promise<T> {
  // Capture routing before the configured reader acquires physical custody or waits.
  const before = resolveRequesterSessionEntryTarget(requesterSessionKey, explicitAgentId);
  const assertRouting = () => {
    const current = resolveRequesterSessionEntryTarget(requesterSessionKey, explicitAgentId);
    if (
      current.agentId !== before.agentId ||
      current.canonicalKey !== before.canonicalKey ||
      current.storageKey !== before.storageKey ||
      current.storePath !== before.storePath
    ) {
      throw new SourceOwnerChangedError();
    }
  };
  const result = (entry: RequesterSessionEntryResult["entry"]): RequesterSessionEntryResult => ({
    cfg: before.cfg,
    entry,
    canonicalKey: before.canonicalKey,
    agentId: before.agentId,
    storePath: before.storePath,
  });
  if (!before.agentId || !before.storePath) {
    return await operation({
      kind: "unavailable",
      assertCurrent: assertRouting,
      read: () => {
        assertRouting();
        return { requester: result(undefined), assertCurrent: assertRouting };
      },
    });
  }
  return await subagentAnnounceDeliveryDeps.withConfiguredSessionEntryReader(
    before.cfg,
    {
      agentId: before.agentId,
      sessionKey: before.storageKey,
      storePath: before.storePath,
      env: { ...process.env },
    },
    async (owner) => {
      const assertCurrent = () => {
        owner.assertCurrent();
        assertRouting();
      };
      assertCurrent();
      return await operation({
        kind: owner.kind,
        assertCurrent,
        read: () => {
          assertCurrent();
          const wrap = (
            read: Awaited<ReturnType<typeof owner.readEntry>>,
          ): SubagentRequesterSessionRead => {
            const assertReadCurrent = () => {
              read.assertCurrent();
              assertRouting();
            };
            assertReadCurrent();
            // Preserve the per-read guard through this adapter's promise boundary.
            return { requester: result(read.entry), assertCurrent: assertReadCurrent };
          };
          const read = owner.readEntry();
          return read instanceof Promise ? read.then(wrap) : wrap(read);
        },
      });
    },
  );
}

const defaultSubagentAnnounceDeliveryDeps: SubagentAnnounceDeliveryDeps = {
  callGateway: (request) => bindGatewayLifecycleRequest()(request),
  dispatchGatewayMethodInProcess: ((...args) =>
    dispatchGatewayMethodInProcess(...args)) as typeof dispatchGatewayMethodInProcess,
  getRuntimeConfig: () => getRuntimeConfig(),
  getRequesterSessionActivity: (requesterSessionKey, requesterAgentId, preparedRequester) => {
    const cfg = preparedRequester?.cfg ?? getRuntimeConfig();
    const resolvedAgentId = tryResolveSubagentRequesterAgentId(
      cfg,
      requesterSessionKey,
      requesterAgentId,
    );
    if (!resolvedAgentId) {
      return { isActive: false };
    }
    // A prepared exact row owns this lookup; do not reload durable state on the caller.
    const storedSessionId = (
      preparedRequester ?? loadRequesterSessionEntry(requesterSessionKey, resolvedAgentId)
    ).entry?.sessionId;
    // Unscoped active-run keys are ambiguous across agents. An explicit owner
    // must use its logical store entry instead of accepting another agent's run.
    const activeSessionId = parseAgentSessionKey(requesterSessionKey)
      ? resolveActiveEmbeddedRunSessionId(requesterSessionKey)
      : undefined;
    const sessionId = activeSessionId ?? storedSessionId;
    return {
      sessionId,
      isActive: Boolean(sessionId && isEmbeddedAgentRunActive(sessionId)),
    };
  },
  resolveRequesterSessionAbandonment: (requesterSessionKey, sessionId) =>
    resolveEmbeddedRunAbandonment({ sessionKey: requesterSessionKey, sessionId }),
  loadSessionEntry: (...args) => loadSessionEntry(...args),
  withConfiguredSessionEntryReader,
  loadRequesterSessionEntry: loadDefaultRequesterSessionEntry,
  withRequesterSessionReader: withDefaultRequesterSessionReader,
  queueEmbeddedAgentMessageWithOutcome: (...args) =>
    queueEmbeddedAgentMessageWithOutcomeAsync(...args),
  queueGuardedEmbeddedAgentMessageWithOutcome: (...args) =>
    queueGuardedEmbeddedAgentMessageWithOutcomeAsync(...args),
  sendMessage: (...args) => sendMessage(...args),
};

let subagentAnnounceDeliveryDeps = defaultSubagentAnnounceDeliveryDeps;

export function setSubagentAnnounceDeliveryDepsForTest(
  overrides?: Partial<SubagentAnnounceDeliveryDeps>,
): void {
  const callGatewayOverride = overrides?.callGateway;
  const dispatchGatewayMethodInProcessOverride =
    overrides?.dispatchGatewayMethodInProcess ??
    (callGatewayOverride
      ? ((async (method, agentParams, options) =>
          await callGatewayOverride({
            method,
            params: agentParams,
            expectFinal: options?.expectFinal,
            onAccepted: options?.onAccepted,
            timeoutMs: options?.timeoutMs,
          })) satisfies typeof dispatchGatewayMethodInProcess)
      : undefined);
  subagentAnnounceDeliveryDeps = overrides
    ? {
        ...defaultSubagentAnnounceDeliveryDeps,
        ...overrides,
        ...(dispatchGatewayMethodInProcessOverride
          ? { dispatchGatewayMethodInProcess: dispatchGatewayMethodInProcessOverride }
          : {}),
      }
    : defaultSubagentAnnounceDeliveryDeps;
}

export function getSubagentAnnounceRuntimeConfig() {
  return subagentAnnounceDeliveryDeps.getRuntimeConfig();
}

export function getSubagentRequesterSessionActivity(
  requesterSessionKey: string,
  requesterAgentId?: string,
  preparedRequester?: RequesterSessionEntryResult,
) {
  return subagentAnnounceDeliveryDeps.getRequesterSessionActivity(
    requesterSessionKey,
    requesterAgentId,
    preparedRequester,
  );
}

export function resolveSubagentRequesterSessionAbandonment(
  requesterSessionKey: string,
  sessionId?: string,
) {
  return subagentAnnounceDeliveryDeps.resolveRequesterSessionAbandonment(
    requesterSessionKey,
    sessionId,
  );
}

export function loadRequesterSessionEntry(
  requesterSessionKey: string,
  explicitAgentId?: string,
): RequesterSessionEntryResult {
  return subagentAnnounceDeliveryDeps.loadRequesterSessionEntry(
    requesterSessionKey,
    explicitAgentId,
  );
}

export function withRequesterSessionReader<T>(
  requesterSessionKey: string,
  explicitAgentId: string | undefined,
  operation: (reader: SubagentRequesterSessionReader) => T | Promise<T>,
): Promise<T> {
  return subagentAnnounceDeliveryDeps.withRequesterSessionReader(
    requesterSessionKey,
    explicitAgentId,
    operation,
  );
}

export function loadSessionEntryByKey(sessionKey: string, explicitAgentId?: string) {
  const cfg = subagentAnnounceDeliveryDeps.getRuntimeConfig();
  const agentId = tryResolveSubagentRequesterAgentId(cfg, sessionKey, explicitAgentId);
  if (!agentId) {
    return undefined;
  }
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  return subagentAnnounceDeliveryDeps.loadSessionEntry({
    storePath,
    sessionKey,
    agentId,
    clone: false,
  });
}

export async function queueSubagentAnnounceMessage(
  sessionId: string,
  text: string,
  options?: EmbeddedAgentQueueMessageOptions,
  canInject?: () => boolean,
): Promise<EmbeddedAgentQueueMessageOutcome> {
  if (canInject) {
    return await subagentAnnounceDeliveryDeps.queueGuardedEmbeddedAgentMessageWithOutcome(
      sessionId,
      text,
      options,
      canInject,
    );
  }
  return await subagentAnnounceDeliveryDeps.queueEmbeddedAgentMessageWithOutcome(
    sessionId,
    text,
    options,
  );
}

export async function dispatchSubagentAnnounceAgent(
  agentParams: Record<string, unknown>,
  options: Parameters<typeof dispatchGatewayMethodInProcess>[2],
): Promise<unknown> {
  return await subagentAnnounceDeliveryDeps.dispatchGatewayMethodInProcess(
    "agent",
    agentParams,
    options,
  );
}

export async function sendSubagentAnnounceMessage(
  params: Parameters<typeof sendMessage>[0],
): ReturnType<typeof sendMessage> {
  return await subagentAnnounceDeliveryDeps.sendMessage(params);
}
