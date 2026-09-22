import { expectDefined } from "@openclaw/normalization-core";
import { readBoardSessionKeys } from "../../boards/sqlite-board-store.kernel.js";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { SessionMetadataUnavailableError } from "../../state/openclaw-agent-db-read-error.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { readSessionActivitySummary } from "./activity-summary.js";
import { resolveSessionLifecycleTimestamps } from "./lifecycle.js";
import { readExactSessionEntryCandidatesInDatabase } from "./session-accessor.sqlite-entry-cache.js";
import { readTranscriptHeaderFromDatabase } from "./session-accessor.sqlite-read.js";
import { readSessionTranscriptWatermarkInDatabase } from "./session-accessor.sqlite-transcript-watermark.js";
import { readSessionBackingFactsInDatabase } from "./session-backing-facts.js";
import { assertCanonicalSqliteSessionKeysCurrent } from "./session-canonical-key.js";
import { listSessionMembersInDatabase } from "./session-sharing-store.kernel.js";
import {
  MAX_SESSION_ROW_FACTS_KEYS,
  type SessionExactEntriesWorkerInput,
  type SessionExactEntriesWorkerResult,
  type SessionRowFactsWorkerInput,
  type SessionRowFactsWorkerResult,
} from "./session-transcript-worker.types.js";

/** Full rows share a snapshot with lifecycle fallback; backing reads retain listing admission. */
export function readExactSessionEntriesWithLifecycle(
  request: SessionExactEntriesWorkerInput,
): SessionExactEntriesWorkerResult {
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      request.projection === "backing"
        ? {
            kind: "session-exact-entries" as const,
            entries: readSessionBackingFactsInDatabase(
              database,
              request.sessionKeys,
              request.continuation,
            ),
            lifecycleTimestamps: {},
          }
        : withSqlitePostCommitPublications(database.db, () =>
            runSqliteDeferredTransactionSync(database.db, () => {
              assertCanonicalSqliteSessionKeysCurrent(database);
              const selected = expectDefined(
                readExactSessionEntryCandidatesInDatabase(
                  database,
                  [request.sessionKeys],
                  "full",
                )[0],
                "exact session read result",
              );
              if (!selected.ok) {
                throw selected.error;
              }
              const entry = selected.value.find(
                ({ sessionKey }) => sessionKey === request.lifecycleSessionKey,
              )?.entry;
              return {
                kind: "session-exact-entries" as const,
                entries: selected.value,
                lifecycleTimestamps: resolveSessionLifecycleTimestamps({
                  entry,
                  agentId: database.agentId,
                  sessionKey: request.lifecycleSessionKey,
                  readHeader: (sessionId) => readTranscriptHeaderFromDatabase(database, sessionId),
                }),
              };
            }),
          ),
    { ...request.database, env: request.env },
  );
  if (result.found) {
    return result.value;
  }
  if (result.reason !== "database-missing") {
    throw new SessionMetadataUnavailableError(result.reason);
  }
  return { kind: "session-exact-entries", entries: [], lifecycleTimestamps: {} };
}

/** Entry, membership, board presence, and summary validity describe one committed snapshot. */
export function readSessionRowDatabaseFacts(
  request: SessionRowFactsWorkerInput,
): SessionRowFactsWorkerResult {
  if (request.sessionKeys.length > MAX_SESSION_ROW_FACTS_KEYS) {
    throw new Error(`Session row facts support at most ${MAX_SESSION_ROW_FACTS_KEYS} keys`);
  }
  if (request.sessionKeys.length === 0) {
    return { kind: "session-row-facts", rows: [] };
  }
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      withSqlitePostCommitPublications(database.db, () =>
        runSqliteDeferredTransactionSync(database.db, () => {
          assertCanonicalSqliteSessionKeysCurrent(database);
          const selected = expectDefined(
            readExactSessionEntryCandidatesInDatabase(database, [request.sessionKeys], "list")[0],
            "session row facts read result",
          );
          if (!selected.ok) {
            throw selected.error;
          }
          return {
            kind: "session-row-facts" as const,
            rows: selected.value.map(({ sessionKey, entry }) => ({
              sessionKey,
              entry,
              memberIdentityIds: listSessionMembersInDatabase(database, sessionKey).map(
                (member) => member.identityId,
              ),
              hasBoard: readBoardSessionKeys(database, sessionKey).length > 0,
              ...(readSessionActivitySummary(entry)
                ? {
                    activitySummaryWatermark: readSessionTranscriptWatermarkInDatabase(
                      database,
                      entry.sessionId,
                    ),
                  }
                : {}),
            })),
          };
        }),
      ),
    { ...request.database, env: request.env },
  );
  if (result.found) {
    return result.value;
  }
  if (result.reason !== "database-missing") {
    throw new SessionMetadataUnavailableError(result.reason);
  }
  return { kind: "session-row-facts", rows: [] };
}
