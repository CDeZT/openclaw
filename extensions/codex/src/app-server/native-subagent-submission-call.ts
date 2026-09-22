import type { AgentHarnessTaskRecord } from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { readCodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import { readNativeTurnEnd, readThreadParentThreadId } from "./native-subagent-history-recovery.js";
import type {
  ChildState,
  KnownChild,
  ParentOwner,
  ParentState,
} from "./native-subagent-monitor-types.js";
import type {
  CodexNativeSubagentSubmission,
  CodexNativeSubagentSubmissionAcknowledgement,
} from "./native-subagent-submission.js";
import { readNativeTaskAssignment } from "./native-subagent-task-ids.js";
import { isJsonObject, type JsonObject } from "./protocol.js";

export function readNativeSubagentSubmissionTaskState(
  task: AgentHarnessTaskRecord | undefined,
  receipt: CodexNativeSubagentSubmission,
  nativeParentThreadId: string,
): "invalid" | "delivered" | undefined {
  if (!task) {
    return undefined;
  }
  const assignment = readNativeTaskAssignment(task);
  const history = readCodexNativeSubagentHistoryOwner(task.detail);
  if (
    assignment?.nativeTurnId !== receipt.submissionId ||
    (history && history.parentThreadId !== nativeParentThreadId)
  ) {
    return "invalid";
  }
  return (task.status === "succeeded" || task.status === "failed" || task.status === "cancelled") &&
    task.deliveryStatus === "delivered"
    ? "delivered"
    : undefined;
}

export type NativeSubagentHookAcknowledgement = {
  receipt: CodexNativeSubagentSubmissionAcknowledgement;
  owner: ParentOwner;
  assertCurrent: () => void;
};

export function recordNativeSubagentHookAcknowledgement(params: {
  state: ParentState;
  receipt: CodexNativeSubagentSubmissionAcknowledgement;
  owner: ParentOwner;
  nativeSessionId: string | undefined;
  assertCurrent: () => void;
  entries: Map<string, NativeSubagentHookAcknowledgement>;
}): string {
  const { state, receipt, owner, nativeSessionId, entries } = params;
  if (
    !nativeSessionId ||
    receipt.nativeSessionId !== nativeSessionId ||
    (receipt.senderThreadId !== undefined && receipt.senderThreadId !== state.parentThreadId)
  ) {
    throw new Error("Native submission sender does not match its registered parent.");
  }
  if (owner.turnId && owner.turnId !== receipt.parentTurnId) {
    throw new Error("Native submission sender turn does not match its parent owner.");
  }
  const key = `${receipt.parentTurnId}\0${receipt.callId}`;
  const previous = entries.get(key);
  if (
    previous &&
    (previous.owner !== owner ||
      previous.receipt.childThreadId !== receipt.childThreadId ||
      previous.receipt.submissionId !== receipt.submissionId)
  ) {
    throw new Error("Conflicting native submission acknowledgement.");
  }
  if (!previous) {
    if (entries.size >= 32) {
      throw new Error("Native submission acknowledgement capacity reached.");
    }
    entries.set(key, { receipt, owner, assertCurrent: params.assertCurrent });
  }
  return key;
}

export function takeNativeSubagentHookAcknowledgement(params: {
  state: ParentState;
  key: string;
  entries: Map<string, NativeSubagentHookAcknowledgement> | undefined;
  call: NativeSubagentSubmissionCall | undefined;
  parentOwner: (state: ParentState, turnId: string) => ParentOwner | undefined;
}): { call: NativeSubagentSubmissionCall; submissionId: string } | undefined {
  const { state, key, entries, call } = params;
  const acknowledgement = entries?.get(key);
  if (!entries || !acknowledgement || !call) {
    return undefined;
  }
  const { receipt, owner, assertCurrent } = acknowledgement;
  if (call.childThreadIds.length !== 1 || call.childThreadIds[0] !== receipt.childThreadId) {
    entries.delete(key);
    throw new Error("Native submission target does not match the observed call.");
  }
  if (call.closed) {
    entries.delete(key);
    if (call.submissionId !== receipt.submissionId) {
      throw new Error("Conflicting native submission result.");
    }
    return undefined;
  }
  if (!owner.turnId) {
    return undefined;
  }
  assertCurrent();
  entries.delete(key);
  if (
    owner.turnId !== receipt.parentTurnId ||
    params.parentOwner(state, receipt.parentTurnId) !== owner ||
    (call.owner && call.owner !== owner)
  ) {
    throw new Error("Native submission acknowledgement owner changed.");
  }
  return { call, submissionId: receipt.submissionId };
}

export function readNativeSubagentSubmissionTurn(
  thread: JsonObject | undefined,
  receipt: CodexNativeSubagentSubmission,
  nativeParentThreadId: string,
): JsonObject | undefined {
  if (
    readString(thread, "id") !== receipt.childThreadId ||
    readThreadParentThreadId(thread) !== nativeParentThreadId
  ) {
    return undefined;
  }
  const turns = (Array.isArray(thread?.turns) ? thread.turns : []).filter(isJsonObject);
  const predecessorIndex = turns.findIndex(
    (turn) => readString(turn, "id") === receipt.predecessorNativeTurnId,
  );
  const turnIndex = turns.findIndex((turn) => readString(turn, "id") === receipt.submissionId);
  return predecessorIndex >= 0 &&
    turnIndex > predecessorIndex &&
    ["completed", "failed"].includes(readString(turns[predecessorIndex], "status") ?? "")
    ? turns[turnIndex]
    : undefined;
}

type Predecessor =
  | { runId: string; nativeTurnId: string; terminal: boolean }
  | { child: ChildState };

export type NativeSubagentSubmissionCall = {
  parentTurnId: string;
  callId: string;
  childThreadIds: readonly string[];
  targets: Array<{ childThreadId: string; predecessor: Predecessor }>;
  owner?: ParentOwner;
  submissionId?: string;
  closed?: true;
  accepted?: true;
};

export function hasSubmissionCallCustody(
  state: ParentState,
  call: NativeSubagentSubmissionCall,
  hasObservationBacking?: (parentThreadId: string, childThreadId: string) => boolean,
): boolean {
  return Boolean(
    call.accepted &&
    call.targets.some(
      ({ childThreadId }) =>
        state.owners.size > 0 || hasObservationBacking?.(state.parentThreadId, childThreadId),
    ),
  );
}

export function captureSubmissionPredecessor(params: {
  state: ParentState;
  known: KnownChild | undefined;
  child: ChildState | undefined;
}): Predecessor | undefined {
  const { state, known, child } = params;
  if (known?.parent !== state) {
    return undefined;
  }
  if (!known.assignment.nativeTurnId) {
    // A fresh observed child can supply its own delayed anchor; a restored
    // anchorless row cannot select a predecessor from later history.
    return child &&
      child.runId === known.assignment.runId &&
      !child.terminal &&
      !known.assignment.terminal &&
      !known.assignment.unanchored
      ? { child }
      : undefined;
  }
  return {
    runId: known.assignment.runId,
    nativeTurnId: known.assignment.nativeTurnId,
    terminal:
      known.assignment.terminal ||
      child?.nativeTurnState === "completed" ||
      child?.nativeTurnState === "failed",
  };
}

export function observeSubmissionPredecessor(params: {
  state: ParentState;
  call: NativeSubagentSubmissionCall;
  threadId: string;
  turn?: JsonObject;
  known: KnownChild | undefined;
  hasObservationBacking?: (parentThreadId: string, childThreadId: string) => boolean;
  acceptContinuation: (owner: ParentOwner) => void;
  capture: (receipt: CodexNativeSubagentSubmission, owner: ParentOwner | undefined) => void;
}): void {
  const { state, call, threadId, turn, known } = params;
  const submissionId = call.submissionId;
  if (!call.accepted || !submissionId) {
    return;
  }
  call.targets = call.targets.filter(({ childThreadId, predecessor }) => {
    if (childThreadId !== threadId || !("child" in predecessor)) {
      return true;
    }
    const child = predecessor.child;
    if (
      known?.parent !== state ||
      known.assignment.runId !== child.runId ||
      (state.owners.size === 0 && !params.hasObservationBacking?.(state.parentThreadId, threadId))
    ) {
      return false;
    }
    const nativeTurnId = child.nativeTurnId;
    if (
      !nativeTurnId ||
      nativeTurnId === submissionId ||
      known.assignment.nativeTurnId !== nativeTurnId
    ) {
      return true;
    }
    const ended = readString(turn, "id") === nativeTurnId ? readNativeTurnEnd(turn) : undefined;
    const nativeState = ended ?? child.nativeTurnState;
    const owner =
      call.owner && [...state.owners.values()].includes(call.owner) ? call.owner : undefined;
    if (nativeState === "interrupted") {
      if (owner) {
        params.acceptContinuation(owner);
      }
      return false;
    }
    if (!known.assignment.terminal && nativeState !== "completed" && nativeState !== "failed") {
      return true;
    }
    params.capture(
      {
        parentTurnId: call.parentTurnId,
        callId: call.callId,
        childThreadId,
        submissionId,
        predecessorRunId: child.runId,
        predecessorNativeTurnId: nativeTurnId,
      },
      owner,
    );
    return false;
  });
  if (call.targets.length === 0) {
    call.owner = undefined;
  }
}
