import { vi } from "vitest";
import type {
  EmbeddedAgentQueueMessageOptions,
  EmbeddedAgentQueueMessageOutcome,
} from "../../embedded-agent-runner/runs.js";

// Shared constructors for synthetic announcement delivery outcomes; no setup runs here.
type EmbeddedAgentQueueFailureReason = Extract<
  EmbeddedAgentQueueMessageOutcome,
  { queued: false }
>["reason"];

export type QueueEmbeddedAgentMessageWithOutcome = (
  sessionId: string,
  message: string,
  options?: EmbeddedAgentQueueMessageOptions,
) => EmbeddedAgentQueueMessageOutcome | Promise<EmbeddedAgentQueueMessageOutcome>;

export function createQueueOutcomeMock(
  queued: boolean,
): ReturnType<typeof vi.fn<QueueEmbeddedAgentMessageWithOutcome>> {
  return vi.fn((sessionId: string) =>
    queued
      ? {
          queued: true,
          sessionId,
          target: "embedded_run",
          gatewayHealth: "live",
          enqueuedAtMs: 4_100,
          deliveredAtMs: 4_200,
        }
      : {
          queued: false,
          sessionId,
          reason: "not_streaming",
          gatewayHealth: "live",
        },
  );
}

export function createQueueOutcomeSequenceMock(
  queuedOutcomes: (boolean | EmbeddedAgentQueueFailureReason)[],
  onCall?: () => void,
): ReturnType<typeof vi.fn<QueueEmbeddedAgentMessageWithOutcome>> {
  // Sequence mocks model retry paths where the embedded run can become
  // unavailable between announce attempts.
  let index = 0;
  return vi.fn((sessionId: string) => {
    onCall?.();
    const outcome = queuedOutcomes[Math.min(index, queuedOutcomes.length - 1)] ?? false;
    index += 1;
    return outcome === true
      ? {
          queued: true,
          sessionId,
          target: "embedded_run",
          gatewayHealth: "live",
        }
      : {
          queued: false,
          sessionId,
          reason: typeof outcome === "string" ? outcome : "not_streaming",
          gatewayHealth: "live",
        };
  });
}

export function visibleAgentResponse(runId = "run-main") {
  return {
    runId,
    status: "ok",
    result: {
      payloads: [{ text: "announced" }],
      didSendViaMessagingTool: true,
      messagingToolSentTexts: ["announced"],
      didDeliverSourceReplyViaMessageTool: true,
      messagingToolSourceReplyPayloads: [{ text: "announced", sourceReplyFinal: true }],
    },
  };
}
