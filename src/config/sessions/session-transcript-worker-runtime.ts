import { expectDefined } from "@openclaw/normalization-core";
import type { SessionCostUsageCacheReadResult } from "../../infra/session-cost-usage-cache-read.js";
import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import { isIncognitoSessionKey } from "../../shared/incognito-session-key.js";
import type {
  OpenClawAgentDatabaseOptions,
  OpenClawAgentDatabaseReadFacts,
} from "../../state/openclaw-agent-db-contract.js";
import { assertOpenClawAgentReadFactsCurrent } from "../../state/openclaw-agent-db-identity.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import { loadSessionEntryReadOnlyInScope } from "./session-accessor.sqlite-entry.js";
import {
  sameExactSessionEntryReadIdentity,
  type ExactSessionEntryReadIdentity,
} from "./session-accessor.sqlite-exact-read.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type { SessionAccessScope } from "./session-accessor.types.js";
import type { CanonicalSessionReaderContinuation } from "./session-canonical-key.js";
import type { SessionHistoryWorkerResult } from "./session-history-types.js";
import {
  sessionHistoryCleanupError,
  unwrapSessionTranscriptWorkerReply,
} from "./session-history-worker-errors.js";
import { listSessionMembers } from "./session-sharing-store.js";
import type { SessionMember } from "./session-sharing-store.kernel.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";
import type {
  ConfiguredSessionStoreTargetResult,
  SessionStoreTargetInventoryResult,
} from "./session-store-target-inventory.js";
import {
  acquireHistoryDatabaseResource,
  armDatabaseWorkerIdleRetirement,
  clearClosedDatabaseCustody,
  historyClearTimeout,
  historyLane,
  historyPages,
  pruneHistoryDatabases,
  rotateDatabaseWorkers,
} from "./session-transcript-worker-resources.js";
import type {
  SessionHistoryWorkerDatabase,
  SessionTranscriptHistoryWorkerInput,
  SessionPreviewWorkerInput,
  SessionPreviewWorkerResult,
  SessionTitleFieldsWorkerInput,
  SessionTitleFieldsWorkerResult,
  SessionRowPresenceWorkerInput,
  SessionRowEntryWorkerInput,
  SessionRowEntryWorkerResult,
  SessionMembersWorkerInput,
  SessionEntryListWorkerInput,
  SessionExactEntriesWorkerInput,
  SessionExactEntriesWorkerResult,
  SessionEntryListWorkerResult,
  SessionIdentityEvidenceWorkerInput,
  SessionIdentityEvidenceWorkerResult,
  SessionUsageCacheWorkerInput,
  SessionTranscriptSearchWorkerInput,
  SessionTranscriptSearchWorkerResult,
} from "./session-transcript-worker.types.js";

export type { SessionHistoryWorkerDatabase } from "./session-transcript-worker.types.js";
export {
  withSessionCostUsageWorkerDatabases,
  type SessionCostUsageWorkerScope,
} from "./session-cost-usage-worker-runtime.js";

function captureSessionRowEntryScope(
  input: SessionRowEntryWorkerInput["scope"],
): SessionRowEntryWorkerInput["scope"] {
  const capturedEnv = cloneEnvWithPlatformSemantics(input.env);
  const env = { ...capturedEnv, OPENCLAW_STATE_DIR: resolveStateDir(capturedEnv) };
  const scope = { ...input, env };
  if (
    isIncognitoSessionKey(scope.sessionKey) ||
    isIncognitoOpenClawAgentSqlitePath(scope.storePath, { agentId: scope.agentId, env })
  ) {
    throw new WorkerTaskError("Incognito session entry requires its native owner", "unavailable");
  }
  return scope;
}

