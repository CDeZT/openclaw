import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { createNestedToolActivity } from "../sessions/nested-tool-activity.js";
import { projectChatDisplayMessage } from "./chat-display-projection.js";
import { projectTranscriptEntryMessage } from "./session-transcript-entry-message.js";
import { projectSessionMessagePayload } from "./session-transcript-message.js";

const position = { source: "selected-snapshot", rawSeq: 4 };
const message = {
  role: "assistant",
  content: "done",
  __openclaw: { transcriptPosition: { source: "untrusted", rawSeq: 0 } },
};

describe("trusted transcript display metadata", () => {
  it("keeps nested activity run ownership distinct from entry deduplication in history and live events", () => {
    const activity = {
      ...createNestedToolActivity({
        runId: "owning-run",
        scopeId: "attempt",
        afterEntryId: "parent",
        startOrder: 0,
        parentToolCallId: "exec",
        toolCallId: "nested-read",
        toolName: "read",
        input: { path: "example.txt" },
        result: { content: [{ type: "text", text: "done" }] },
        isError: false,
        startedAt: 1,
        timestamp: 2,
      }),
      idempotencyKey: "attempt:nested-read",
    };
    const history = projectChatDisplayMessage(
      projectTranscriptEntryMessage(
        { type: "message", id: "entry", message: activity },
        2,
        position,
      ),
    );
    const live = projectSessionMessagePayload({
      message: activity,
      messageId: "entry",
      messageSeq: 2,
      transcriptPosition: position,
      sessionKey: "agent:main:dashboard:nested",
    }).payload?.message;
    for (const projected of [history, live]) {
      expect(readSessionMessageIdentity(projected)).toMatchObject({
        id: "entry",
        sequence: 2,
        runId: "owning-run",
        idempotencyKey: "attempt:nested-read",
        sendId: null,
      });
      expect(
        asOptionalRecord(asOptionalRecord(projected)?.["__openclaw"])?.transcriptPosition,
      ).toEqual(position);
    }
    expect(activity).not.toHaveProperty("__openclaw");
  });

  it.each([
    { transcriptPosition: undefined, custom: false },
    { transcriptPosition: position, custom: false },
    { transcriptPosition: undefined, custom: true },
    { transcriptPosition: position, custom: true },
  ])("uses only reader-supplied placement (%j)", ({ transcriptPosition, custom }) => {
    const customMessage = {
      role: "custom",
      customType: "run-failed-before-reply",
      content: "This turn ended before a reply.",
      display: true,
      details: { runId: "failed-run", error: "PRIVATE_DIAGNOSTIC" },
    };
    const timestamp = "2026-09-08T00:00:00.000Z";
    const history = projectTranscriptEntryMessage(
      custom
        ? { ...customMessage, type: "custom_message", id: "entry", timestamp }
        : { type: "message", id: "entry", message },
      2,
      transcriptPosition,
    );
    const live = projectSessionMessagePayload({
      message: custom ? { ...customMessage, timestamp: Date.parse(timestamp) } : message,
      messageId: "entry",
      messageSeq: 2,
      transcriptPosition,
      sessionKey: "agent:main:main",
    }).payload?.message;
    for (const projected of [projectChatDisplayMessage(history), live]) {
      const metadata = asOptionalRecord(asOptionalRecord(projected)?.["__openclaw"]);
      expect(metadata?.transcriptPosition).toEqual(transcriptPosition);
      expect(metadata).toMatchObject({ id: "entry", seq: 2 });
      if (custom) {
        expect(readSessionMessageIdentity(projected)?.runId).toBe("failed-run");
        expect(projected).toMatchObject({
          role: "custom",
          customType: "run-failed-before-reply",
          content: customMessage.content,
          display: true,
          timestamp: Date.parse(timestamp),
        });
        expect(projected).not.toHaveProperty("details");
      }
    }
    expect(message["__openclaw"].transcriptPosition.source).toBe("untrusted");
  });

  it.each(["compaction", "reset"])(
    "keeps %s markers in the same physical coordinate space",
    (type) => {
      const identity = { runId: "run-compaction", itemId: "item-compaction" };
      const projected = asOptionalRecord(
        projectTranscriptEntryMessage({ type, id: "boundary", __openclaw: identity }, 3, position),
      );
      expect(projected?.role).toBe("system");
      expect(projected?.["__openclaw"]).toEqual({
        kind: type,
        id: "boundary",
        seq: 3,
        transcriptPosition: position,
        ...(type === "compaction" ? identity : {}),
      });
    },
  );

  it("keeps retained failure details and run correlation in history and live projection", () => {
    const content = `This turn ended before a reply: Worker setup failed\n${"  at prepareWorkspace (worker.ts:42)\n".repeat(260)}Cause: network allocation failed`;
    const failure = {
      role: "custom",
      customType: "run-failed-before-reply",
      content,
      display: true,
      details: { runId: "failed-run", error: "PRIVATE_DIAGNOSTIC" },
    };
    const history = projectTranscriptEntryMessage(
      { ...failure, type: "custom_message", id: "failure-entry" },
      2,
      position,
    );
    const live = projectSessionMessagePayload({
      message: failure,
      messageId: "failure-entry",
      messageSeq: 2,
      sessionKey: "agent:main:main",
    }).payload?.message;
    expect(content.length).toBeGreaterThan(8_000);
    for (const projected of [projectChatDisplayMessage(history), live]) {
      expect(projected).toMatchObject({ content });
      expect(readSessionMessageIdentity(projected)?.runId).toBe("failed-run");
      expect(projected).not.toHaveProperty("details");
      expect(JSON.stringify(projected)).not.toContain("PRIVATE_DIAGNOSTIC");
    }
    // The failure allowance must not raise explicit caps or ordinary message caps.
    expect(projectChatDisplayMessage(history, { maxChars: 512 })?.content).not.toContain("Cause:");
    expect(projectChatDisplayMessage({ role: "user", content })?.content).not.toContain("Cause:");
    const oversized = projectChatDisplayMessage({ ...failure, content: "x".repeat(20_000) });
    expect(String(oversized?.content).length).toBeLessThan(10_100);
    expect(oversized?.__openclaw).toMatchObject({ truncated: true });
  });
});
