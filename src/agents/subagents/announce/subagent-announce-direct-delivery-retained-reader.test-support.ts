import { expect, vi, type TestContext } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { buildRestartRecoveryClaimCleanupPatch } from "../../../config/sessions/restart-recovery-state.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../../test-utils/channel-plugins.js";
import {
  buildCurrentRunRestartRecoveryClaim,
  buildRestartRecoveryTerminalDeliveryEvidence,
} from "../../agent-command-restart-recovery.js";
import type { AgentDeliveryEvidence } from "../../embedded-agent-runner/delivery-evidence.js";
import { SourceOwnerChangedError } from "./subagent-announce-delivery-retry.js";
import {
  setSubagentAnnounceDeliveryDepsForTest,
  type SubagentAnnounceDeliveryDeps,
  type SubagentRequesterSessionRead,
  type SubagentRequesterSessionReader,
} from "./subagent-announce-delivery.runtime.js";
import { sendSubagentAnnounceDirectly } from "./subagent-announce-direct-delivery.js";

const REQUESTER = "agent:main:restart-parent";
export const SOURCE_KEY = "announce:requester-settle:main:restart-parent:child:yield-1";
export const RECOVERY_RUN = "restart-recovery-successor";
export const FINAL = { payloads: [{ text: "Recovered parent final" }] };
export const NO_VISIBLE_REPLY = { status: "ok", result: { payloads: [] } };
export const OLD_KEY_ERROR = new Error(
  "Session transcript keyed user is outside the current turn: original",
);

