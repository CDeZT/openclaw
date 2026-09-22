import type {
  SessionHistoryWorkerDatabase,
  SessionHistoryWorkerInput,
  SessionHistoryWorkerPreparedInput,
  SessionTranscriptWorkerValues,
} from "./session-transcript-worker.types.js";

export type SessionHistoryWorkerRequestRunner = <TResult>(
  prepare: () => SessionHistoryWorkerPreparedInput,
  inputBytes: number,
  receive: (value: SessionTranscriptWorkerValues[SessionHistoryWorkerInput["kind"]]) => TResult,
  signal?: AbortSignal,
) => Promise<TResult>;

/** Decode domain results; database custody remains with the enclosing history owner. */
export function createSessionHistoryWorkerReaders(
  runRequest: SessionHistoryWorkerRequestRunner,
): Omit<SessionHistoryWorkerDatabase, "generation" | "assertCurrent"> {
  return {
    searchTranscripts: async (params) =>
      await runRequest(
        () => ({ kind: "transcript-search", params }),
        JSON.stringify(params).length * 2,
        (value) => {
          if (
            typeof value === "boolean" ||
            Array.isArray(value) ||
            value.kind !== "transcript-search"
          ) {
            throw new Error("Session history worker returned another result instead of search");
          }
          return value.result;
        },
      ),
    readPreview: async (input) =>
      await runRequest(
        () => ({ kind: "session-preview", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          if (
            typeof value === "boolean" ||
            Array.isArray(value) ||
            value.kind !== "session-preview"
          ) {
            throw new Error("Session history worker returned another result instead of a preview");
          }
          return value.items;
        },
      ),
    readTitleFields: async (input) =>
      await runRequest(
        () => ({ kind: "session-title-fields", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          if (
            typeof value === "boolean" ||
            Array.isArray(value) ||
            value.kind !== "session-title-fields"
          ) {
            throw new Error(
              "Session history worker returned another result instead of title fields",
            );
          }
          return value.fields;
        },
      ),
    run: async (prepare, inputBytes) =>
      await runRequest(prepare, inputBytes, (value) => {
        if (
          typeof value === "boolean" ||
          Array.isArray(value) ||
          (value.kind !== "rpc" &&
            value.kind !== "http" &&
            value.kind !== "delta" &&
            value.kind !== "message-lookup")
        ) {
          throw new Error("Session history worker returned metadata instead of history");
        }
        return value;
      }),
    readTranscript: async (input, signal) =>
      await runRequest(
        () => ({ kind: "transcript-hydration", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          if (
            typeof value === "boolean" ||
            Array.isArray(value) ||
            (value.kind !== "full" && value.kind !== "bounded")
          ) {
            throw new Error(
              "Session history worker returned another result instead of a transcript",
            );
          }
          return value;
        },
        signal,
      ),
    readUsageCache: async (input) =>
      await runRequest(
        () => ({ kind: "usage-cache", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          if (
            typeof value === "boolean" ||
            Array.isArray(value) ||
            value.kind !== "usage-refresh-lock"
          ) {
            throw new Error(
              "Session history worker returned another result instead of usage cache",
            );
          }
          return value;
        },
      ),
    readMembers: async (input) =>
      await runRequest(
        () => ({ kind: "session-members", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          if (!Array.isArray(value)) {
            throw new Error("Session history worker returned another result instead of members");
          }
          return value;
        },
      ),
    readExactEntries: async (input) =>
      await runRequest(
        () => ({ kind: "session-exact-entries", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          if (
            typeof value === "boolean" ||
            Array.isArray(value) ||
            value.kind !== "session-exact-entries"
          ) {
            throw new Error(
              "Session history worker returned another result instead of exact entries",
            );
          }
          return value;
        },
      ),
    readEntries: async (scope) =>
      await runRequest(
        () => ({ kind: "session-entry-list", scope }),
        JSON.stringify(scope).length * 2,
        (value) => {
          if (
            typeof value === "boolean" ||
            Array.isArray(value) ||
            value.kind !== "session-entry-list"
          ) {
            throw new Error("Session history worker returned another result instead of entries");
          }
          return value.entries;
        },
      ),
    readIdentityEvidence: async (input) =>
      await runRequest(
        () => ({ kind: "session-identity-evidence", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          if (
            typeof value === "boolean" ||
            Array.isArray(value) ||
            value.kind !== "session-identity-evidence"
          ) {
            throw new Error(
              "Session history worker returned another result instead of identity evidence",
            );
          }
          return value.evidence;
        },
      ),
    readEntryPresence: async (scope) =>
      await runRequest(
        () => ({ kind: "session-row-presence", scope }),
        JSON.stringify(scope).length * 2,
        (value) => {
          if (typeof value !== "boolean") {
            throw new Error("Session history worker returned history instead of metadata presence");
          }
          return value;
        },
      ),
  };
}