/** Capture the exact metadata owner before initial-writer admission can wait. */
export function prepareSessionEntryPresenceRead(input: SessionAccessScope): Readonly<{
  sessionKey: string;
  storePath: string;
  read: () => Promise<boolean>;
}> {
  const env = { ...(input.env ?? process.env) };
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const storePath = resolveSessionStorePathForScope({ ...input, env });
  const resolved = resolveSqliteScope({ ...input, storePath, env });
  const options = toDatabaseOptions(resolved);
  const databasePath = resolveOpenClawAgentSqlitePath(options);
  const scope: SessionRowPresenceWorkerInput["scope"] = {
    agentId: resolved.agentId,
    sessionKey: resolved.sessionKey,
    storePath: databasePath,
    databaseAgentId: options.agentId,
    env,
  };
  const incognito = isIncognitoOpenClawAgentSqlitePath(databasePath, options);
  return {
    sessionKey: resolved.sessionKey,
    storePath,
    read: incognito
      ? async () => loadSessionEntryReadOnlyInScope({ ...scope, projection: "list" }) !== undefined
      : async () =>
          await withSessionHistoryWorkerDatabase(
            options,
            async (owner) => await owner.readEntryPresence(scope),
          ),
  };
}

/** Full membership evidence shares the existing read-only agent database worker. */
export async function listSessionMembersInWorker(
  input: SessionAccessScope,
): Promise<SessionMember[]> {
  const env = { ...(input.env ?? process.env) };
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const resolved = resolveSqliteScope({ ...input, env });
  const options = toDatabaseOptions(resolved);
  const databasePath = resolveOpenClawAgentSqlitePath(options);
  if (isIncognitoOpenClawAgentSqlitePath(databasePath, options)) {
    // Incognito SQLite exists only in this process and keeps its native owner.
    return listSessionMembers({ ...input, env });
  }
  return await withSessionHistoryWorkerDatabase(options, (owner) =>
    owner.readMembers({ sessionKey: resolved.sessionKey, env }),
  );
}