export type OriginalOutcome = { response: unknown } | { error: Error };
export function createFixture(
  { signal: testSignal, onTestFinished }: Pick<TestContext, "signal" | "onTestFinished">,
  external = false,
) {
  testSignal.throwIfAborted();
  if (external) {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({
              id: "slack",
              capabilities: { chatTypes: ["direct", "channel"] },
            }),
            messaging: {
              inferTargetChatType: ({ to }: { to: string }) =>
                to.startsWith("channel:") || to.startsWith("thread:") ? "channel" : "direct",
            },
          },
        },
      ]),
    );
  }
  const cfg: OpenClawConfig = { agents: { list: [{ id: "main" }] } };
  const entry: SessionEntry = {
    sessionId: "parent-incarnation",
    updatedAt: 1,
    lifecycleRevision: "revision-1",
  };
  const requester: SubagentRequesterSessionRead["requester"] = {
    cfg,
    entry,
    agentId: "main",
    canonicalKey: REQUESTER,
    storePath: "/synthetic-fixture/requester.sqlite",
  };
  const state: {
    allowed: boolean;
    ownerCurrent: boolean;
    readerKind: SubagentRequesterSessionReader["kind"];
    holdInitialRead: boolean;
    holdRead: boolean;
    holdCleanup: boolean;
    invalidateNextReadResponse: boolean;
    onAuthorityCheck?: () => void;
  } = {
    allowed: true,
    ownerCurrent: true,
    readerKind: "durable",
    holdInitialRead: false,
    holdRead: false,
    holdCleanup: false,
    invalidateNextReadResponse: false,
  };
  const controller = new AbortController();
  const deferred = createDeferred<unknown>();
  const dispatchEntered = createDeferred<void>();
  const initialReadEntered = createDeferred<void>();
  const initialReadDeferred = createDeferred<void>();
  const readEntered = createDeferred<void>();
  const readDeferred = createDeferred<void>();
  const cleanupEntered = createDeferred<void>();
  const cleanupDeferred = createDeferred<void>();
  const ownerOperations: Promise<unknown>[] = [];
  let completedOperationResult: unknown;
  let ownerOpen = false;
  let initialRead = true;
  let delivery: ReturnType<typeof sendSubagentAnnounceDirectly> | undefined;
  const releaseHeldFences = () => {
    deferred.resolve(NO_VISIBLE_REPLY);
    initialReadDeferred.resolve();
    readDeferred.resolve();
    cleanupDeferred.resolve();
  };
  const abortTest = () => {
    controller.abort(testSignal.reason);
    releaseHeldFences();
  };
  testSignal.addEventListener("abort", abortTest, { once: true });
  onTestFinished(async () => {
    releaseHeldFences();
    try {
      // A cancelled test wrapper still owns its delivery before dependency teardown.
      await delivery;
    } finally {
      // Cleanup rejection is an exercised owner outcome, not unjoined background work.
      await Promise.allSettled(ownerOperations);
      testSignal.removeEventListener("abort", abortTest);
      setSubagentAnnounceDeliveryDepsForTest();
      setActivePluginRegistry(createTestRegistry());
    }
  });
  // Preserve the generic contract without exposing real transport after a mock reset.
  const gatewayTransport: Pick<SubagentAnnounceDeliveryDeps, "dispatchGatewayMethodInProcess"> = {
    dispatchGatewayMethodInProcess: () => {
      throw new Error("Unexpected unmocked gateway dispatch");
    },
  };
  const dispatch = vi
    .spyOn(gatewayTransport, "dispatchGatewayMethodInProcess")
    .mockImplementation(() => {
      dispatchEntered.resolve();
      return deferred.promise;
    });
  const sendMessage = vi.fn<SubagentAnnounceDeliveryDeps["sendMessage"]>();
  const assertCurrent = () => {
    if (!ownerOpen || !state.ownerCurrent) {
      throw new SourceOwnerChangedError();
    }
  };
  const readStaleError = new Error("Requester read receipt changed before consumption");
  const createReadReceipt = () => {
    let current = true;
    const read: SubagentRequesterSessionRead = {
      requester,
      assertCurrent: () => {
        assertCurrent();
        if (!current) {
          throw readStaleError;
        }
      },
    };
    return {
      read,
      invalidate: () => {
        current = false;
      },
    };
  };
  const readRequester = vi.fn<SubagentRequesterSessionReader["read"]>(async () => {
    assertCurrent();
    if (initialRead) {
      initialRead = false;
      initialReadEntered.resolve();
      if (state.holdInitialRead) {
        await initialReadDeferred.promise;
      }
    } else if (state.holdRead) {
      readEntered.resolve();
      await readDeferred.promise;
    }
    const receipt = createReadReceipt();
    receipt.read.assertCurrent();
    if (state.invalidateNextReadResponse) {
      state.invalidateNextReadResponse = false;
      // Return settles this read; the queued change precedes its awaiting consumer.
      queueMicrotask(receipt.invalidate);
    }
    return receipt.read;
  });
  const readNativeRequester = vi.fn<SubagentRequesterSessionReader["read"]>(() => {
    assertCurrent();
    return createReadReceipt().read;
  });
  const requesterOwner: Pick<SubagentAnnounceDeliveryDeps, "withRequesterSessionReader"> = {
    withRequesterSessionReader<T>(
      _requesterSessionKey: string,
      _explicitAgentId: string | undefined,
      operation: (reader: SubagentRequesterSessionReader) => T | Promise<T>,
    ): Promise<T> {
      const reader: SubagentRequesterSessionReader = {
        kind: state.readerKind,
        read: state.readerKind === "incognito" ? readNativeRequester : readRequester,
        assertCurrent,
      };
      const pending = (async () => {
        ownerOpen = true;
        try {
          const result = await operation(reader);
          completedOperationResult = result;
          return result;
        } finally {
          ownerOpen = false;
          cleanupEntered.resolve();
          if (state.holdCleanup) {
            await cleanupDeferred.promise;
          }
        }
      })();
      ownerOperations.push(pending);
      return pending;
    },
  };
  const retainRequester = vi.spyOn(requesterOwner, "withRequesterSessionReader");
  // The negative proof applies this same fixture to frozen production. Observe legacy
  // entry here, then assert the repaired cutover only after the primary delivery outcome.
  const legacyRequester = vi.fn<SubagentAnnounceDeliveryDeps["loadRequesterSessionEntry"]>(
    () => requester,
  );
  const requesterActivity = vi.fn<SubagentAnnounceDeliveryDeps["getRequesterSessionActivity"]>(
    () => ({ sessionId: entry.sessionId, isActive: false }),
  );
  setSubagentAnnounceDeliveryDepsForTest({
    getRuntimeConfig: () => cfg,
    loadSessionEntry: () => {
      throw new Error("Unexpected caller-thread requester row read");
    },
    loadRequesterSessionEntry: legacyRequester,
    withRequesterSessionReader: requesterOwner.withRequesterSessionReader,
    getRequesterSessionActivity: requesterActivity,
    resolveRequesterSessionAbandonment: () => undefined,
    dispatchGatewayMethodInProcess: gatewayTransport.dispatchGatewayMethodInProcess,
    sendMessage,
  });
  const origin = external
    ? { channel: "slack", to: "channel:C123", accountId: "acct-1" }
    : undefined;
  const params: Parameters<typeof sendSubagentAnnounceDirectly>[0] = {
    requesterSessionKey: REQUESTER,
    requesterAgentId: "main",
    targetRequesterSessionKey: REQUESTER,
    requesterIsSubagent: false,
    triggerMessage: "Original child obligation is ready for its parent",
    sourceSessionKey: "agent:main:subagent:child",
    sourceTool: "subagent_settle",
    settleWakeSourceSessionKeys: ["agent:main:subagent:child"],
    expectsCompletionMessage: false,
    requireVisibleReply: true,
    directIdempotencyKey: SOURCE_KEY,
    directOrigin: origin,
    isSourceSessionEffectsAllowed: () => {
      state.onAuthorityCheck?.();
      return state.allowed;
    },
    isSourceSessionAdmissionAllowed: () => state.allowed,
    signal: controller.signal,
  };
  const publishClaim = (sourceKey = SOURCE_KEY) => {
    Object.assign(
      entry,
      buildCurrentRunRestartRecoveryClaim({
        entry,
        runId: RECOVERY_RUN,
        sourceRunId: sourceKey,
        sourceIngress: "internal",
        deliveryContext: origin,
      }),
    );
  };
  const publishTerminal = (result?: AgentDeliveryEvidence, sourceKey = SOURCE_KEY) => {
    publishClaim(sourceKey);
    // Use the same projection and source-key cleanup producer as requester recovery.
    // Mutate the clone:false object deliberately; its identity is not a saved incarnation.
    Object.assign(
      entry,
      buildRestartRecoveryClaimCleanupPatch({
        entry,
        recordTerminalSource: true,
        terminalRunId: RECOVERY_RUN,
        ...(result
          ? { terminalDeliveryEvidence: buildRestartRecoveryTerminalDeliveryEvidence(result) }
          : {}),
      }),
    );
  };
  return {
    entry,
    requester,
    state,
    controller,
    testSignal,
    deferred,
    dispatchEntered,
    initialReadEntered,
    initialReadDeferred,
    readEntered,
    readDeferred,
    cleanupEntered,
    cleanupDeferred,
    readRequester,
    readNativeRequester,
    readStaleError,
    retainRequester,
    legacyRequester,
    requesterActivity,
    get completedOperationResult() {
      return completedOperationResult;
    },
    releaseHeldFences,
    startDelivery: () => {
      testSignal.throwIfAborted();
      delivery = sendSubagentAnnounceDirectly(params);
      return delivery;
    },
    dispatch,
    sendMessage,
    params,
    publishClaim,
    publishTerminal,
  };
}

