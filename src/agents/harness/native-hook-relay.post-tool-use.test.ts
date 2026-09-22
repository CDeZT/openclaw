import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { NativeHookRelayInvocation } from "./native-hook-relay-types.js";
import { isJsonObject } from "./native-hook-relay-utils.js";
import {
  invokeNativeHookRelay,
  registerNativeHookRelay,
  registerOwnedNativeHookRelay,
  testing,
} from "./native-hook-relay.js";

afterEach(async () => {
  vi.restoreAllMocks();
  resetGlobalHookRunner();
  setActivePluginRegistry(createEmptyPluginRegistry());
  await testing.clearNativeHookRelaysForTests();
});

function invokePostToolUse(relayId: string, toolName = "receipt_tool", signal?: AbortSignal) {
  return invokeNativeHookRelay(
    {
      provider: "codex",
      relayId,
      event: "post_tool_use",
      rawPayload: {
        hook_event_name: "PostToolUse",
        tool_name: toolName,
        tool_use_id: "receipt-call",
        tool_input: { target: "fixture" },
        tool_response: { submission_id: "submission-1" },
      },
    },
    signal,
  );
}

describe("owned native post-tool observations", () => {
  it.each(["owned", "public"] as const)(
    "observes only the selected canonical tool through the bundled owner (%s)",
    async (registration) => {
      const observe = vi.fn();
      const params = {
        provider: "codex" as const,
        sessionId: "post-tool-owner",
        runId: "post-tool-owner",
        postToolUse: { toolNames: [" Receipt_Tool ", "receipt_tool"], observe },
      };
      const relay =
        registration === "owned"
          ? registerOwnedNativeHookRelay(params)
          : registerNativeHookRelay(params);

      expect(relay.shouldRelayEvent("post_tool_use")).toBe(registration === "owned");
      expect(relay.toolMatcherForEvent("post_tool_use")).toEqual(
        registration === "owned" ? ["receipt_tool"] : undefined,
      );
      await invokePostToolUse(relay.relayId, "receipt_tool_extra");
      expect(observe).not.toHaveBeenCalled();
      await invokePostToolUse(relay.relayId, " RECEIPT_TOOL ");
      expect(observe).toHaveBeenCalledTimes(registration === "owned" ? 1 : 0);
    },
  );

  it("unions the owner tool with scoped after-tool observers without widening owner delivery", async () => {
    const afterToolCall = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "after_tool_call", matcher: ["observed_tool"], handler: afterToolCall },
      ]),
    );
    const observe = vi.fn();
    const relay = registerOwnedNativeHookRelay({
      provider: "codex",
      sessionId: "post-tool-union",
      runId: "post-tool-union",
      postToolUse: { toolNames: ["receipt_tool"], observe },
    });

    expect(relay.shouldRelayEvent("post_tool_use")).toBe(true);
    expect(relay.toolMatcherForEvent("post_tool_use")).toEqual(["observed_tool", "receipt_tool"]);
    await invokePostToolUse(relay.relayId, "observed_tool");
    expect(afterToolCall).toHaveBeenCalledOnce();
    expect(observe).not.toHaveBeenCalled();
    await invokePostToolUse(relay.relayId);
    expect(observe).toHaveBeenCalledOnce();
    expect(afterToolCall).toHaveBeenCalledOnce();
  });

  it("captures a complete immutable result before yielding to invocation readiness", async () => {
    const observe = vi.fn<(invocation: Readonly<NativeHookRelayInvocation>) => void>();
    const relay = registerOwnedNativeHookRelay({
      provider: "codex",
      sessionId: "post-tool-snapshot",
      runId: "post-tool-snapshot",
      postToolUse: { toolNames: ["receipt_tool"], observe },
    });
    const output = "x".repeat(50_000);
    const rawPayload = {
      hook_event_name: "PostToolUse",
      tool_name: "receipt_tool",
      tool_use_id: "receipt-call",
      tool_input: { target: "original" },
      tool_response: { submission_id: "submission-1", details: { output } },
    };
    const invocation = invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "post_tool_use",
      rawPayload,
    });
    expect(observe).not.toHaveBeenCalled();
    rawPayload.tool_use_id = "replacement-call";
    rawPayload.tool_input.target = "replacement";
    rawPayload.tool_response.submission_id = "replacement-submission";
    rawPayload.tool_response.details.output = "replacement-output";
    await invocation;

    expect(observe).toHaveBeenCalledOnce();
    const snapshot = observe.mock.calls[0]?.[0];
    expect(snapshot).toMatchObject({
      toolUseId: "receipt-call",
      rawPayload: {
        tool_use_id: "receipt-call",
        tool_input: { target: "original" },
        tool_response: { submission_id: "submission-1", details: { output } },
      },
    });
    const payload = snapshot?.rawPayload;
    if (
      !isJsonObject(payload) ||
      !isJsonObject(payload.tool_response) ||
      !isJsonObject(payload.tool_response.details)
    ) {
      throw new Error("Expected the complete observed result");
    }
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Reflect.set(payload, "tool_use_id", "changed")).toBe(false);
    expect(Reflect.set(payload.tool_response, "submission_id", "changed")).toBe(false);
    expect(Reflect.set(payload.tool_response.details, "output", "changed")).toBe(false);
  });

  it.each(["owner closed", "request aborted"] as const)(
    "does not accept a result when %s before readiness settles",
    async (revocation) => {
      let active = true;
      const observe = vi.fn();
      const request = new AbortController();
      const failure = new Error(revocation);
      const relay = registerOwnedNativeHookRelay({
        provider: "codex",
        sessionId: "post-tool-revocation",
        runId: "post-tool-revocation",
        postToolUse: { toolNames: ["receipt_tool"], observe },
        assertActive: () => {
          if (!active) {
            throw failure;
          }
        },
      });
      const invocation = invokePostToolUse(relay.relayId, "receipt_tool", request.signal);
      if (revocation === "owner closed") {
        active = false;
      } else {
        request.abort(failure);
      }

      if (revocation === "owner closed") {
        await expect(invocation).rejects.toBe(failure);
      } else {
        await expect(invocation).rejects.toMatchObject({ name: "AbortError", cause: failure });
      }
      expect(observe).not.toHaveBeenCalled();
    },
  );

  it("joins an accepted result failure in drain after the requesting transport aborts", async () => {
    const accepted = createDeferredCore<() => void>();
    const write = createDeferredCore();
    const request = new AbortController();
    const failure = new Error("accepted result write failed");
    const relay = registerOwnedNativeHookRelay({
      provider: "codex",
      sessionId: "post-tool-drain",
      runId: "post-tool-drain",
      postToolUse: {
        toolNames: ["receipt_tool"],
        observe: (_invocation, assertCurrent) => {
          accepted.resolve(assertCurrent);
          return write.promise;
        },
      },
    });
    const invocation = invokePostToolUse(relay.relayId, "receipt_tool", request.signal);
    void invocation.catch(() => undefined);
    try {
      const assertCurrent = await Promise.race([
        accepted.promise,
        invocation.then(() => {
          throw new Error("Result returned without accepting the owned observation");
        }),
      ]);
      const disconnect = new Error("request disconnected");
      request.abort(disconnect);
      await expect(invocation).rejects.toMatchObject({ name: "AbortError", cause: disconnect });
      expect(assertCurrent).not.toThrow();
      const drained = expect(relay.drain()).rejects.toBe(failure);
      write.reject(failure);
      await drained;
    } finally {
      write.reject(failure);
      await Promise.allSettled([write.promise, invocation, relay.drain()]);
    }
  });

  it.each(["unregister", "replacement"] as const)(
    "fences accepted callback effects after %s",
    async (retirement) => {
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const effect = vi.fn();
      const relay = registerOwnedNativeHookRelay({
        provider: "codex",
        sessionId: "post-tool-retirement",
        runId: "post-tool-retirement",
        postToolUse: {
          toolNames: ["receipt_tool"],
          observe: async (_invocation, assertCurrent) => {
            entered.resolve();
            await resume.promise;
            assertCurrent();
            effect();
          },
        },
      });
      const invocation = invokePostToolUse(relay.relayId);
      void invocation.catch(() => undefined);
      try {
        await Promise.race([
          entered.promise,
          invocation.then(() => {
            throw new Error("Result returned without accepting the owned observation");
          }),
        ]);
        if (retirement === "unregister") {
          relay.unregister();
        } else {
          registerOwnedNativeHookRelay({
            provider: "codex",
            relayId: relay.relayId,
            sessionId: "post-tool-retirement",
            runId: "post-tool-successor",
          });
        }
        resume.resolve();
        await expect(invocation).rejects.toThrow(/inactive|foreground/);
        await expect(relay.drain()).rejects.toThrow(/inactive|foreground/);
        expect(effect).not.toHaveBeenCalled();
      } finally {
        resume.resolve();
        await Promise.allSettled([invocation, relay.drain()]);
      }
    },
  );
});
