import { describe, expect, it, vi } from "vitest";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { createTaskCompletionEvent } from "../../subagent-test-fixtures.test-helpers.js";
import {
  SourceOwnerChangedError,
  sourceOwnerChangedResult,
} from "./subagent-announce-delivery-retry.js";
import {
  completeHeldAttempt,
  createFixture,
  FINAL,
  NO_VISIBLE_REPLY,
  OLD_KEY_ERROR,
  RECOVERY_RUN,
  SOURCE_KEY,
  waitForOwnedEntry,
  type OriginalOutcome,
} from "./subagent-announce-direct-delivery-retained-reader.test-support.js";

const retryableOutcomes: { name: string; outcome: OriginalOutcome }[] = [
  { name: "failed response", outcome: { response: { status: "error", result: { payloads: [] } } } },
  { name: "empty successful response", outcome: { response: NO_VISIBLE_REPLY } },
  { name: "accepted response", outcome: { response: { status: "accepted" } } },
  { name: "in-flight response", outcome: { response: { status: "in_flight" } } },
  { name: "old keyed-user rejection", outcome: { error: OLD_KEY_ERROR } },
];

describe("late exact-source requester recovery", () => {
  it.for([{ stage: "read" }, { stage: "acceptance" }] as const)(
    "preserves typed source-owner change during initial $stage without dispatch",
    async ({ stage }, context) => {
      const fixture = createFixture(context);
      fixture.state.holdInitialRead = false;
      fixture.state.holdCleanup = false;
      if (stage === "read") {
        fixture.readRequester.mockRejectedValueOnce(new SourceOwnerChangedError());
      } else {
        const originalRead = fixture.readRequester.getMockImplementation();
        if (!originalRead) throw new Error("Retained reader fixture has no read implementation");
        fixture.readRequester.mockImplementationOnce(async () => ({
          ...(await originalRead()),
          assertCurrent() {
            throw new SourceOwnerChangedError();
          },
        }));
      }
      expect(await fixture.startDelivery()).toEqual(sourceOwnerChangedResult());
      expect(fixture.retainRequester).toHaveBeenCalledOnce();
      expect(fixture.readRequester).toHaveBeenCalledOnce();
      expect(fixture.dispatch).not.toHaveBeenCalled();
      expect(fixture.sendMessage).not.toHaveBeenCalled();
    },
  );

  it.for(retryableOutcomes)(
    "consumes an exact final after $name without replay",
    async ({ outcome }, context) => {
      const fixture = createFixture(context);
      const result = await completeHeldAttempt(
        fixture,
        () => fixture.publishTerminal(FINAL),
        outcome,
      );
      expect(result).toMatchObject({
        delivered: true,
        path: "direct",
        requesterVisibleFinalDelivered: true,
      });
      expect(fixture.legacyRequester).not.toHaveBeenCalled();
      expect(fixture.requesterActivity).toHaveBeenCalledOnce();
      expect(fixture.requesterActivity).toHaveBeenCalledWith(
        fixture.params.targetRequesterSessionKey,
        fixture.params.requesterAgentId,
        fixture.requester,
      );
      expect(fixture.requesterActivity.mock.calls[0]?.[2]).toBe(fixture.requester);
      expect(fixture.retainRequester).toHaveBeenCalledOnce();
      expect(fixture.readRequester).toHaveBeenCalledTimes(2);
      expect(fixture.readNativeRequester).not.toHaveBeenCalled();
      expect(fixture.entry.restartRecoveryTerminalDeliveryEvidence).toEqual([
        expect.objectContaining({
          runId: SOURCE_KEY,
          transcriptRunId: RECOVERY_RUN,
          captured: true,
        }),
      ]);
    },
  );

  it.for(["fulfilled", "rejected"] as const)(
    "keeps a live exact claim pending after %s",
    async (kind, context) => {
      const fixture = createFixture(context);
      const result = await completeHeldAttempt(
        fixture,
        () => fixture.publishClaim(),
        kind === "rejected" ? { error: OLD_KEY_ERROR } : { response: NO_VISIBLE_REPLY },
      );
      expect(result).toEqual({
        delivered: false,
        path: "direct",
        reason: "requester_turn_pending",
        disposition: "retryable",
      });
      expect(fixture.legacyRequester).not.toHaveBeenCalled();
      expect(fixture.requesterActivity).toHaveBeenCalledOnce();
      expect(fixture.requesterActivity).toHaveBeenCalledWith(
        fixture.params.targetRequesterSessionKey,
        fixture.params.requesterAgentId,
        fixture.requester,
      );
      expect(fixture.requesterActivity.mock.calls[0]?.[2]).toBe(fixture.requester);
      expect(fixture.retainRequester).toHaveBeenCalledOnce();
      expect(fixture.entry.restartRecoveryDeliverySourceRunId).toBe(SOURCE_KEY);
      expect(fixture.entry.restartRecoveryDeliveryRunId).toBe(RECOVERY_RUN);
    },
  );

  it("preserves a terminal source without a durable receipt as permanent failure", async (context) => {
    const fixture = createFixture(context);
    const result = await completeHeldAttempt(fixture, () => fixture.publishTerminal());
    expect(result).toMatchObject({
      delivered: false,
      reason: "visible_reply_missing",
      disposition: "permanent_failure",
    });
  });

  it.for([
    {
      name: "progress-only recovery",
      result: { payloads: [{ text: "Still working", isCommentary: true }] },
    },
    {
      name: "error-only recovery",
      result: { payloads: [{ text: "Recovery failed", isError: true }] },
    },
  ])("does not manufacture success from $name", async ({ result }, context) => {
    const fixture = createFixture(context);
    const delivery = await completeHeldAttempt(fixture, () => fixture.publishTerminal(result));
    expect(delivery).toMatchObject({ delivered: false, reason: "visible_reply_missing" });
    expect(delivery.disposition).toBeUndefined();
  });

  it.for(["unrelated source", "generic done", "no recovery"] as const)(
    "ignores %s",
    async (kind, context) => {
      const fixture = createFixture(context);
      const result = await completeHeldAttempt(fixture, () => {
        if (kind === "unrelated source") {
          fixture.publishTerminal(FINAL, `${SOURCE_KEY}:another`);
        } else if (kind === "generic done") {
          fixture.entry.status = "done";
        }
      });
      expect(result).toMatchObject({ delivered: false, reason: "visible_reply_missing" });
      expect(result.disposition).toBeUndefined();
    },
  );

  it("retains an ordinary thrown failure when no exact recovery exists", async (context) => {
    const fixture = createFixture(context);
    const result = await completeHeldAttempt(fixture, () => {}, { error: OLD_KEY_ERROR });
    expect(result).toEqual({
      delivered: false,
      path: "direct",
      error: OLD_KEY_ERROR.message,
      disposition: "retryable",
    });
  });

  it.for(["incognito canonical key", "native incognito sentinel"] as const)(
    "preserves the original retryable failure without a late worker read for %s",
    async (kind, context) => {
      const fixture = createFixture(context);
      fixture.state.readerKind = "incognito";
      if (kind === "incognito canonical key") {
        const incognitoKey = "agent:main:dashboard:incognito-restart-parent";
        fixture.requester.canonicalKey = incognitoKey;
        fixture.params.requesterSessionKey = incognitoKey;
        fixture.params.targetRequesterSessionKey = incognitoKey;
      } else {
        fixture.requester.storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
        fixture.readRequester.mockRejectedValueOnce(new Error("Incognito worker unavailable"));
      }
      // A live process-only row may look recovered, but cannot supply a durable late receipt.
      const result = await completeHeldAttempt(fixture, () => fixture.publishTerminal(FINAL), {
        error: OLD_KEY_ERROR,
      });
      expect(result).toEqual({
        delivered: false,
        path: "direct",
        error: OLD_KEY_ERROR.message,
        disposition: "retryable",
      });
      expect(fixture.readRequester).not.toHaveBeenCalled();
      expect(fixture.readNativeRequester).toHaveBeenCalledOnce();
    },
  );

  it.for([
    "session",
    "revision",
    "absent revision",
    "agent",
    "key",
    "store",
    "missing row",
  ] as const)(
    "refuses exact-looking evidence after requester %s changes",
    async (changed, context) => {
      const fixture = createFixture(context);
      if (changed === "absent revision") {
        delete fixture.entry.lifecycleRevision;
      }
      const result = await completeHeldAttempt(
        fixture,
        () => fixture.publishTerminal(FINAL),
        { response: NO_VISIBLE_REPLY },
        () => {
          switch (changed) {
            case "session":
              fixture.entry.sessionId = "replacement";
              break;
            case "revision":
            case "absent revision":
              fixture.entry.lifecycleRevision = "revision-2";
              break;
            case "agent":
              fixture.requester.agentId = "replacement";
              break;
            case "key":
              fixture.requester.canonicalKey = "agent:main:replacement";
              break;
            case "store":
              fixture.requester.storePath = "/synthetic-fixture/replacement.sqlite";
              break;
            case "missing row":
              fixture.requester.entry = undefined;
              break;
          }
        },
      );
      expect(result).toMatchObject({ delivered: false, reason: "visible_reply_missing" });
    },
  );

  it.for(["source revocation", "caller cancellation"] as const)(
    "blocks dispatch after %s during initial requester preparation",
    async (change, context) => {
      const fixture = createFixture(context);
      fixture.state.holdInitialRead = true;
      const delivery = fixture.startDelivery();
      try {
        await waitForOwnedEntry(
          fixture,
          fixture.initialReadEntered.promise,
          delivery,
          "initial requester-read entry",
        );
        if (change === "source revocation") {
          fixture.state.allowed = false;
        } else {
          fixture.controller.abort();
        }
        fixture.initialReadDeferred.resolve();
        const result = await delivery;
        expect(result).toEqual(
          change === "source revocation"
            ? {
                delivered: false,
                path: "none",
                reason: "completion_handoff_pending",
                terminal: true,
                disposition: "intentional_non_delivery",
              }
            : { delivered: false, path: "none" },
        );
        expect(fixture.dispatch).not.toHaveBeenCalled();
        expect(fixture.sendMessage).not.toHaveBeenCalled();
        expect(fixture.readRequester).toHaveBeenCalledOnce();
        expect(fixture.readNativeRequester).not.toHaveBeenCalled();
      } finally {
        fixture.releaseHeldFences();
        await delivery;
      }
    },
  );

  it("rejects a copied recovery receipt after retained owner loss during dispatch", async (context) => {
    const fixture = createFixture(context);
    const result = await completeHeldAttempt(fixture, () => {
      fixture.publishTerminal(FINAL);
      // The retained owner, not copied session/revision scalars, governs this replacement.
      fixture.requester.entry = { ...fixture.entry };
      fixture.state.ownerCurrent = false;
    });
    expect(result).toMatchObject({
      delivered: false,
      reason: "source_owner_changed",
      terminal: true,
      disposition: "intentional_non_delivery",
    });
    expect(fixture.retainRequester).toHaveBeenCalledOnce();
    expect(fixture.readRequester).toHaveBeenCalledOnce();
    expect(fixture.readNativeRequester).not.toHaveBeenCalled();
  });

  it("rejects a late receipt changed between response and consumer continuation", async (context) => {
    const fixture = createFixture(context);
    const result = await completeHeldAttempt(fixture, () => {
      fixture.publishTerminal(FINAL);
      fixture.state.invalidateNextReadResponse = true;
    });
    expect(result).toEqual({
      delivered: false,
      path: "direct",
      error: fixture.readStaleError.message,
      disposition: "retryable",
    });
    expect(fixture.state.ownerCurrent).toBe(true);
    expect(fixture.retainRequester).toHaveBeenCalledOnce();
    expect(fixture.readRequester).toHaveBeenCalledTimes(2);
    expect(fixture.readNativeRequester).not.toHaveBeenCalled();
    expect(fixture.legacyRequester).not.toHaveBeenCalled();
  });

  it.for(["initial receipt", "receipt during original dispatch"] as const)(
    "refuses inferred recovery success after retained-owner settlement loss for %s",
    async (timing, context) => {
      const fixture = createFixture(context);
      fixture.state.holdCleanup = true;
      const initialReceipt = timing === "initial receipt";
      if (initialReceipt) {
        fixture.publishTerminal(FINAL);
      }
      const delivery = fixture.startDelivery();
      try {
        if (!initialReceipt) {
          await waitForOwnedEntry(
            fixture,
            fixture.dispatchEntered.promise,
            delivery,
            "dispatch entry",
          );
          fixture.publishTerminal(FINAL);
          fixture.deferred.resolve(NO_VISIBLE_REPLY);
        }
        await waitForOwnedEntry(
          fixture,
          fixture.cleanupEntered.promise,
          delivery,
          "reader cleanup entry",
        );
        expect(fixture.completedOperationResult).toMatchObject({
          delivered: true,
          path: "direct",
          requesterVisibleFinalDelivered: true,
        });
        fixture.cleanupDeferred.reject(new SourceOwnerChangedError());
        await expect(delivery).resolves.toMatchObject({
          delivered: false,
          reason: "source_owner_changed",
          terminal: true,
          disposition: "intentional_non_delivery",
        });
        expect(fixture.dispatch).toHaveBeenCalledTimes(initialReceipt ? 0 : 1);
        expect(fixture.sendMessage).not.toHaveBeenCalled();
        expect(fixture.retainRequester).toHaveBeenCalledOnce();
        expect(fixture.readRequester).toHaveBeenCalledTimes(initialReceipt ? 1 : 2);
        expect(fixture.readNativeRequester).not.toHaveBeenCalled();
        expect(fixture.legacyRequester).not.toHaveBeenCalled();
      } finally {
        fixture.releaseHeldFences();
        await delivery;
      }
    },
  );

  it.for([
    {
      name: "ambiguous send",
      external: false,
      outcome: {
        error: Object.assign(new Error("send failed after receipt"), { sentBeforeError: true }),
      },
      expected: { delivered: false, disposition: "ambiguous" },
    },
    {
      name: "permanent dispatch failure",
      external: false,
      outcome: { error: new Error("unsupported channel: fixture") },
      expected: { delivered: false, disposition: "permanent_failure" },
    },
    {
      name: "intentional suppression",
      external: true,
      outcome: {
        response: {
          status: "ok",
          result: {
            ...FINAL,
            deliveryStatus: {
              status: "suppressed",
              resultCount: 0,
              reason: "cancelled_by_message_sending_hook",
            },
          },
        },
      },
      expected: {
        delivered: false,
        reason: "delivery_suppressed",
        disposition: "intentional_non_delivery",
        terminal: true,
      },
    },
    {
      name: "pending requester turn",
      external: false,
      outcome: { response: { status: "accepted" } },
      expected: { delivered: false, reason: "requester_turn_pending", disposition: "retryable" },
    },
    {
      name: "permanent missing message-tool result",
      external: true,
      completion: true,
      outcome: { response: { status: "ok", result: FINAL } },
      expected: {
        delivered: false,
        reason: "message_tool_delivery_missing",
        disposition: "permanent_failure",
      },
    },
    {
      name: "yielded requester ownership",
      external: true,
      completion: true,
      outcome: { response: { status: "ok", result: { payloads: [], meta: { yielded: true } } } },
      expected: {
        delivered: false,
        reason: "completion_handoff_pending",
        disposition: "session_queued",
      },
    },
  ])("preserves original $name policy across reader cleanup failure", async (sample, context) => {
    const { external, outcome, expected } = sample;
    const fixture = createFixture(context, external);
    if ("completion" in sample) {
      fixture.params.sourceTool = "subagent_announce";
      fixture.params.expectsCompletionMessage = true;
      fixture.params.directOrigin = { channel: "slack", to: "user:U123", accountId: "acct-1" };
      delete fixture.params.settleWakeSourceSessionKeys;
    }
    fixture.state.holdCleanup = true;
    const delivery = fixture.startDelivery();
    try {
      await waitForOwnedEntry(fixture, fixture.dispatchEntered.promise, delivery, "dispatch entry");
      if ("error" in outcome) {
        fixture.deferred.reject(outcome.error);
      } else {
        fixture.deferred.resolve(outcome.response);
      }
      await waitForOwnedEntry(
        fixture,
        fixture.cleanupEntered.promise,
        delivery,
        "reader cleanup entry",
      );
      const original = fixture.completedOperationResult;
      expect(original).toMatchObject(expected);
      fixture.cleanupDeferred.reject(new Error("Reader retirement failed after original outcome"));
      await expect(delivery).resolves.toBe(original);
      expect(fixture.dispatch).toHaveBeenCalledOnce();
      expect(fixture.sendMessage).not.toHaveBeenCalled();
      expect(fixture.retainRequester).toHaveBeenCalledOnce();
    } finally {
      fixture.releaseHeldFences();
      await delivery;
    }
  });

  it("preserves a committed original send across retained-reader cleanup rejection", async (context) => {
    const fixture = createFixture(context, true);
    fixture.state.holdCleanup = true;
    const delivery = fixture.startDelivery();
    try {
      await waitForOwnedEntry(fixture, fixture.dispatchEntered.promise, delivery, "dispatch entry");
      fixture.deferred.resolve({
        status: "ok",
        result: { ...FINAL, deliveryStatus: { status: "sent", resultCount: 1 } },
      });
      await waitForOwnedEntry(
        fixture,
        fixture.cleanupEntered.promise,
        delivery,
        "reader cleanup entry",
      );
      const committed = fixture.completedOperationResult;
      expect(committed).toMatchObject({
        delivered: true,
        path: "direct",
        requesterVisibleFinalDelivered: true,
      });
      fixture.cleanupDeferred.reject(new Error("Retained requester cleanup failed"));
      await expect(delivery).resolves.toBe(committed);
      expect(fixture.dispatch).toHaveBeenCalledOnce();
      expect(fixture.sendMessage).not.toHaveBeenCalled();
      expect(fixture.retainRequester).toHaveBeenCalledOnce();
      expect(fixture.readRequester).toHaveBeenCalledOnce();
      expect(fixture.readNativeRequester).not.toHaveBeenCalled();
    } finally {
      fixture.releaseHeldFences();
      await delivery;
    }
  });

  it.for(["fulfilled", "rejected"] as const)(
    "respects source revocation after %s",
    async (kind, context) => {
      const fixture = createFixture(context);
      const result = await completeHeldAttempt(
        fixture,
        () => {
          fixture.publishTerminal(FINAL);
          fixture.state.allowed = false;
        },
        kind === "rejected" ? { error: OLD_KEY_ERROR } : { response: NO_VISIBLE_REPLY },
      );
      expect(result).toMatchObject({
        delivered: false,
        reason: "source_owner_changed",
        terminal: true,
        disposition: "intentional_non_delivery",
      });
    },
  );

  it.for(["fulfilled", "rejected"] as const)(
    "respects caller cancellation after %s",
    async (kind, context) => {
      const fixture = createFixture(context);
      const result = await completeHeldAttempt(
        fixture,
        () => {
          fixture.publishTerminal(FINAL);
          fixture.controller.abort();
        },
        kind === "rejected" ? { error: OLD_KEY_ERROR } : { response: NO_VISIBLE_REPLY },
      );
      expect(result).toEqual({ delivered: false, path: "none" });
    },
  );

  const committedReceiptCases = [
    { name: "internal final", external: false, result: FINAL },
    {
      name: "automatic send",
      external: true,
      result: { ...FINAL, deliveryStatus: { status: "sent", resultCount: 1 } },
    },
  ].flatMap((receipt) =>
    (["source revocation", "caller cancellation"] as const).map((change) => ({
      name: receipt.name,
      external: receipt.external,
      result: receipt.result,
      change,
    })),
  );

  it.for(committedReceiptCases)(
    "preserves an original $name across subsequent $change",
    async ({ external, result: committed, change }, context) => {
      const fixture = createFixture(context, external);
      const result = await completeHeldAttempt(
        fixture,
        () => {
          fixture.state.onAuthorityCheck = () => {
            queueMicrotask(() => {
              if (change === "source revocation") {
                fixture.state.allowed = false;
              } else {
                fixture.controller.abort();
              }
            });
          };
        },
        { response: { status: "ok", result: committed } },
      );
      expect(result).toMatchObject({ delivered: true, requesterVisibleFinalDelivered: true });
      if (change === "source revocation") {
        expect(fixture.state.allowed).toBe(false);
      } else {
        expect(fixture.controller.signal.aborted).toBe(true);
      }
    },
  );

  it.for(committedReceiptCases)(
    "interprets a pre-existing $name without yielding to $change",
    async ({ external, result: committed, change }, context) => {
      const fixture = createFixture(context, external);
      fixture.publishTerminal(committed);
      fixture.state.onAuthorityCheck = () => {
        queueMicrotask(() => {
          if (change === "source revocation") {
            fixture.state.allowed = false;
          } else {
            fixture.controller.abort();
          }
        });
      };
      const result = await fixture.startDelivery();
      expect(result).toMatchObject({ delivered: true, requesterVisibleFinalDelivered: true });
      expect(fixture.dispatch).not.toHaveBeenCalled();
      expect(fixture.sendMessage).not.toHaveBeenCalled();
      if (change === "source revocation") {
        expect(fixture.state.allowed).toBe(false);
      } else {
        expect(fixture.controller.signal.aborted).toBe(true);
      }
    },
  );

  it.for(["source revocation", "caller cancellation"] as const)(
    "rejects %s during the authoritative late-receipt read",
    async (change, context) => {
      const fixture = createFixture(context);
      const result = await completeHeldAttempt(
        fixture,
        () => fixture.publishTerminal(FINAL),
        { response: NO_VISIBLE_REPLY },
        () => {
          if (change === "source revocation") {
            fixture.state.allowed = false;
          } else {
            fixture.controller.abort();
          }
        },
      );
      expect(result).toMatchObject(
        change === "source revocation"
          ? { delivered: false, reason: "source_owner_changed", terminal: true }
          : { delivered: false, path: "none" },
      );
    },
  );

  it.for(["source revocation", "caller cancellation"] as const)(
    "preserves a committed asynchronous text fallback across %s",
    async (change, context) => {
      const fixture = createFixture(context, true);
      fixture.params.sourceTool = "subagent_announce";
      fixture.params.expectsCompletionMessage = true;
      fixture.params.directOrigin = {
        channel: "slack",
        to: "user:U123",
        accountId: "acct-1",
      };
      delete fixture.params.settleWakeSourceSessionKeys;
      const sourceSessionKey = fixture.params.sourceSessionKey;
      if (!sourceSessionKey) {
        throw new Error("Completion fixture requires an exact child source");
      }
      fixture.params.internalEvents = [
        createTaskCompletionEvent({
          childSessionKey: sourceSessionKey,
          childSessionId: "child-incarnation",
          result: "The child completed its result.",
        }),
      ];
      const committed = vi.fn();
      fixture.params.onDeliveryResult = committed;
      fixture.sendMessage.mockImplementationOnce(async (params) => {
        await params.onPlatformSendDispatch?.();
        await params.onDeliveryResult?.({ channel: "slack", messageId: "committed-1" });
        if (change === "source revocation") {
          fixture.state.allowed = false;
        } else {
          fixture.controller.abort();
        }
        throw new Error("post-send bookkeeping failed");
      });
      const delivery = fixture.startDelivery();
      try {
        await waitForOwnedEntry(
          fixture,
          fixture.dispatchEntered.promise,
          delivery,
          "dispatch entry",
        );
        expect(fixture.dispatch).toHaveBeenCalledOnce();
        fixture.deferred.resolve(NO_VISIBLE_REPLY);
        await expect(delivery).resolves.toMatchObject({
          delivered: true,
          path: "direct",
          deliveredAt: expect.any(Number),
        });
        expect(committed).toHaveBeenCalledOnce();
        expect(fixture.sendMessage).toHaveBeenCalledOnce();
        expect(fixture.dispatch).toHaveBeenCalledOnce();
        expect(fixture.dispatch.mock.calls[0]?.[1]).toMatchObject({
          deliver: false,
          sourceReplyDeliveryMode: "message_tool_only",
        });
      } finally {
        fixture.releaseHeldFences();
        await delivery;
      }
    },
  );

  it.for(["rpc", "stop", "aborted", "superseded"] as const)(
    "does not upgrade the original %s cancellation",
    async (stopReason, context) => {
      const fixture = createFixture(context);
      const result = await completeHeldAttempt(fixture, () => fixture.publishTerminal(FINAL), {
        response: { status: "error", stopReason, result: { payloads: [] } },
      });
      expect(result).toMatchObject({ delivered: false, reason: "visible_reply_missing" });
    },
  );

  it("still reconciles restart interruption through its exact successor receipt", async (context) => {
    const fixture = createFixture(context);
    const result = await completeHeldAttempt(fixture, () => fixture.publishTerminal(FINAL), {
      response: { status: "error", stopReason: "restart", result: { payloads: [] } },
    });
    expect(result).toMatchObject({ delivered: true, requesterVisibleFinalDelivered: true });
  });

  it.for([
    {
      name: "identified send ambiguity",
      error: Object.assign(new Error("send failed after receipt"), { sentBeforeError: true }),
      disposition: "ambiguous",
    },
    {
      name: "permanent dispatch failure",
      error: new Error("unsupported channel: fixture"),
      disposition: "permanent_failure",
    },
  ])("preserves $name over late evidence", async ({ error, disposition }, context) => {
    const fixture = createFixture(context);
    const result = await completeHeldAttempt(fixture, () => fixture.publishTerminal(FINAL), {
      error,
    });
    expect(result).toMatchObject({ delivered: false, disposition, error: error.message });
  });

  it("does not replace an already delivered original result with late failed recovery", async (context) => {
    const fixture = createFixture(context);
    const result = await completeHeldAttempt(fixture, () => fixture.publishTerminal(), {
      response: { status: "ok", result: FINAL },
    });
    expect(result).toMatchObject({ delivered: true, requesterVisibleFinalDelivered: true });
  });

  it("preserves intentional automatic-delivery suppression", async (context) => {
    const fixture = createFixture(context, true);
    const result = await completeHeldAttempt(fixture, () => fixture.publishTerminal(FINAL), {
      response: {
        status: "ok",
        result: {
          ...FINAL,
          deliveryStatus: {
            status: "suppressed",
            resultCount: 0,
            reason: "cancelled_by_message_sending_hook",
          },
        },
      },
    });
    expect(result).toMatchObject({
      delivered: false,
      reason: "delivery_suppressed",
      disposition: "intentional_non_delivery",
      terminal: true,
    });
  });

  it("requires the normal automatic receipt for a source-matched external recovery", async (context) => {
    const fixture = createFixture(context, true);
    const result = await completeHeldAttempt(fixture, () =>
      fixture.publishTerminal({
        ...FINAL,
        deliveryStatus: { status: "sent", resultCount: 1 },
      }),
    );
    expect(result).toMatchObject({ delivered: true, requesterVisibleFinalDelivered: true });
  });

  it.for([
    { name: "unsent final", result: FINAL, disposition: undefined },
    {
      name: "empty automatic receipt",
      result: { ...FINAL, deliveryStatus: { status: "sent", resultCount: 0 } },
      disposition: undefined,
    },
    {
      name: "failed send",
      result: {
        ...FINAL,
        deliveryStatus: { status: "failed", resultCount: 0, errorMessage: "recovery send failed" },
      },
      disposition: undefined,
    },
    {
      name: "partial send",
      result: {
        ...FINAL,
        deliveryStatus: {
          status: "partial_failed",
          resultCount: 1,
          errorMessage: "partial recovery send",
        },
      },
      disposition: "ambiguous",
    },
    {
      name: "off-target final",
      result: {
        messagingToolSentTargets: [
          {
            provider: "slack",
            to: "channel:OTHER",
            accountId: "acct-1",
            text: "Unrelated final",
            sourceReplyFinal: true,
          },
        ],
      },
      disposition: undefined,
    },
  ])("does not settle an external source from $name", async ({ result, disposition }, context) => {
    const fixture = createFixture(context, true);
    const delivery = await completeHeldAttempt(fixture, () => fixture.publishTerminal(result));
    expect(delivery.delivered).toBe(false);
    expect(delivery.disposition).toBe(disposition);
  });
});
