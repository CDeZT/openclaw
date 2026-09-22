import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  codexNativeSubagentHistoryOwnerSchema,
  matchesCodexNativeSubagentHistoryOwner,
  type CodexNativeSubagentHistoryOwner,
} from "./native-subagent-history-owner.js";

const identifier = z.string().refine((value) => Boolean(value.trim()));
export const CODEX_NATIVE_SUBAGENT_SUBMISSION_HOOK_TOOL = "multi_agent_v1send_input";
const nativeSubmissionHookSchema = z.object({
  session_id: identifier,
  agent_id: identifier.optional(),
  turn_id: identifier,
  hook_event_name: z.literal("PostToolUse"),
  tool_name: z.literal(CODEX_NATIVE_SUBAGENT_SUBMISSION_HOOK_TOOL),
  tool_use_id: identifier,
  tool_input: z.object({ target: identifier }),
  tool_response: z.string(),
});
const nativeSubmissionResultSchema = z.object({ submission_id: identifier });
const nativeHyphenatedUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function canonicalizeNativeSubmissionTarget(target: string): string {
  // Codex parses the input with uuid::Uuid but emits canonical receiver thread IDs.
  const unwrapped =
    target.length === 38 && target.startsWith("{") && target.endsWith("}")
      ? target.slice(1, -1)
      : target.length === 45 && target.startsWith("urn:uuid:")
        ? target.slice(9)
        : target;
  if (nativeHyphenatedUuid.test(unwrapped)) {
    return unwrapped.toLowerCase();
  }
  if (/^[0-9a-f]{32}$/i.test(target)) {
    const hex = target.toLowerCase();
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return target;
}

export type CodexNativeSubagentSubmissionAcknowledgement = Readonly<{
  nativeSessionId: string;
  senderThreadId?: string;
  parentTurnId: string;
  callId: string;
  childThreadId: string;
  submissionId: string;
}>;

/** Codex's successful PostToolUse carries the native result, before Code Mode can display it. */
export function readCodexNativeSubagentSubmissionAcknowledgement(
  rawPayload: unknown,
): CodexNativeSubagentSubmissionAcknowledgement {
  const payload = nativeSubmissionHookSchema.parse(rawPayload);
  const result = nativeSubmissionResultSchema.parse(JSON.parse(payload.tool_response));
  return Object.freeze({
    nativeSessionId: payload.session_id,
    ...(payload.agent_id ? { senderThreadId: payload.agent_id } : {}),
    parentTurnId: payload.turn_id,
    callId: payload.tool_use_id,
    childThreadId: canonicalizeNativeSubmissionTarget(payload.tool_input.target),
    submissionId: result.submission_id,
  });
}

const submissionSchema = z
  .object({
    parentTurnId: identifier,
    callId: identifier,
    childThreadId: identifier,
    submissionId: identifier,
    predecessorRunId: identifier,
    predecessorNativeTurnId: identifier,
  })
  .strict();
const submissionsSchema = z
  .object({
    version: z.literal(1),
    owner: codexNativeSubagentHistoryOwnerSchema,
    receipts: z.array(submissionSchema),
  })
  .strict()
  .refine(
    ({ receipts }) =>
      new Set(receipts.map(({ parentTurnId, callId }) => JSON.stringify([parentTurnId, callId])))
        .size === receipts.length,
  );

export type CodexNativeSubagentSubmission = z.infer<typeof submissionSchema>;
export type CodexNativeSubagentSubmissions = z.infer<typeof submissionsSchema>;

export type CodexNativeSubagentSubmissionStore = {
  assertCurrent(): void;
  read(): readonly CodexNativeSubagentSubmission[];
  record(receipt: CodexNativeSubagentSubmission, assertCurrent: () => void): Promise<boolean>;
  consume(receipt: CodexNativeSubagentSubmission, assertCurrent: () => void): Promise<boolean>;
};

export function matchesCodexNativeSubagentSubmissionOwner(
  stored: CodexNativeSubagentHistoryOwner,
  current: CodexNativeSubagentHistoryOwner,
): boolean {
  return (
    stored.parentThreadId === current.parentThreadId &&
    matchesCodexNativeSubagentHistoryOwner(stored, current)
  );
}

export function readCodexNativeSubagentSubmissions(
  value: unknown,
): CodexNativeSubagentSubmissions | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = submissionsSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Invalid Codex native subagent submission metadata.");
  }
  return parsed.data;
}

export function mutateCodexNativeSubagentSubmissions(params: {
  current: unknown;
  owner: CodexNativeSubagentHistoryOwner;
  receipt: CodexNativeSubagentSubmission;
  consume: boolean;
}): { applied: boolean; next?: CodexNativeSubagentSubmissions } {
  const current = readCodexNativeSubagentSubmissions(params.current);
  const owner = codexNativeSubagentHistoryOwnerSchema.parse(params.owner);
  const receipt = submissionSchema.parse(params.receipt);
  if (current && !matchesCodexNativeSubagentSubmissionOwner(current.owner, owner)) {
    return { applied: false };
  }
  const receipts = current?.receipts ?? [];
  const existing = receipts.find(
    (entry) => entry.parentTurnId === receipt.parentTurnId && entry.callId === receipt.callId,
  );
  if (existing && !isDeepStrictEqual(existing, receipt)) {
    return { applied: false };
  }
  if (params.consume) {
    if (!current) {
      return { applied: false };
    }
    const remaining = receipts.filter((entry) => entry !== existing);
    return {
      applied: true,
      ...(remaining.length
        ? { next: { version: 1, owner: current.owner, receipts: remaining } }
        : {}),
    };
  }
  return {
    applied: true,
    next: {
      version: 1,
      owner: current?.owner ?? owner,
      receipts: existing ? receipts : [...receipts, receipt],
    },
  };
}

/** Physical adoption cannot establish continuity for an unstamped receipt. */
export function adoptCodexNativeSubagentSubmissions(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  const parsed = submissionsSchema.safeParse(value);
  return !parsed.success || parsed.data.owner.lifecycleRevision ? value : undefined;
}
