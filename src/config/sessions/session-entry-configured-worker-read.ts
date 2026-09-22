import path from "node:path";
import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  toAgentStoreSessionKey,
} from "../../routing/session-key.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { isIncognitoSessionKey } from "../../shared/incognito-session-key.js";
import { assertAgentDatabaseAdmitted } from "../../state/agent-database-admission.js";
import {
  createOpenClawAgentDatabaseClaim,
  isOpenClawAgentDatabasePathCurrent,
  type OpenClawAgentDatabaseClaim,
} from "../../state/openclaw-agent-db-identity.js";
import { retainAgentDatabase } from "../../state/openclaw-agent-db-lifecycle.js";
import {
  prepareOpenClawAgentDatabaseRegistrySnapshotRead,
  preservesOpenClawAgentRegistrationRead,
} from "../../state/openclaw-agent-db-registry-listing.js";
import {
  matchesAgentDatabaseReadCandidatePath,
  registerOpenClawAgentDatabaseSyncResource,
} from "../../state/openclaw-agent-db-resources.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  isIncognitoOpenClawAgentSqlitePath,
  readOpenIncognitoAgentDatabaseGeneration,
  resolveIncognitoOpenClawAgentSqlitePath,
  retainOpenClawAgentDatabaseReadCandidates,
} from "../../state/openclaw-agent-db.js";
import type { OpenClawStateDatabaseSelectorBorrow } from "../../state/openclaw-state-db-async-lifecycle.js";
import { retainOpenClawStateDatabaseSelector } from "../../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { createRuntimeConfigReader } from "../runtime-snapshot.js";
import { resolveStateDir } from "../state-dir.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveSessionStorePathCore } from "./paths.js";
import { readExactSessionEntryFromSourceReadOnly } from "./session-accessor.sqlite-exact-read.js";
import type { SessionEntryReadSource } from "./session-accessor.types.js";
import { captureCanonicalSessionReaderContinuation } from "./session-canonical-key.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import {
  captureSessionStoreReadCandidate,
  type SessionStoreReadCandidate,
} from "./session-store-read-candidates.js";
import { prepareConfiguredSessionStoreTargetRead } from "./session-store-target-inventory.js";
import { withSessionHistoryWorkerReadCandidates } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export type ConfiguredSessionEntryReadScope = {
  agentId: string;
  sessionKey: string;
  storePath: string;
  env: NodeJS.ProcessEnv;
};

type RetainedConfiguredSessionEntryFacts = {
  readonly agentId: string;
  readonly sessionKey: string;
  readonly storePath: string;
  readonly readSource: SessionEntryReadSource;
  assertCurrent: () => void;
};

/** A row snapshot remains conditional until the consuming frame checks this read's guard. */
export type ConfiguredSessionEntryRead = {
  readonly entry: SessionEntry | undefined;
  assertCurrent: () => void;
};

export type RetainedConfiguredSessionEntryReader = RetainedConfiguredSessionEntryFacts &
  (
    | { readonly kind: "durable"; readEntry: () => Promise<ConfiguredSessionEntryRead> }
    | { readonly kind: "incognito"; readEntry: () => ConfiguredSessionEntryRead }
  );

