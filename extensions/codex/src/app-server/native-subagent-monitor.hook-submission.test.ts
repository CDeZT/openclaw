import type { AgentHarnessTaskRecord } from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  childTurnCompletedNotification,
  CodexNativeSubagentMonitor,
  createClient,
  createRecordedRuntime,
  createTaskScope,
  nativeHistoryOwner,
  notifyChildStarted,
  threadRead,
  turnStartedNotification,
} from "./native-subagent-monitor.test-support.js";
import {
  readCodexNativeSubagentSubmissionAcknowledgement,
  type CodexNativeSubagentSubmissionAcknowledgement,
} from "./native-subagent-submission.js";

const parentThreadId = "parent-thread";
const nativeSessionId = "native-session-tree";
const initialRunId = "codex-thread:child-thread";
const followupRunId = "codex-thread:child-thread:turn:turn-b";
const receipt: CodexNativeSubagentSubmissionAcknowledgement = {
  nativeSessionId,
  parentTurnId: "parent-turn-b",
  callId: "send-b",
  childThreadId: "child-thread",
  submissionId: "turn-b",
};

async function createFixture(completeInitial = true) {
  const client = createClient();
  const records = new Map<string, AgentHarnessTaskRecord>();
  const runtime = createRecordedRuntime(records, "agent:main:main");
  const monitor = new CodexNativeSubagentMonitor(client.client, runtime, {
    recoveryPollDelaysMs: [],
  });
  onTestFinished(() => monitor.dispose());
  const historyOwner = nativeHistoryOwner(parentThreadId);
  const register = () =>
    monitor.registerParent({
      parentThreadId,
      nativeSessionId,
      historyOwner,
      requesterSessionKey: "agent:main:main",
      taskRuntimeScope: createTaskScope("agent:main:main"),
    });
  const complete = (turnId: string, result: string) =>
    client.notify(
      childTurnCompletedNotification({
        turnId,
        status: "completed",
        items: [{ id: `${turnId}-final`, type: "agentMessage", text: result }],
      }),
    );
  const initialOwner = register();
  initialOwner.bindTurn("parent-turn-a");
  await notifyChildStarted(client);
  await client.notify(turnStartedNotification("turn-a"));
  client.setThreadRead(
    "child-thread",
    threadRead({
      turnId: "turn-a",
      status: completeInitial ? "completed" : "inProgress",
      result: completeInitial ? "result A" : undefined,
    }),
  );
  if (completeInitial) {
    await complete("turn-a", "result A");
    await client.notify({
      method: "item/completed",
      params: {
        threadId: parentThreadId,
        turnId: "parent-turn-a",
        item: {
          type: "collabAgentToolCall",
          tool: "wait",
          status: "completed",
          senderThreadId: parentThreadId,
          receiverThreadIds: ["child-thread"],
          agentsStates: { "child-thread": { status: "completed", message: "result A" } },
        },
      },
    });
  }
  await initialOwner.unregister();
  expect(records.size).toBe(1);
  const initial = structuredClone(records.get(initialRunId));
  expect(initial).toMatchObject({ detail: { nativeHistory: historyOwner } });
  runtime.deliverAgentHarnessTaskCompletion.mockClear();
  const call = () =>
    client.notify({
      method: "item/completed",
      params: {
        threadId: parentThreadId,
        turnId: receipt.parentTurnId,
        item: {
          id: receipt.callId,
          type: "collabAgentToolCall",
          tool: "sendInput",
          status: "completed",
          senderThreadId: parentThreadId,
          receiverThreadIds: [receipt.childThreadId],
          agentsStates: { "child-thread": { status: "running" } },
        },
      },
    });
  const expectUnchanged = () => {
    expect(records.size).toBe(1);
    expect(records.get(initialRunId)).toEqual(initial);
    expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
  };
  return { client, records, runtime, monitor, register, complete, initial, call, expectUnchanged };
}

