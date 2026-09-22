import { describe, expect, it } from "vitest";
import {
  SessionExactReadSourceChangedError,
  sessionExactReadSourceChange,
} from "./session-exact-read-source-error.js";
import {
  sessionHistoryCleanupError,
  unwrapSessionTranscriptWorkerReply,
} from "./session-history-worker-errors.js";

describe("exact-read physical refusal facts", () => {
  it.each(["replaced", "missing"] as const)(
    "retains a real %s observation through joined cleanup",
    (reason) => {
      const original = new SessionExactReadSourceChangedError(reason);
      const joined = sessionHistoryCleanupError(
        original,
        new Error("native close failed"),
        "database close",
      );
      expect(sessionExactReadSourceChange(joined)).toBe(reason);
      expect(() =>
        unwrapSessionTranscriptWorkerReply({
          ok: false,
          error: { kind: "source-changed", reason, message: joined.message },
        }),
      ).toThrow(joined.message);
      try {
        unwrapSessionTranscriptWorkerReply({
          ok: false,
          error: { kind: "source-changed", reason, message: joined.message },
        });
      } catch (error) {
        expect(error).toBeInstanceOf(SessionExactReadSourceChangedError);
        expect(sessionExactReadSourceChange(error)).toBe(reason);
      }
    },
  );

  it("does not infer source loss from ordinary failure prose or a secondary cleanup error", () => {
    const original = new Error("Exact session entry physical source was replaced");
    expect(sessionExactReadSourceChange(original)).toBeUndefined();
    expect(
      sessionExactReadSourceChange(
        sessionHistoryCleanupError(
          original,
          new SessionExactReadSourceChangedError("replaced"),
          "database close",
        ),
      ),
    ).toBeUndefined();
  });

  it("stops on cyclic unrelated error causes", () => {
    const error = new Error("unrelated worker failure");
    error.cause = error;
    expect(sessionExactReadSourceChange(error)).toBeUndefined();
  });
});
