import { normalizeAgentId } from "../../routing/session-key.js";
import { assertAgentDatabaseAdmitted } from "../../state/agent-database-admission.js";
import { prepareOpenClawAgentDatabaseRegistrySnapshotRead } from "../../state/openclaw-agent-db-registry-listing.js";
import { retainOpenClawAgentDatabaseReadCandidates } from "../../state/openclaw-agent-db.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import { resolveSqliteAgentId } from "./session-accessor.sqlite-scope.js";
import {
  captureCanonicalSessionReaderContinuation,
  type CanonicalSessionReaderContinuation,
} from "./session-canonical-key.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreReadCandidate,
} from "./session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";
import { withSessionHistoryWorkerReadCandidates } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import type { SessionHistoryWorkerDatabase } from "./session-transcript-worker.types.js";

type SessionStoreWorkerReadScope = {
  agentId: string;
  storePath: string;
  env?: NodeJS.ProcessEnv;
};

/** Read exact keys from the configured store, including keys shaped like incognito sessions. */
export async function readSessionEntriesFromStoreInWorker(
  input: SessionStoreWorkerReadScope & {
    sessionKeys: readonly string[];
    lifecycleSessionKey?: string;
    projection?: "full" | "backing";
  },
) {
  const read = {
    sessionKeys: [...new Set(input.sessionKeys)],
    lifecycleSessionKey: input.lifecycleSessionKey,
    projection: input.projection,
  };
  return withSessionStoreReaderInWorker(
    input,
    (owner, database, continuation) =>
      owner.readExactEntries({ ...read, env: database.env, continuation }),
    input.projection === "backing",
  );
}

/** Return owned full entries only for expired cron runs; live deletion guards stay on the host. */
export async function readExpiredCronRunEntriesInWorker(
  input: SessionStoreWorkerReadScope & { updatedBefore: number },
) {
  const expiredCronRuns = {
    agentId: normalizeAgentId(input.agentId),
    updatedBefore: input.updatedBefore,
  };
  assertAgentDatabaseAdmitted(expiredCronRuns.agentId, { env: input.env });
  return withSessionStoreReaderInWorker(input, async (owner, database) => {
    const assertAdmitted = () => {
      assertAgentDatabaseAdmitted(expiredCronRuns.agentId, { env: database.env });
      assertAgentDatabaseAdmitted(database.agentId, { env: database.env });
    };
    assertAdmitted();
    const entries = await owner.readEntries({
      agentId: database.agentId,
      storePath: database.path,
      env: database.env,
      expiredCronRuns,
    });
    assertAdmitted();
    return entries;
  });
}

async function withSessionStoreReaderInWorker<T>(
  input: SessionStoreWorkerReadScope,
  read: (
    owner: SessionHistoryWorkerDatabase,
    database: { agentId: string; path: string; env: NodeJS.ProcessEnv },
    continuation: CanonicalSessionReaderContinuation | undefined,
  ) => Promise<T>,
  backing = false,
) {
  const env = cloneEnvWithPlatformSemantics(input.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const agentId = normalizeAgentId(input.agentId);
  const storePath = input.storePath;
  const target = resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath);
  const captured = captureSessionStoreReadCandidate(target.path);
  const direct = target.agentId && captured.path === captured.physicalPath;
  const candidates = direct ? [captured] : captureSessionStoreReadCandidates(storePath);
  const native = backing
    ? retainOpenClawAgentDatabaseReadCandidates(
        candidates.flatMap((candidate) => [
          candidate,
          { ...candidate, path: candidate.physicalPath },
        ]),
        env,
      )
    : undefined;
  const continuations: Array<{
    path: string;
    owner: NonNullable<ReturnType<typeof captureCanonicalSessionReaderContinuation>>;
  }> = [];
  try {
    for (const database of native?.databases ?? []) {
      const owner = captureCanonicalSessionReaderContinuation(database);
      if (owner) {
        continuations.push({
          path: captureSessionStoreReadCandidate(database.path).physicalPath,
          owner,
        });
      }
    }
    const readDatabase = async (database: { agentId: string; path: string }) => {
      const continuation = continuations.find((item) => item.path === database.path)?.owner;
      const result = await withSessionHistoryWorkerDatabase({ ...database, env }, (owner) =>
        read(owner, { ...database, env: { ...env } }, continuation?.receipt),
      );
      continuation?.assertCurrent();
      return result;
    };
    if (direct && target.agentId) {
      resolveSqliteAgentId({ scopedAgentId: agentId, storeAgentId: target.agentId });
      const result = await readDatabase({ agentId: target.agentId, path: captured.physicalPath });
      assertSessionStoreReadCandidate(target.path, [captured]);
      return result;
    }
    const registryRead = prepareOpenClawAgentDatabaseRegistrySnapshotRead({ env });
    return await withSessionHistoryWorkerReadCandidates(candidates, async (discovery) => {
      const request = { agentId, storePath, env: { ...env }, candidates };
      let resolved = await discovery.readStoreTarget({
        ...request,
        registeredDatabases: { status: "deferred" },
      });
      let assertRegistryCurrent: (() => void) | undefined;
      if (resolved.kind === "session-target-registry-required") {
        const registry = await registryRead.read();
        assertRegistryCurrent = registry.assertCurrent;
        registry.assertCurrent();
        discovery.assertCurrent();
        resolved = await discovery.readStoreTarget({
          ...request,
          registeredDatabases:
            registry.result.status === "available"
              ? registry.result.entries
              : { status: "unavailable" },
        });
        if (resolved.kind === "session-target-registry-required") {
          throw new Error("Session store target requested registry rows twice");
        }
      }
      assertRegistryCurrent?.();
      discovery.assertCurrent();
      const result = await readDatabase(resolved.database);
      assertRegistryCurrent?.();
      discovery.assertCurrent();
      assertSessionStoreReadCandidate(resolved.sourcePath, candidates);
      return result;
    });
  } finally {
    for (const { owner } of continuations.toReversed()) {
      owner.release();
    }
    native?.release();
  }
}