/** Single and batch reads synchronously retain the same lane-aware database owner. */
function retainSessionHistoryWorkerDatabase(options: OpenClawAgentDatabaseOptions) {
  const owned = acquireHistoryDatabaseResource(options);
  const { database } = owned;
  let released = false;
  let sourceChanged = false;
  let acceptedFacts: OpenClawAgentDatabaseReadFacts | undefined;
  const assertCurrent = () => {
    if (released || sourceChanged || owned.revoked) {
      throw new WorkerTaskError("Session history database read was revoked", "unavailable");
    }
  };
  historyClearTimeout(historyLane.idleTimer);
  historyLane.pending++;
  owned.pending++;
  const release = () => {
    if (released) return;
    released = true;
    acceptedFacts = undefined;
    owned.pending--;
    historyLane.pending--;
    pruneHistoryDatabases();
    armDatabaseWorkerIdleRetirement(historyLane);
  };
  try {
    assertCurrent();
    const runRequest = async <TResult>(
      prepare: () =>
        | Omit<SessionTranscriptHistoryWorkerInput, "database">
        | Omit<SessionPreviewWorkerInput, "database">
        | Omit<SessionTitleFieldsWorkerInput, "database">
        | Omit<SessionRowPresenceWorkerInput, "database">
        | Omit<SessionRowEntryWorkerInput, "database">
        | Omit<SessionMembersWorkerInput, "database">
        | Omit<SessionEntryListWorkerInput, "database">
        | Omit<SessionExactEntriesWorkerInput, "database">
        | Omit<SessionIdentityEvidenceWorkerInput, "database">
        | Omit<SessionTranscriptSearchWorkerInput, "database">
        | Omit<SessionUsageCacheWorkerInput, "database">,
      inputBytes: number,
      receive: (
        value:
          | SessionHistoryWorkerResult
          | SessionPreviewWorkerResult
          | SessionTitleFieldsWorkerResult
          | boolean
          | SessionMember[]
          | SessionEntryListWorkerResult
          | SessionExactEntriesWorkerResult
          | import("./session-store-target-inventory.js").SessionStoreTargetReadResult
          | SessionRowEntryWorkerResult
          | SessionStoreTargetInventoryResult
          | ConfiguredSessionStoreTargetResult
          | SessionIdentityEvidenceWorkerResult
          | SessionTranscriptSearchWorkerResult
          | SessionCostUsageCacheReadResult,
      ) => TResult,
    ): Promise<TResult> => {
      assertCurrent();
      let sequence = 0;
      try {
        const reply = await historyPages.run(
          () => {
            assertCurrent();
            const input = prepare();
            assertCurrent();
            sequence = ++historyLane.nativeSequence;
            owned.nativeSequences.set(historyLane, sequence);
            return { ...input, database };
          },
          { inputBytes, timeoutMs: 60_000 },
        );
        if (!reply.ok && reply.error.kind === "source-changed") {
          // This refusal was observed by the real exact-read owner. Latch it
          // before any awaited retirement so restoring equal file facts cannot
          // revive this particular borrow after the failed read is caught.
          sourceChanged = true;
        }
        const value = receive(
          unwrapSessionTranscriptWorkerReply<
            | "history-page"
            | "session-preview"
            | "session-title-fields"
            | "session-row-presence"
            | "session-row-entry"
            | "session-members"
            | "session-entry-list"
            | "session-exact-entries"
            | "session-store-target"
            | "session-target-inventory"
            | "session-configured-target"
            | "session-identity-evidence"
            | "usage-cache"
            | "transcript-search"
          >(reply),
        );
        if (reply.ok && reply.closedHistoryDatabase) {
          // A later dispatched request may already hold this target's next native custody.
          clearClosedDatabaseCustody(historyLane, sequence, [reply.closedHistoryDatabase]);
        }
        assertCurrent();
        return value;
      } catch (error) {
        if (sequence > 0) {
          try {
            await rotateDatabaseWorkers(historyLane);
          } catch (cleanupError) {
            throw sessionHistoryCleanupError(error, cleanupError, "worker retirement");
          }
        }
        throw error;
      }
    };
    let entryIdentity: ExactSessionEntryReadIdentity | null | undefined;
    const owner: SessionHistoryWorkerDatabase = {
      acceptedSource() {
        assertCurrent();
        const facts = acceptedFacts;
        if (!facts) return undefined;
        return {
          facts,
          assertCurrent() {
            assertCurrent();
            if (acceptedFacts !== facts)
              throw new WorkerTaskError("Accepted read was superseded", "unavailable");
            try {
              assertOpenClawAgentReadFactsCurrent(facts);
            } catch (error) {
              sourceChanged = true;
              throw error;
            }
          },
        };
      },
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
      generation: owned.generation,
      assertCurrent,
      run: async (prepare, inputBytes) =>
        await runRequest(prepare, inputBytes, (value) => {
          if (
            typeof value === "boolean" ||
            Array.isArray(value) ||
            value.kind === "session-preview" ||
            value.kind === "session-title-fields" ||
            value.kind === "session-entry-list" ||
            value.kind === "session-exact-entries" ||
            value.kind === "session-store-target" ||
            value.kind === "session-row-entry" ||
            value.kind === "session-target-inventory" ||
            value.kind === "session-configured-target" ||
            value.kind === "session-target-registry-required" ||
            value.kind === "session-identity-evidence" ||
            value.kind === "transcript-search" ||
            value.kind === "usage-refresh-lock"
          ) {
            throw new Error("Session history worker returned metadata instead of history");
          }
          return value;
        }),
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
              throw new Error(
                "Session history worker returned another result instead of a preview",
              );
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
      readEntryPresence: async (scope) =>
        await runRequest(
          () => ({ kind: "session-row-presence", scope }),
          JSON.stringify(scope).length * 2,
          (value) => {
            if (typeof value !== "boolean") {
              throw new Error(
                "Session history worker returned history instead of metadata presence",
              );
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
      readEntry: async (input, continuation) => {
        const scope = captureSessionRowEntryScope(input);
        if (scope.databaseAgentId !== database.agentId || scope.storePath !== database.path) {
          throw new WorkerTaskError(
            "Session entry target differs from its retained owner",
            "unavailable",
          );
        }
        const accepted = await runRequest(
          () => ({
            kind: "session-row-entry",
            scope,
            continuation,
            expectedIdentity: entryIdentity,
          }),
          JSON.stringify(scope).length * 2,
          (value) => {
            if (
              typeof value === "boolean" ||
              Array.isArray(value) ||
              value.kind !== "session-row-entry"
            ) {
              throw new Error("Session history worker returned another result instead of an entry");
            }
            if (
              entryIdentity !== undefined &&
              !sameExactSessionEntryReadIdentity(entryIdentity, value.identity)
            ) {
              sourceChanged = true;
              throw new WorkerTaskError("Exact session reader source changed", "unavailable");
            }
            return value;
          },
        );
        // The receive callback decoded provisional facts; the final awaited guard accepts them.
        assertCurrent();
        if (
          accepted.facts &&
          (accepted.facts.agentId !== database.agentId ||
            accepted.facts.path !== database.path ||
            !accepted.identity ||
            accepted.facts.physicalIdentity !== accepted.identity.identity ||
            accepted.facts.birthtime !== accepted.identity.birthtime)
        ) {
          sourceChanged = true;
          throw new WorkerTaskError(
            "Exact read facts differ from their retained source",
            "unavailable",
          );
        }
        if (accepted.facts) {
          try {
            assertOpenClawAgentReadFactsCurrent(accepted.facts);
          } catch (error) {
            sourceChanged = true;
            throw error;
          }
          if (acceptedFacts && JSON.stringify(acceptedFacts) !== JSON.stringify(accepted.facts)) {
            sourceChanged = true;
            throw new WorkerTaskError("Exact read schema/owner facts changed", "unavailable");
          }
        }
        entryIdentity = accepted.identity;
        if (accepted.facts && !acceptedFacts) acceptedFacts = Object.freeze({ ...accepted.facts });
        return accepted.entry;
      },
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
    };
    return { owner, release };
  } catch (error) {
    try {
      release();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Session history reader admission cleanup failed",
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

/** Capture every selected store before yielding; a closed target cannot join a later generation. */
export async function withSessionHistoryWorkerDatabases<T>(
  options: readonly OpenClawAgentDatabaseOptions[],
  operation: (owners: readonly SessionHistoryWorkerDatabase[]) => Promise<T>,
): Promise<T> {
  const retained: ReturnType<typeof retainSessionHistoryWorkerDatabase>[] = [];
  let outcome: { value: T } | { error: unknown };
  try {
    for (const target of options) {
      retained.push(retainSessionHistoryWorkerDatabase(target));
    }
    const value = await operation(retained.map(({ owner }) => owner));
    for (const { owner } of retained) {
      owner.assertCurrent();
    }
    outcome = { value };
  } catch (error) {
    outcome = { error };
  }
  const cleanupErrors: unknown[] = [];
  for (const retainedRead of retained.toReversed()) {
    try {
      retainedRead.release();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [...("error" in outcome ? [outcome.error] : []), ...cleanupErrors],
      "Session history read scope cleanup failed",
      { cause: "error" in outcome ? outcome.error : cleanupErrors[0] },
    );
  }
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.value;
}

/** Single-target callers retain the same batch admission and revocation boundary. */
export function withSessionHistoryWorkerDatabase<T>(
  options: OpenClawAgentDatabaseOptions,
  operation: (owner: SessionHistoryWorkerDatabase) => Promise<T>,
): Promise<T> {
  return withSessionHistoryWorkerDatabases([options], (owners) =>
    operation(expectDefined(owners[0], "retained session history reader")),
  );
}