type Fixture = ReturnType<typeof createFixture>;

export async function waitForOwnedEntry(
  fixture: Fixture,
  entered: Promise<void>,
  delivery: ReturnType<typeof sendSubagentAnnounceDirectly>,
  boundary: string,
) {
  const reachedEntry = await Promise.race([entered.then(() => true), delivery.then(() => false)]);
  fixture.testSignal.throwIfAborted();
  expect(reachedEntry, `Delivery settled before ${boundary}`).toBe(true);
}

export async function completeHeldAttempt(
  fixture: Fixture,
  duringDispatch: () => void,
  outcome: OriginalOutcome = { response: NO_VISIBLE_REPLY },
  duringRead?: () => void,
) {
  fixture.state.holdRead = duringRead !== undefined;
  const delivery = fixture.startDelivery();
  try {
    await waitForOwnedEntry(fixture, fixture.dispatchEntered.promise, delivery, "dispatch entry");
    expect(fixture.dispatch).toHaveBeenCalledOnce();
    // All late receipts are published after the real entry point reaches dispatch.
    duringDispatch();
    if ("error" in outcome) {
      fixture.deferred.reject(outcome.error);
    } else {
      fixture.deferred.resolve(outcome.response);
    }
    if (duringRead) {
      await waitForOwnedEntry(fixture, fixture.readEntered.promise, delivery, "late-read entry");
      // Change live ownership only after the asynchronous reader has entered.
      duringRead();
      fixture.readDeferred.resolve();
    }
    const result = await delivery;
    expect(fixture.dispatch).toHaveBeenCalledOnce();
    expect(fixture.dispatch.mock.calls[0]?.[0]).toBe("agent");
    expect(fixture.dispatch.mock.calls[0]?.[1]).toMatchObject({
      idempotencyKey: SOURCE_KEY,
      sessionKey: fixture.params.targetRequesterSessionKey,
      deliver: fixture.params.directOrigin !== undefined,
    });
    expect(fixture.sendMessage).not.toHaveBeenCalled();
    return result;
  } finally {
    fixture.releaseHeldFences();
    await delivery;
  }
}
