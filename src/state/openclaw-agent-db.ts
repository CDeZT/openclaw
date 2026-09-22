// OpenClaw agent database stores agent-scoped persisted runtime state.
import type { DatabaseSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";
import { resolveStateDir } from "../config/paths.js";
import { isGatewayExternallySupervised } from "../infra/gateway-supervision.js";
import { enableNodeSqliteKyselyStatementCache } from "../infra/kysely-sync.js";
import {
  openNodeSqliteDatabase,
  supportsNodeSqliteExtensionLoading,
} from "../infra/node-sqlite.js";
import { quarantineOrphanedSqliteSidecars } from "../infra/sqlite-files.js";
import {
  isTerminalSqliteIntegrityError,
  runSqliteIntegrityOperationSync,
  type SqliteIntegrityDiagnostics,
  type SqliteIntegrityOperation,
} from "../infra/sqlite-integrity.js";
import {
  deferSqlitePostCommitPublication,
  withSqlitePostCommitPublications,
} from "../infra/sqlite-post-commit.js";
import {
  runSqliteImmediateTransactionSync,
  type SqliteTransactionOptions,
} from "../infra/sqlite-transaction.js";
import { isSqliteSchemaVersionError } from "../infra/sqlite-user-version.js";
import { createSqliteWalReclamationResult } from "../infra/sqlite-wal-reclamation.js";
import { registerSqliteWalWriteAdmission } from "../infra/sqlite-wal-write-admission.js";
import {
  configureSqliteConnectionPragmas,
  configureSqlitePreSchemaPragmas,
  registerSqliteCacheExitClose,
  type SqliteWalMaintenance,
} from "../infra/sqlite-wal.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { assertAgentDatabaseAdmitted } from "./agent-database-admission.js";
import {
  assertAgentDeletionDatabaseCleanupAccess,
  getAgentDeletionDatabaseCleanup,
  registerAgentDeletionDatabaseCleanup,
} from "./agent-deletion-cleanup.js";
import { createOpenClawAgentDatabaseAdmissionOwner } from "./openclaw-agent-db-admission.js";
import {
  findOpenClawAgentDatabaseIfOpen,
  getOpenClawAgentDatabaseIfOpen,
  recordOpenClawAgentDatabaseOpenFailure,
} from "./openclaw-agent-db-cache-access.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
  OpenClawAgentDatabaseRegistrationCommit,
} from "./openclaw-agent-db-contract.js";
import {
  registerOpenClawAgentDatabaseIdentity,
  readOpenClawAgentDatabaseIdentity,
} from "./openclaw-agent-db-identity.js";
import {
  hasAgentDatabaseMaintenanceAuthority,
  assertOpenClawAgentDatabaseLease,
  claimOpenClawAgentDatabaseLease,
  recordOpenClawAgentDatabaseIntegrityVerified,
  releaseOpenClawAgentDatabaseLease,
  type OpenClawAgentIntegrityVerificationReceiver,
  type prepareOpenClawAgentDatabaseWorkerLease,
} from "./openclaw-agent-db-lease.js";
import {
  agentDatabaseLifecycle as cache,
  startAgentDatabaseOpenTiming,
  closeCachedOpenClawAgentDatabase,
  closeMaintenanceAgentDatabase,
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabases,
  refreshAgentDatabaseIdleTimer,
  retainAgentDatabase,
  retainFailedAgentDatabaseClose,
  revokePendingAgentDatabaseOpen,
  type PendingAgentDatabaseOpen,
} from "./openclaw-agent-db-lifecycle.js";
import { ensureOpenClawAgentDatabasePermissions } from "./openclaw-agent-db-permissions.js";
import { readOpenClawAgentReadOnlySchemaFacts } from "./openclaw-agent-db-readonly-open.js";
import { closeIdleOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly-scope.js";
import {
  captureOpenClawAgentDatabaseRegistration,
  type OpenClawAgentRegistrationTransactionOwner,
} from "./openclaw-agent-db-registry-listing.js";
import { registerOpenClawAgentDatabase } from "./openclaw-agent-db-registry.js";
import {
  assertCanonicalAgentPersistenceVersion,
  assertExistingAgentSchemaOwner,
  assertSupportedAgentSchemaVersion,
  readExistingAgentSchemaMeta,
} from "./openclaw-agent-db-schema-helpers.js";
import {
  agentDatabaseIntegrityBeforeMutationSteps,
  ensureOpenClawAgentSchema,
} from "./openclaw-agent-db-schema.js";
import {
  adoptOpenClawAgentDatabaseValidation,
  getOpenClawAgentDatabaseValidation,
  invalidateOpenClawAgentDatabaseValidation,
  setOpenClawAgentDatabaseValidation,
} from "./openclaw-agent-db-validation-cache.js";
import {
  assertIncognitoAgentDatabasePathAvailable,
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmission } from "./openclaw-agent-write-admission.js";
import { requestOpenClawAgentDatabaseQuickCheck } from "./openclaw-database-verify.js";
import {
  createOpenClawDatabaseVerificationError,
  readOpenClawDatabaseQuarantine,
  type OpenClawAgentIntegrityVerification,
} from "./openclaw-quarantine-store.js";
import { getOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

export {
  confirmOpenClawAgentDatabaseIntegrity,
  recordOpenClawAgentDatabaseOpenFailure,
  clearOpenClawAgentDatabaseOpenFailure,
  isOpenClawAgentDatabaseOpen,
  getOpenClawAgentDatabaseIfOpen,
  retainOpenClawAgentDatabaseReadCandidates,
  disposeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
} from "./openclaw-agent-db-cache-access.js";

export {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db-contract.js";
export {
  assertOpenClawAgentDatabaseForMaintenance,
  migrateOpenClawAgentDatabaseForMaintenance,
} from "./openclaw-agent-db-maintenance.js";
export { ensureOpenClawAgentDatabasePermissions } from "./openclaw-agent-db-permissions.js";
export {
  listOpenClawRegisteredAgentDatabases,
  readOpenClawAgentDatabaseRegistryToken,
} from "./openclaw-agent-db-registry.js";
export { ensureOpenClawAgentDatabaseSchema } from "./openclaw-agent-db-schema.js";
export {
  isIncognitoOpenClawAgentSqlitePath,
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.paths.js";

/** Open or return a cached per-agent database after schema and owner validation. */
export function openOpenClawAgentDatabase(
  options: OpenClawAgentDatabaseOptions,
  preparedLease?: ReturnType<typeof prepareOpenClawAgentDatabaseWorkerLease>,
  onRegistrationCommitted?: (receipt: OpenClawAgentDatabaseRegistrationCommit) => void,
  registrationOwner?: OpenClawAgentRegistrationTransactionOwner,
): OpenClawAgentDatabase {
  const run = () =>
    runSqliteIntegrityOperationSync(
      openOpenClawAgentDatabaseSteps(
        options,
        undefined,
        preparedLease,
        onRegistrationCommitted,
        registrationOwner,
      ),
    );
  const scope = getOpenClawDatabaseMaintenanceScope();
  return scope ? scope.run(run) : run();
}

export type { OpenClawAgentDatabaseWriteAdmission } from "./openclaw-agent-db-admission.js";
export const { withOpenClawAgentDatabaseAsync, withOpenClawAgentDatabaseAdmission } =
  createOpenClawAgentDatabaseAdmissionOwner(openOpenClawAgentDatabaseSteps);

function* openOpenClawAgentDatabaseSteps(
  options: OpenClawAgentDatabaseOptions,
  pending?: PendingAgentDatabaseOpen,
  preparedLease?: ReturnType<typeof prepareOpenClawAgentDatabaseWorkerLease>,
  onRegistrationCommitted?: (receipt: OpenClawAgentDatabaseRegistrationCommit) => void,
  suppliedRegistration?: OpenClawAgentRegistrationTransactionOwner,
): SqliteIntegrityOperation<OpenClawAgentDatabase> {
  const agentId = normalizeAgentId(options.agentId);
  assertAgentDatabaseAdmitted(agentId, { env: options.env });
  const databaseOptions = { ...options, agentId };
  const pathname = resolveOpenClawAgentSqlitePath(databaseOptions);
  getAgentDeletionDatabaseCleanup(databaseOptions)?.assertCurrent();
  const incognito = isIncognitoOpenClawAgentSqlitePath(pathname, databaseOptions);
  // A live successful cache entry is authoritative; failed entries remain only for disposal.
  const opened = getOpenClawAgentDatabaseIfOpen(databaseOptions);
  if (opened) {
    if (preparedLease) {
      throw new Error("A prepared Worker lease cannot adopt an existing agent database handle");
    }
    return opened;
  }
  if (!pending) {
    revokePendingAgentDatabaseOpen(pathname);
  }
  const cached = cache.databases.get(pathname);
  const allowExtension = !process.permission && supportsNodeSqliteExtensionLoading();
  if (incognito) {
    // The sentinel has no reachable durable owner, so doctor cannot safely migrate a collision.
    // Refuse operator-created state instead of silently shadowing it with volatile writes.
    assertIncognitoAgentDatabasePathAvailable(pathname);
    if (cached) {
      closeCachedOpenClawAgentDatabase(cached);
      cache.databases.delete(pathname);
      cache.failures.delete(pathname);
    }
    // After the collision probe, this sentinel is only a cache key: SQLite opens :memory:,
    // and no directory, lease, registry row, WAL sidecar, or file write may be created.
    const db = openNodeSqliteDatabase(":memory:", { allowExtension });
    db.enableLoadExtension(false);
    configureSqlitePreSchemaPragmas(db, {
      busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
    });
    const walMaintenance = configureSqliteConnectionPragmas(db, {
      busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
      databaseLabel: `openclaw-agent-incognito:${agentId}`,
      foreignKeys: true,
      synchronous: "NORMAL",
    });
    ensureOpenClawAgentSchema(db, agentId, pathname);
    registerOpenClawAgentDatabaseIdentity(db);
    const database = { agentId, db, path: pathname, walMaintenance };
    cache.incognito.add(database);
    cache.unregisterExitClose ??= registerSqliteCacheExitClose(closeOpenClawAgentDatabases);
    cache.databases.set(pathname, database);
    cache.generation += 1;
    getOpenClawDatabaseMaintenanceScope()?.own(database.db, "agent-handles", () =>
      closeMaintenanceAgentDatabase(database),
    );
    return database;
  }
  let assertRegistrationLease = () => {};
  const localRegistration = suppliedRegistration
    ? undefined
    : captureOpenClawAgentDatabaseRegistration({
        agentId,
        agentPath: pathname,
        admission: captureOpenClawStateWorkerContext({ env: options.env }).admission,
        assertWrite() {
          assertAgentDatabaseAdmitted(agentId, { env: options.env });
          assertRegistrationLease();
          pending?.assertWrite?.();
        },
        publish: false,
      });
  const registration = suppliedRegistration ?? localRegistration!;
  let registrationCleanupRetained = false;
  try {
    localRegistration?.begin();
    quarantineOrphanedSqliteSidecars(pathname);
    // Latched paths are quarantined; every fresh open fails fast here until
    // doctor repairs the file and clears the latch plus the persisted row.
    const terminalFailure = cache.terminal.get(pathname);
    if (terminalFailure) {
      throw terminalFailure;
    }
    let persistedFailure: Error | undefined;
    try {
      const quarantine = readOpenClawDatabaseQuarantine(pathname, { env: databaseOptions.env });
      if (quarantine) {
        persistedFailure = createOpenClawDatabaseVerificationError(
          "agent",
          pathname,
          quarantine.reason,
        );
      }
    } catch {
      // A broken quarantine store must not brick every agent open.
      // The process latch and daily verifier still cover known damage.
    }
    if (persistedFailure) {
      recordOpenClawAgentDatabaseOpenFailure(pathname, persistedFailure);
      throw persistedFailure;
    }
    if (cached) {
      // A closed handle can leave Kysely and WAL helpers cached; clear both before reopening.
      closeCachedOpenClawAgentDatabase(cached);
      cache.databases.delete(pathname);
      cache.failures.delete(pathname);
    }
    // Lease release must retain its original state owner after ambient env changes.
    const leaseEnvironment = {
      OPENCLAW_STATE_DIR: resolveStateDir(options.env ?? process.env),
      ...(isGatewayExternallySupervised(options.env ?? process.env)
        ? { OPENCLAW_SUPERVISOR_MODE: "external" }
        : {}),
    };
    if (
      preparedLease &&
      (preparedLease.receipt.agentId !== agentId || preparedLease.receipt.path !== pathname)
    ) {
      throw new Error("Prepared agent database lease belongs to another store");
    }
    let verification: OpenClawAgentIntegrityVerification | undefined;
    let hasLiveLease = false;
    const captureVerification: OpenClawAgentIntegrityVerificationReceiver = (record, liveLease) => {
      verification = record;
      hasLiveLease = liveLease;
    };
    const leaseId = preparedLease
      ? preparedLease.claim(captureVerification)
      : claimOpenClawAgentDatabaseLease(
          { agentId, path: pathname, env: leaseEnvironment },
          undefined,
          captureVerification,
        );
    assertRegistrationLease = () =>
      assertOpenClawAgentDatabaseLease(leaseId, { agentId, path: pathname, env: leaseEnvironment });
    if (pending) {
      pending.assertHeld = () =>
        assertOpenClawAgentDatabaseLease(leaseId, {
          agentId,
          path: pathname,
          env: leaseEnvironment,
        });
    }
    const diagnostics: SqliteIntegrityDiagnostics = {};
    const finishPhase = startAgentDatabaseOpenTiming(
      agentId,
      pathname,
      pending ? "async" : "sync",
      diagnostics,
    );
    let openedDb: DatabaseSync | undefined;
    let openedDatabase: OpenClawAgentDatabase | undefined;
    let openedWalMaintenance: SqliteWalMaintenance | undefined;
    try {
      ensureOpenClawAgentDatabasePermissions(pathname, databaseOptions);
      closeIdleOpenClawAgentDatabaseReadOnly(pathname);
      // Ordinary agent state also works with SQLite builds that omit extensions.
      // Trusted borrowers may enable them only when both the runtime and permissions allow it.
      const db = openNodeSqliteDatabase(pathname, { allowExtension });
      db.enableLoadExtension(false);
      enableNodeSqliteKyselyStatementCache(db);
      openedDb = db;
      if (preparedLease) {
        // Worker TEMP policy precedes schema/session caches and any exposed connection.
        db.exec("PRAGMA temp_store = FILE");
      }
      registerOpenClawAgentDatabaseIdentity(db);
      finishPhase("open");
      // Eviction churn must avoid migration/convergence and registry busy waits.
      // Version and owner can change while evicted, so their read-only gates run on every open.
      const validationDatabase = { db, path: pathname, agentId };
      const validation = pending?.validation ?? preparedLease?.validation;
      if (validation) {
        adoptOpenClawAgentDatabaseValidation(validationDatabase, validation);
      }
      let isValidatedReopen = Boolean(getOpenClawAgentDatabaseValidation(validationDatabase));
      const walMaintenance = yield* (function* (): SqliteIntegrityOperation<SqliteWalMaintenance> {
        let maintenance: OpenClawAgentDatabase["walMaintenance"] | undefined;
        try {
          db.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
          assertSupportedAgentSchemaVersion(db, pathname);
          const existingSchema = readExistingAgentSchemaMeta(db);
          assertExistingAgentSchemaOwner(existingSchema, agentId, pathname);
          // Live owners may lend runtime proof; cold opens require clean-close proof.
          // Both remain subject to durable invalidation and schema convergence.
          const requiresCurrentVersionConvergence =
            yield* agentDatabaseIntegrityBeforeMutationSteps(
              db,
              agentId,
              pathname,
              diagnostics,
              verification,
              isValidatedReopen && hasLiveLease,
              registration.beforeMutation,
            );
          if (isValidatedReopen && (!existingSchema || requiresCurrentVersionConvergence)) {
            // New files and same-version divergence cannot inherit an earlier validation.
            // The existing full path initializes or converges them before exposure.
            invalidateOpenClawAgentDatabaseValidation(pathname);
            isValidatedReopen = false;
          }
          assertCanonicalAgentPersistenceVersion(db, pathname);
          finishPhase("validation");
          configureSqlitePreSchemaPragmas(db, {
            busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
          });
          maintenance = configureSqliteConnectionPragmas(db, {
            busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
            databaseLabel: `openclaw-agent:${agentId}`,
            databasePath: pathname,
            foreignKeys: true,
            synchronous: "NORMAL",
          });
          openedWalMaintenance = maintenance;
          finishPhase("configuration");
          if (!isValidatedReopen) {
            ensureOpenClawAgentSchema(
              db,
              agentId,
              pathname,
              undefined,
              registration.beforeMutation,
            );
          }
          finishPhase("schema");
          return maintenance;
        } catch (err) {
          maintenance?.close();
          if (db.isOpen) {
            db.close();
          }
          const current = cache.databases.get(pathname);
          if (!current || current.db === db) {
            invalidateOpenClawAgentDatabaseValidation(pathname);
          }
          if (
            err instanceof Error &&
            (isSqliteSchemaVersionError(err) || isTerminalSqliteIntegrityError(err))
          ) {
            recordOpenClawAgentDatabaseOpenFailure(pathname, err);
          }
          throw err;
        }
      })();
      ensureOpenClawAgentDatabasePermissions(pathname, databaseOptions);
      const database = { agentId, db, path: pathname, walMaintenance };
      openedDatabase = database;
      if (hasAgentDatabaseMaintenanceAuthority()) {
        throw new Error(
          "Agent database maintenance is in progress; retry after openclaw doctor --fix completes.",
        );
      }
      const cleanup = registerAgentDeletionDatabaseCleanup(database, databaseOptions);
      if (cleanup) {
        const release = retainAgentDatabase(db);
        cleanup.registerClose(() => {
          release();
          // The scope owns this connection, not a later cache entry at the same pathname.
          if (cache.databases.get(database.path) === database) {
            closeOpenClawAgentDatabaseByPath(database.path, database.agentId);
          } else if (database.db.isOpen) {
            throw new Error("Agent deletion cleanup lost its database close owner.");
          }
        });
      }
      if (!isValidatedReopen) {
        registerOpenClawAgentDatabase(
          { agentId, path: pathname, env: options.env },
          onRegistrationCommitted,
          { owner: registration, readSource: () => readOpenClawAgentReadOnlySchemaFacts(database) },
        );
        setOpenClawAgentDatabaseValidation(database);
      }
      cache.terminal.clear(pathname);
      // Safety net for processes that end without an orderly close: agent DBs have
      // no shutdown owner like the ACP/gateway state DB closes. Closing unregisters.
      cache.unregisterExitClose ??= registerSqliteCacheExitClose(closeOpenClawAgentDatabases);
      finishPhase("registration");
      cache.leases.set(pathname, { leaseId, env: leaseEnvironment });
      cache.databases.set(pathname, database);
      const identity = readOpenClawAgentDatabaseIdentity(database).identity;
      if (diagnostics.integrityGateOutcome === "cached") {
        if (preparedLease) {
          requestSqliteWorkerOperationAdmission({
            stage: "prepare",
            facts: {
              kind: "agent-integrity-cached",
              lease: preparedLease.receipt,
            },
          });
        } else {
          requestOpenClawAgentDatabaseQuickCheck({ path: pathname, env: leaseEnvironment });
        }
      } else if (typeof identity === "string") {
        recordOpenClawAgentDatabaseIntegrityVerified(
          leaseId,
          { agentId, path: pathname, env: leaseEnvironment },
          identity,
        );
      }
      refreshAgentDatabaseIdleTimer(database);
      if (isMainThread) {
        const writeOptions = { agentId, path: pathname, env: leaseEnvironment };
        registerSqliteWalWriteAdmission(db, (operation) =>
          runOpenClawAgentWriteAdmission(writeOptions, () => {
            if (findOpenClawAgentDatabaseIfOpen(writeOptions) === database) {
              operation();
            }
          }),
        );
      }
      getOpenClawDatabaseMaintenanceScope()?.own(database.db, "agent-handles", () =>
        closeMaintenanceAgentDatabase(database),
      );
      return database;
    } catch (error) {
      let closeError: unknown;
      if (openedDatabase) {
        try {
          closeCachedOpenClawAgentDatabase(openedDatabase);
        } catch (caught) {
          closeError = caught;
        }
      }
      if (openedDb?.isOpen) {
        if (
          pending &&
          cache.databases.has(pathname) &&
          cache.databases.get(pathname)?.db !== openedDb
        ) {
          // A synchronous opener may supersede pending work. Retain failed cleanup
          // with its original native owner; never overwrite the replacement cache/lease.
          const retainedDb = openedDb;
          registrationCleanupRetained = localRegistration !== undefined;
          retainFailedAgentDatabaseClose(
            agentId,
            pathname,
            () => {
              openedWalMaintenance?.close();
              if (retainedDb.isOpen) {
                retainedDb.close();
              }
              releaseOpenClawAgentDatabaseLease(leaseId, { env: leaseEnvironment });
            },
            { onSettled: () => localRegistration?.finish() },
          );
          throw error;
        }
        invalidateOpenClawAgentDatabaseValidation(pathname);
        const retainedDatabase =
          openedDatabase ??
          ({
            agentId,
            db: openedDb,
            path: pathname,
            walMaintenance: openedWalMaintenance ?? {
              checkpoint: () => false,
              reclaimFreePages: createSqliteWalReclamationResult,
              close: () => false,
            },
          } satisfies OpenClawAgentDatabase);
        // Failed opens remain disposal-owned but cannot become successful cache hits.
        cache.databases.set(pathname, retainedDatabase);
        refreshAgentDatabaseIdleTimer(retainedDatabase);
        cache.leases.set(pathname, { leaseId, env: leaseEnvironment });
        cache.failures.set(pathname, closeError ?? error);
        if (localRegistration) {
          registrationCleanupRetained = true;
          retainFailedAgentDatabaseClose(
            agentId,
            pathname,
            () => {
              if (cache.databases.get(pathname) !== retainedDatabase) {
                throw new Error("Retained agent disposal lost its exact cached owner");
              }
              closeCachedOpenClawAgentDatabase(retainedDatabase);
              if (cache.databases.get(pathname) === retainedDatabase) {
                cache.databases.delete(pathname);
                cache.failures.delete(pathname);
              }
            },
            { database: retainedDatabase.db, onSettled: () => localRegistration.finish() },
          );
        }
        getOpenClawDatabaseMaintenanceScope()?.own(retainedDatabase.db, "agent-handles", () =>
          closeMaintenanceAgentDatabase(retainedDatabase),
        );
        cache.unregisterExitClose ??= registerSqliteCacheExitClose(closeOpenClawAgentDatabases);
      } else {
        try {
          releaseOpenClawAgentDatabaseLease(leaseId, { env: leaseEnvironment });
        } catch (releaseError) {
          registrationCleanupRetained = localRegistration !== undefined;
          retainFailedAgentDatabaseClose(
            agentId,
            pathname,
            () => releaseOpenClawAgentDatabaseLease(leaseId, { env: leaseEnvironment }),
            { onSettled: () => localRegistration?.finish() },
          );
          throw releaseError;
        }
      }
      throw closeError ?? error;
    }
  } finally {
    if (!registrationCleanupRetained) localRegistration?.finish();
  }
}

/** Queue a non-throwing runtime publication on the outer database commit edge. */
export function deferOpenClawAgentPostCommitPublication(
  database: OpenClawAgentDatabase,
  publish: () => void,
): boolean {
  return deferSqlitePostCommitPublication(database.db, publish);
}

export function runOpenClawAgentWriteTransaction<T>(
  operation: (database: OpenClawAgentDatabase) => T,
  options: OpenClawAgentDatabaseOptions,
  transactionOptions: Pick<
    SqliteTransactionOptions,
    "busyTimeoutMs" | "operationLabel" | "slowTransactionHoldMs"
  > = {},
): T {
  const database = openOpenClawAgentDatabase(options);
  const enteredNestedTransaction = database.db.isTransaction;
  return withSqlitePostCommitPublications(database.db, () =>
    runSqliteImmediateTransactionSync(
      database.db,
      () => {
        assertAgentDeletionDatabaseCleanupAccess(database, options);
        const operationResult = operation(database);
        if (!enteredNestedTransaction && !cache.incognito.has(database)) {
          // Permission failure must roll back with the write. Repairing after
          // COMMIT could make callers retry a transaction already durable in SQLite.
          ensureOpenClawAgentDatabasePermissions(database.path, options);
        }
        return operationResult;
      },
      {
        busyTimeoutMs: transactionOptions.busyTimeoutMs ?? OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: database.path,
        ...transactionOptions,
        operationLabel: transactionOptions.operationLabel ?? "agent.write",
        withCommit: getAgentDeletionDatabaseCleanup(options)?.withCommit,
      },
    ),
  );
}

/** Retain the exact verified connection across awaits; explicit disposal still revokes it. */
export function borrowOpenClawAgentDatabase(options: OpenClawAgentDatabaseOptions): {
  db: DatabaseSync;
  release: () => void;
} {
  const { db } = openOpenClawAgentDatabase(options);
  return { db, release: retainAgentDatabase(db) };
}

export { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db-maintenance-lease.js";

export {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabases,
  closeOpenClawAgentDatabasesAsync,
  inspectOpenClawAgentDatabaseOwner,
  isIncognitoOpenClawAgentDatabase,
  listOpenIncognitoAgentDatabases,
  readOpenIncognitoAgentDatabaseGeneration,
  settleOpenClawAgentDatabaseWorkerClose,
  type OpenClawAgentDatabaseWorkerCloseResult,
} from "./openclaw-agent-db-lifecycle.js";