describe("native follow-up hook receipts", () => {
  it.each([
    ["550E8400-E29B-41D4-A716-446655440000", "550e8400-e29b-41d4-a716-446655440000"],
    ["550E8400E29B41D4A716446655440000", "550e8400-e29b-41d4-a716-446655440000"],
    ["{550E8400-E29B-41D4-A716-446655440000}", "550e8400-e29b-41d4-a716-446655440000"],
    ["urn:uuid:550E8400-E29B-41D4-A716-446655440000", "550e8400-e29b-41d4-a716-446655440000"],
    ["Child-Thread", "Child-Thread"],
    ["{550E8400E29B41D4A716446655440000}", "{550E8400E29B41D4A716446655440000}"],
    [
      "URN:UUID:550E8400-E29B-41D4-A716-446655440000",
      "URN:UUID:550E8400-E29B-41D4-A716-446655440000",
    ],
  ])("normalizes only a native UUID target (%s)", (target, expected) => {
    const acknowledgement = readCodexNativeSubagentSubmissionAcknowledgement({
      session_id: "Native-Session",
      agent_id: "Native-Sender",
      turn_id: "Native-Turn",
      hook_event_name: "PostToolUse",
      tool_name: "multi_agent_v1send_input",
      tool_use_id: "Native-Call",
      tool_input: { target },
      tool_response: JSON.stringify({ submission_id: "Native-Result" }),
    });
    expect(acknowledgement).toEqual({
      nativeSessionId: "Native-Session",
      senderThreadId: "Native-Sender",
      parentTurnId: "Native-Turn",
      callId: "Native-Call",
      childThreadId: expected,
      submissionId: "Native-Result",
    });
  });

  it.each(["call-first", "hook-first", "before-bind", "before-bind-and-call"] as const)(
    "admits the exact follow-up once with %s ordering",
    async (order) => {
      const fixture = await createFixture();
      const { client, records, runtime, register, complete, initial, call, expectUnchanged } =
        fixture;
      const parent = register();
      const beforeBind = order === "before-bind" || order === "before-bind-and-call";
      if (!beforeBind) {
        parent.bindTurn(receipt.parentTurnId);
      }
      await client.notify(turnStartedNotification("turn-b"));
      expectUnchanged();
      if (order === "call-first" || order === "before-bind") {
        await call();
      }
      const acknowledgement =
        order === "call-first" ? { ...receipt, senderThreadId: parentThreadId } : receipt;
      await parent.observeSubmissionAcknowledgement(acknowledgement, () => {});
      if (beforeBind) {
        expectUnchanged();
        parent.bindTurn(receipt.parentTurnId);
      }
      if (order === "hook-first" || order === "before-bind-and-call") {
        await call();
      }
      await parent.observeSubmissionAcknowledgement(acknowledgement, () => {});
      expect(records.size).toBe(2);
      expect(records.get(followupRunId)).toMatchObject({ status: "running" });
      expect(records.get(initialRunId)).toEqual(initial);
      await parent.unregister();
      await complete("turn-b", "result B");
      await complete("turn-b", "result B");
      expect(records.get(followupRunId)).toMatchObject({
        status: "succeeded",
        deliveryStatus: "delivered",
      });
      expect(records.get(initialRunId)).toEqual(initial);
      expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ childSessionKey: followupRunId, result: "result B" }),
      );
    },
  );

  it.each([
    { field: "nativeSessionId", value: parentThreadId },
    { field: "senderThreadId", value: "other-parent" },
    { field: "parentTurnId", value: "other-turn" },
    { field: "childThreadId", value: "other-child" },
  ] as const)(
    "rejects the wrong $field without consuming the valid receipt",
    async ({ field, value }) => {
      const fixture = await createFixture();
      const parent = fixture.register();
      parent.bindTurn(receipt.parentTurnId);
      await fixture.call();
      await expect(
        parent.observeSubmissionAcknowledgement({ ...receipt, [field]: value }, () => {}),
      ).rejects.toThrow();
      await fixture.client.notify(turnStartedNotification("turn-b"));
      fixture.expectUnchanged();
      await parent.observeSubmissionAcknowledgement(receipt, () => {});
      expect(fixture.records.get(followupRunId)).toMatchObject({ status: "running" });
      expect(fixture.records.get(initialRunId)).toEqual(fixture.initial);
      await parent.unregister();
    },
  );

  it("rejects conflicting acknowledgements while retaining the accepted submission", async () => {
    const fixture = await createFixture();
    const parent = fixture.register();
    parent.bindTurn(receipt.parentTurnId);
    await fixture.call();
    await parent.observeSubmissionAcknowledgement(receipt, () => {});
    await expect(
      parent.observeSubmissionAcknowledgement(
        { ...receipt, submissionId: "conflicting-turn" },
        () => {},
      ),
    ).rejects.toThrow("Conflicting native submission");
    fixture.expectUnchanged();
    await fixture.client.notify(turnStartedNotification("turn-b"));
    expect(fixture.records.get(followupRunId)).toMatchObject({ status: "running" });
    expect(fixture.records.has("codex-thread:child-thread:turn:conflicting-turn")).toBe(false);
    expect(fixture.records.get(initialRunId)).toEqual(fixture.initial);
    await parent.unregister();
  });

  it("keeps an accepted follow-up behind an earlier unowned native turn", async () => {
    const fixture = await createFixture();
    const parent = fixture.register();
    parent.bindTurn(receipt.parentTurnId);
    await fixture.call();
    await parent.observeSubmissionAcknowledgement(receipt, () => {});
    await expect(
      parent.observeSubmissionAcknowledgement(
        { ...receipt, submissionId: "unowned-turn" },
        () => {},
      ),
    ).rejects.toThrow("Conflicting native submission");
    await fixture.client.notify(turnStartedNotification("unowned-turn"));
    await fixture.client.notify(turnStartedNotification("turn-b"));
    fixture.expectUnchanged();
    expect(fixture.records.has("codex-thread:child-thread:turn:unowned-turn")).toBe(false);
    expect(fixture.records.has(followupRunId)).toBe(false);
    await parent.unregister();
  });

  it("requires the acknowledgement call ID to match the observed native call", async () => {
    const fixture = await createFixture();
    const parent = fixture.register();
    parent.bindTurn(receipt.parentTurnId);
    await parent.observeSubmissionAcknowledgement({ ...receipt, callId: "other-call" }, () => {});
    await fixture.call();
    await fixture.client.notify(turnStartedNotification("turn-b"));
    fixture.expectUnchanged();
    await parent.observeSubmissionAcknowledgement(receipt, () => {});
    expect(fixture.records.get(followupRunId)).toMatchObject({ status: "running" });
    expect(fixture.records.get(initialRunId)).toEqual(fixture.initial);
    await parent.unregister();
  });

  it("bounds unmatched acknowledgements without admitting a native turn", async () => {
    const fixture = await createFixture();
    const parent = fixture.register();
    parent.bindTurn(receipt.parentTurnId);
    for (let index = 0; index < 32; index += 1) {
      await parent.observeSubmissionAcknowledgement(
        { ...receipt, callId: `unmatched-${index}` },
        () => {},
      );
    }
    await expect(
      parent.observeSubmissionAcknowledgement({ ...receipt, callId: "unmatched-32" }, () => {}),
    ).rejects.toThrow("Native submission acknowledgement capacity reached");
    await fixture.client.notify(turnStartedNotification("turn-b"));
    fixture.expectUnchanged();
    await parent.unregister();
  });

  it("keeps an opaque steering receipt on the existing child assignment", async () => {
    const fixture = await createFixture(false);
    const parent = fixture.register();
    parent.bindTurn(receipt.parentTurnId);
    await fixture.call();
    await parent.observeSubmissionAcknowledgement(
      { ...receipt, submissionId: "opaque-steering-receipt" },
      () => {},
    );
    await fixture.client.notify(turnStartedNotification("turn-a"));
    expect(fixture.records.size).toBe(1);
    expect(fixture.records.get(initialRunId)).toMatchObject({ status: "running" });
    await parent.unregister();
    await fixture.complete("turn-a", "result A");
    expect(fixture.records.size).toBe(1);
    expect(fixture.records.get(initialRunId)).toMatchObject({ status: "succeeded" });
    expect(fixture.records.has(followupRunId)).toBe(false);
  });

  it.each(["unregistered", "revoked"] as const)(
    "rejects an acknowledgement from an %s owner",
    async (state) => {
      const fixture = await createFixture();
      const parent = fixture.register();
      parent.bindTurn(receipt.parentTurnId);
      await fixture.call();
      if (state === "unregistered") {
        await parent.unregister();
        fixture.register().bindTurn(receipt.parentTurnId);
      }
      const assertCurrent = vi.fn(() => {
        if (state === "revoked") {
          throw new Error("hook authority closed");
        }
      });
      await expect(
        parent.observeSubmissionAcknowledgement(receipt, assertCurrent),
      ).rejects.toThrow();
      await fixture.client.notify(turnStartedNotification("turn-b"));
      fixture.expectUnchanged();
    },
  );

  it("revalidates buffered hook authority when the native call arrives", async () => {
    const fixture = await createFixture();
    const parent = fixture.register();
    parent.bindTurn(receipt.parentTurnId);
    let current = true;
    const assertCurrent = () => {
      if (!current) {
        throw new Error("hook authority closed");
      }
    };
    await parent.observeSubmissionAcknowledgement(receipt, assertCurrent);
    current = false;
    await expect(fixture.call()).rejects.toThrow("hook authority closed");
    await fixture.client.notify(turnStartedNotification("turn-b"));
    fixture.expectUnchanged();
  });
});