/** Retain one configured physical owner across initial read, caller work, and later exact reads. */
export async function withConfiguredSessionEntryReader<T>(
  cfg: OpenClawConfig,
  input: ConfiguredSessionEntryReadScope,
  operation: (reader: RetainedConfiguredSessionEntryReader) => T | Promise<T>,
): Promise<T> {
  const capturedEnv = cloneEnvWithPlatformSemantics(input.env);
  const env = { ...capturedEnv, OPENCLAW_STATE_DIR: resolveStateDir(capturedEnv) };
  const agentId = normalizeAgentId(input.agentId);
  const normalizedKey = normalizeStoreSessionKey(input.sessionKey);
  const parsedKey = parseAgentSessionKey(normalizedKey);
  if (parsedKey && parsedKey.agentId !== agentId) {
    throw new WorkerTaskError("Requester key belongs to another agent", "unavailable");
  }
  // Match the accessor's pure logical-key rule before installing the row observer.
  const sessionKey =
    !normalizedKey || normalizedKey === "global" || normalizedKey === "unknown" || parsedKey
      ? normalizedKey
      : toAgentStoreSessionKey({ agentId, requestKey: normalizedKey });
  const storePath = path.resolve(input.storePath);
  const readConfig = createRuntimeConfigReader(cfg);
  const incognito =
    isIncognitoSessionKey(sessionKey) ||
    isIncognitoOpenClawAgentSqlitePath(storePath, { agentId, env });
  const nativePath = incognito
    ? resolveIncognitoOpenClawAgentSqlitePath({ agentId, env })
    : undefined;
  const prepared = incognito
    ? undefined
    : prepareConfiguredSessionStoreTargetRead(cfg, { agentId, storePath, env });
  const candidates: readonly SessionStoreReadCandidate[] = prepared?.candidates ?? [];
  let selector: OpenClawStateDatabaseSelectorBorrow | undefined;
  let closed = false;
  let revoked = false;
  let rowVersion = 0;
  let readSource: SessionEntryReadSource | undefined;
  const assertCaptured = () => {
    if (closed || revoked) {
      throw new WorkerTaskError("Configured session reader was revoked", "unavailable");
    }
    if (!incognito) {
      try {
        // Host-local refusal and preparation custody are independent of the
        // shared-state selector and may change without publishing a stores event.
        assertAgentDatabaseAdmitted(agentId, { env });
        if (readSource && readSource.agentId !== agentId) {
          assertAgentDatabaseAdmitted(readSource.agentId, { env });
        }
      } catch (error) {
        revoked = true;
        throw error;
      }
    }
    if (
      !incognito &&
      path.resolve(resolveSessionStorePathCore(readConfig().session?.store, { agentId, env })) !==
        storePath
    ) {
      throw new WorkerTaskError("Configured requester selection changed", "unavailable");
    }
    selector?.assertCurrent();
    for (const candidate of candidates) {
      if (
        captureSessionStoreReadCandidate(candidate.path, candidate.scope).physicalPath !==
        candidate.physicalPath
      ) {
        throw new WorkerTaskError("Configured requester alias changed", "unavailable");
      }
    }
  };
  const matchesCapturedStore = (changedStorePath: string) => {
    const changedPath = resolveUnsuffixedSqliteTargetFromSessionStorePath(changedStorePath).path;
    return (
      changedPath === readSource?.path ||
      changedPath === nativePath ||
      candidates.some(
        (candidate) =>
          matchesAgentDatabaseReadCandidatePath(candidate, changedPath) ||
          matchesAgentDatabaseReadCandidatePath(
            { ...candidate, path: candidate.physicalPath },
            changedPath,
          ),
      )
    );
  };
  const unsubscribe = sessionChanges.subscribe((change) => {
    if ("all" in change) {
      if (change.scope === "config" || change.scope === "stores") {
        // Only the canonical exact committed event can preserve this still-live borrow.
        try {
          if (
            change.scope === "stores" &&
            selector &&
            !revoked &&
            preservesOpenClawAgentRegistrationRead(change, selector)
          )
            return;
        } catch {
          // Listener isolation must not swallow a failed authority check.
        }
        revoked = true;
      } else if (
        typeof change.scope === "object" &&
        change.scope.storePath &&
        matchesCapturedStore(change.scope.storePath)
      ) {
        rowVersion++;
      }
      // agent-runs/subagent-runs and other observation scopes do not replace this owner.
      return;
    }
    if (
      change.scope === "automation" ||
      !change.storePath ||
      normalizeStoreSessionKey(change.sessionKey) !== sessionKey
    ) {
      // Run/activity producers also publish keyed notifications, without a physical store.
      return;
    }
    if (matchesCapturedStore(change.storePath)) {
      // Committed entry writes carry a store; other store-qualified invalidations are conservative.
      rowVersion++;
    }
  });
  const captureRead = (
    entry: SessionEntry | undefined,
    version: number,
    assertOwnerCurrent: () => void,
  ): ConfiguredSessionEntryRead => {
    const assertCurrent = () => {
      assertOwnerCurrent();
      if (version !== rowVersion) {
        throw new WorkerTaskError("Requester row changed before read acceptance", "unavailable");
      }
    };
    assertCurrent();
    // The same guard must run after the consumer's await, not only before resolving this read.
    return { entry, assertCurrent };
  };
  try {
    assertCaptured();
    if (nativePath) {
      const options = { agentId, path: nativePath, env };
      let nativeRevoked = false;
      let claim: OpenClawAgentDatabaseClaim | undefined;
      const revokeNative = () => {
        nativeRevoked = true;
        claim?.release();
      };
      // Register before native admission. Deletion/close revokes this read capability
      // synchronously; this resource owns no asynchronous native work to drain.
      const unregisterNative = registerOpenClawAgentDatabaseSyncResource({
        agentId,
        path: nativePath,
        revoke: revokeNative,
        close: revokeNative,
      });
      try {
        // Preserve the existing deletion-journal admission query at preparation.
        // Repeated execution/read-receipt guards below are in-memory only.
        const database = getOpenClawAgentDatabaseIfOpen(options);
        const missingGeneration = readOpenIncognitoAgentDatabaseGeneration();
        claim = database
          ? createOpenClawAgentDatabaseClaim(database, retainAgentDatabase(database.db))
          : undefined;
        readSource = Object.freeze({ agentId, path: nativePath });
        const source = readSource;
        const assertCurrent = () => {
          assertCaptured();
          assertAgentDatabaseAdmitted(agentId, { env });
          if (nativeRevoked) {
            throw new WorkerTaskError("Native requester owner changed", "unavailable");
          }
          claim?.assertCurrent();
          if (!database && readOpenIncognitoAgentDatabaseGeneration() !== missingGeneration) {
            throw new WorkerTaskError("Native requester owner changed", "unavailable");
          }
        };
        assertCurrent();
        const value = await operation({
          kind: "incognito",
          agentId,
          sessionKey,
          storePath,
          readSource: source,
          assertCurrent,
          readEntry: () => {
            assertCurrent();
            const version = rowVersion;
            // The native row owner retains its existing lookup/deletion admission.
            // This is never a fallback from a failed durable worker operation.
            const result = database
              ? readExactSessionEntryFromSourceReadOnly({ readSource: source, sessionKey, env })
              : undefined;
            return captureRead(result?.entry, version, assertCurrent);
          },
        });
        assertCurrent();
        return value;
      } finally {
        revokeNative();
        unregisterNative();
      }
    }
    if (!prepared) {
      throw new Error("Durable requester read requires its captured configured target");
    }
    const context = captureOpenClawStateWorkerContext({ env });
    selector = retainOpenClawStateDatabaseSelector(context.admission);
    const registryRead = prepareOpenClawAgentDatabaseRegistrySnapshotRead(
      { env },
      { context, selector },
    );
    const nativeReaders = retainOpenClawAgentDatabaseReadCandidates(
      candidates.flatMap((candidate) => [
        candidate,
        { ...candidate, path: candidate.physicalPath },
      ]),
      env,
    );
    const nativeClaims: OpenClawAgentDatabaseClaim[] = [];
    const continuations: Array<{
      path: string;
      agentId: string;
      owner: NonNullable<ReturnType<typeof captureCanonicalSessionReaderContinuation>>;
    }> = [];
    try {
      for (const database of nativeReaders.databases) {
        // The enclosing native reader set owns its borrower; this claim adds no second pin.
        nativeClaims.push(createOpenClawAgentDatabaseClaim(database, () => {}));
        const owner = captureCanonicalSessionReaderContinuation(database);
        if (owner) {
          continuations.push({
            path: captureSessionStoreReadCandidate(database.path).physicalPath,
            agentId: database.agentId,
            owner,
          });
        }
      }
      let assertRegistryCurrent: (() => void) | undefined;
      const assertNativeReaders = () => {
        assertCaptured();
        assertRegistryCurrent?.();
        for (const claim of nativeClaims) {
          claim.assertCurrent();
        }
        for (const database of nativeReaders.databases) {
          if (!isOpenClawAgentDatabasePathCurrent(database)) {
            throw new WorkerTaskError("Captured requester database changed", "unavailable");
          }
        }
      };
      assertNativeReaders();
      const value = await withSessionHistoryWorkerReadCandidates(candidates, async (discovery) => {
        let selected = await discovery.readConfiguredTarget({
          ...prepared,
          registeredDatabases: { status: "deferred" },
        });
        discovery.assertCurrent();
        assertNativeReaders();
        if (selected.kind === "session-target-registry-required") {
          const registry = await registryRead.read();
          assertRegistryCurrent = registry.assertCurrent;
          discovery.assertCurrent();
          assertNativeReaders();
          selected = await discovery.readConfiguredTarget({
            ...prepared,
            registeredDatabases:
              registry.result.status === "available"
                ? registry.result.entries
                : { status: "unavailable" },
          });
          discovery.assertCurrent();
          assertNativeReaders();
          if (selected.kind === "session-target-registry-required") {
            throw new WorkerTaskError(
              "Configured target repeated its registry demand",
              "unavailable",
            );
          }
        }
        const source = Object.freeze({ ...selected.database });
        readSource = source;
        assertNativeReaders();
        const continuation = continuations.find(
          (held) => held.path === source.path && held.agentId === source.agentId,
        )?.owner.receipt;
        return await withSessionHistoryWorkerDatabase({ ...source, env }, async (owner) => {
          const assertCurrent = () => {
            assertNativeReaders();
            discovery.assertCurrent();
            owner.assertCurrent();
            owner.acceptedSource()?.assertCurrent();
          };
          // Commit guards need physical authority even inside a legitimate native write.
          // Continuation readiness is a separate condition for preparing/accepting reads.
          const assertReadCurrent = () => {
            assertCurrent();
            for (const held of continuations) {
              held.owner.assertCurrent();
            }
          };
          assertCurrent();
          const value = await operation({
            kind: "durable",
            agentId,
            sessionKey,
            storePath,
            readSource: source,
            assertCurrent,
            readEntry: async () => {
              assertReadCurrent();
              const version = rowVersion;
              const entry = await owner.readEntry(
                {
                  agentId,
                  databaseAgentId: source.agentId,
                  sessionKey,
                  storePath: source.path,
                  env,
                },
                continuation,
              );
              const read = captureRead(entry, version, assertReadCurrent);
              const accepted = owner.acceptedSource();
              if (accepted) {
                selector!.acceptSource(accepted.facts, () => {
                  // Continuity is physical/read custody, not reusable writable validation.
                  assertCurrent();
                  accepted.assertCurrent();
                });
              }
              return read;
            },
          });
          assertCurrent();
          return value;
        });
      });
      // Discovery retirement may await after the callback; keep captured authority until return.
      assertNativeReaders();
      return value;
    } finally {
      for (const { owner } of continuations.toReversed()) {
        owner.release();
      }
      for (const claim of nativeClaims.toReversed()) {
        claim.release();
      }
      nativeReaders.release();
    }
  } finally {
    closed = true;
    selector?.release();
    unsubscribe();
  }
}
