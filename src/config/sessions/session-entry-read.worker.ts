import { expectDefined } from "@openclaw/normalization-core";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import {
  isOpenClawAgentDatabasePathCurrent,
  readOpenClawAgentDatabaseIdentity,
} from "../../state/openclaw-agent-db-identity.js";
import { SessionMetadataUnavailableError } from "../../state/openclaw-agent-db-read-error.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { resolveSessionLifecycleTimestamps } from "./lifecycle.js";
import { readExactSessionEntryCandidatesInDatabase } from "./session-accessor.sqlite-entry-cache.js";
import { readTranscriptHeaderFromDatabase } from "./session-accessor.sqlite-read.js";
import { readSessionBackingFactsInDatabase } from "./session-backing-facts.js";
import { assertCanonicalSqliteSessionKeysCurrent } from "./session-canonical-key.js";
import { listSessionMembersInDatabase } from "./session-sharing-store.kernel.js";
import type {
  SessionExactEntriesWorkerInput,
  SessionExactEntriesWorkerResult,
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
              const identity = request.includeAuthorization
                ? readOpenClawAgentDatabaseIdentity(database)
                : undefined;
              if (
                identity &&
                (typeof identity.identity !== "string" ||
                  !isOpenClawAgentDatabasePathCurrent(database))
              ) {
                throw new Error("Session database physical identity changed");
              }
              return {
                ...(identity && typeof identity.identity === "string"
                  ? { databaseIdentity: { ...identity, identity: identity.identity } }
                  : {}),
                ...(request.includeMembers
                  ? {
                      members: Object.fromEntries(
                        selected.value.map(({ sessionKey }) => [
                          sessionKey,
                          listSessionMembersInDatabase(database, sessionKey),
                        ]),
                      ),
                    }
                  : {}),
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
