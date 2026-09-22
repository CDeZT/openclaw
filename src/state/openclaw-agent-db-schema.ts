import type { DatabaseSync } from "node:sqlite";
import { migrateMemoryIndexSourcesIdentity } from "../../packages/memory-host-sdk/src/host/memory-schema.js";
import {
  repairCanonicalSqliteIndexes,
  verifyAndRepairCanonicalSqliteIndexes,
  verifyAndRepairCanonicalSqliteIndexSteps,
} from "../infra/sqlite-index-schema.js";
import {
  assertSqliteIntegrity,
  runSqliteIntegrityOperationSync,
  sqliteIntegrityCheckSteps,
  type SqliteIntegrityDiagnostics,
  type SqliteIntegrityOperation,
} from "../infra/sqlite-integrity.js";
import { migrateSqliteSchemaToStrictInTransaction } from "../infra/sqlite-strict.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { configureSqlitePreSchemaPragmas } from "../infra/sqlite-wal.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { ensureOpenClawAgentBoardSchemaInTransaction } from "./openclaw-agent-board-schema.js";
import { canonicalSessionValidationSchemaSql } from "./openclaw-agent-canonical-validation-schema.js";
import {
  AGENT_MEDIA_SCHEMA_VERSION,
  CANONICAL_SESSION_VALIDATION_SCHEMA_VERSION,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  TRANSCRIPT_FTS_ROW_SCHEMA_VERSION,
  type OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db-contract.js";
import * as maintenanceAuthority from "./openclaw-agent-db-lease.js";
import { persistAgentSchemaMetadata } from "./openclaw-agent-db-metadata-write.js";
import { ensureOpenClawAgentDatabasePermissions } from "./openclaw-agent-db-permissions.js";
import { captureOpenClawAgentDatabaseRegistration } from "./openclaw-agent-db-registry-listing.js";
import { registerOpenClawAgentDatabase } from "./openclaw-agent-db-registry.js";
import {
  getOpenClawAgentMigrationSchema,
  assertExistingAgentSchemaOwner,
  assertOpenClawAgentCurrentRuntimeSchema,
  assertSupportedAgentSchemaVersion,
  assertAgentSchemaVersion,
  hasPendingCurrentVersionAgentDatabaseMigration,
  hasPendingMemoryChunkMetadataMigration,
  migrateRetiredAgentStateLeaseSchema,
  ensureSessionKeyContractSchemaInTransaction,
  readExistingAgentSchemaMeta,
  repairAndAssertOpenClawAgentV14SchemaForMigration,
} from "./openclaw-agent-db-schema-helpers.js";
import {
  dropLegacyMemoryIndexSchema,
  migrateMemoryChunkMetadataSchema,
  migrateOpenClawAgentSchema,
  backfillOpenClawAgentSchema,
} from "./openclaw-agent-db-schema-legacy-migrations.js";
import {
  backfillSessionConversations,
  dropLegacyRuntimeJournalSchemas,
  dropLegacySessionTranscriptSearchSchema,
  ensureSessionAdditiveColumns,
  ensureSessionEntryValidityProjection,
  migrateConversationDeliveryTargetColumn,
  migrateSessionCreatorNamespaces,
  migrateSessionTranscriptActiveProjection,
  migrateSessionTranscriptGenerations,
} from "./openclaw-agent-db-session-migrations.js";
import { migrateSessionNodesAndWindows } from "./openclaw-agent-db-session-nodes-migration.js";
import { backfillSessionEntryProvenance } from "./openclaw-agent-db-session-provenance.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import {
  migrateSessionParticipantsSchema,
  withLegacySessionParticipantsSchema,
} from "./openclaw-agent-participants-migration.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { migrateTranscriptFtsRowSchema } from "./openclaw-agent-transcript-fts-schema.js";
import {
  canReuseOpenClawAgentIntegrityVerification,
  type OpenClawAgentIntegrityVerification,
} from "./openclaw-quarantine-store.js";
import { getOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

const agentDbLog = createSubsystemLogger("state/agent-db");

export function* agentDatabaseIntegrityBeforeMutationSteps(
  database: DatabaseSync,
  agentId: string,
  pathname: string,
  diagnostics?: SqliteIntegrityDiagnostics,
  verification?: OpenClawAgentIntegrityVerification,
  reuseRuntimeIntegrity = false,
  beforeMutation: () => void = () => {
    if (database.location()) {
      throw new Error("Persistent agent schema mutation requires its root-bound owner");
    }
  },
): SqliteIntegrityOperation<boolean> {
  database.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
  const userVersion = readSqliteUserVersion(database);
  const hasApplicationSchema = database
    .prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1")
    .get();
  const migrationPending =
    (userVersion === 0 && hasApplicationSchema !== undefined) ||
    (userVersion > 0 && userVersion < OPENCLAW_AGENT_SCHEMA_VERSION);
  if (migrationPending) {
    agentDbLog.info("agent database schema migration pending; verifying integrity first", {
      fromVersion: userVersion,
      path: pathname,
      toVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
  }
  const hasPendingCurrentVersionMigration =
    userVersion === OPENCLAW_AGENT_SCHEMA_VERSION &&
    hasPendingCurrentVersionAgentDatabaseMigration(database);
  if (userVersion === OPENCLAW_AGENT_SCHEMA_VERSION && !hasPendingCurrentVersionMigration) {
    const startedAt = performance.now();
    const rebuiltIndexes = yield* verifyAndRepairCanonicalSqliteIndexSteps(
      database,
      pathname,
      OPENCLAW_AGENT_SCHEMA_SQL,
      {
        allowMissingColumns: true,
        beforeMutation,
        validateAfterRepair: () =>
          assertOpenClawAgentCurrentRuntimeSchema(database, { agentId, pathname }),
        diagnostics,
        reuseIntegrity: canReuseOpenClawAgentIntegrityVerification(
          pathname,
          verification,
          migrationPending || hasPendingCurrentVersionMigration,
          reuseRuntimeIntegrity,
        ),
      },
    );
    if (rebuiltIndexes.length > 0) {
      agentDbLog.warn(
        `Rebuilt canonical agent SQLite indexes for ${agentId} (${pathname}): ${rebuiltIndexes.join(", ")}`,
        {
          agentId,
          path: pathname,
          indexes: rebuiltIndexes,
          elapsedMs: Math.floor(performance.now() - startedAt),
        },
      );
    }
    assertOpenClawAgentCurrentRuntimeSchema(database, { agentId, pathname });
  } else if (
    userVersion === 0 &&
    !hasApplicationSchema &&
    database.prepare("PRAGMA page_count").get()?.page_count === 0
  ) {
    // Publish a fresh empty database's owner before another local caller resolves its store.
    // Yielding first leaves an occupied, unowned file that custom selectors must avoid.
    assertSqliteIntegrity(database, pathname);
  } else {
    // Pending migrations cannot inherit an earlier runtime verification.
    yield* sqliteIntegrityCheckSteps(database, pathname, diagnostics);
  }
  return hasPendingCurrentVersionMigration;
}

function seedCanonicalSessionValidationPending(db: DatabaseSync): void {
  // Migration records work only; the canonical owner validates and certifies row contents.
  db.exec(`
    INSERT INTO session_canonical_validation_pending (session_key)
    SELECT node.session_key FROM session_nodes AS node
    WHERE NOT EXISTS (
      SELECT 1 FROM session_canonical_validation_pending AS pending
      WHERE pending.session_key = node.session_key
    );
  `);
}

function ensureAgentSchema(
  db: DatabaseSync,
  agentId: string,
  pathname: string,
  targetVersion = OPENCLAW_AGENT_SCHEMA_VERSION,
  beforeMutation: () => void = () => {
    if (db.location()) {
      throw new Error("Persistent agent schema mutation requires its root-bound owner");
    }
  },
): void {
  const schemaSql = getOpenClawAgentMigrationSchema(targetVersion);
  // Media conversion uses current transcript rewrites before publishing its version.
  const isMediaPrerequisite = targetVersion === AGENT_MEDIA_SCHEMA_VERSION - 1;
  const originalVersion = readSqliteUserVersion(db);
  const schemaMigration =
    originalVersion < targetVersion &&
    (originalVersion > 0 || readExistingAgentSchemaMeta(db) !== null);
  const identityMigration = targetVersion >= 18 && schemaMigration;
  const assertMigration = () => {
    if (identityMigration) {
      maintenanceAuthority.assertAgentDatabaseMaintenanceAuthority();
    }
    getOpenClawDatabaseMaintenanceScope()?.assertAgentSchemaMigration({
      agentId,
      path: pathname,
      foundVersion: originalVersion,
      supportedVersion: targetVersion,
    });
  };
  if (schemaMigration) {
    assertMigration();
  }
  // FK enforcement must be off before BEGIN: PRAGMA foreign_keys is a silent
  // no-op inside a transaction, and legacy owner-table rebuilds would otherwise
  // cascade-delete their children. Steady-state enforcement is restored below.
  db.exec("PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = OFF;");
  try {
    runSqliteImmediateTransactionSync(db, () => {
      // Repeat preflight ownership/version gates inside the write transaction;
      // concurrent openers must not overwrite another agent after the scan.
      // Role/ownership gates before version: user_version is only meaningful
      // within one schema role, and the global state DB now carries version 3.
      assertExistingAgentSchemaOwner(readExistingAgentSchemaMeta(db), agentId, pathname);
      assertSupportedAgentSchemaVersion(db, pathname);
      const previousVersion = readSqliteUserVersion(db);
      if (identityMigration && readExistingAgentSchemaMeta(db)?.schemaVersion !== previousVersion) {
        throw new Error(
          `Agent schema markers disagree for ${pathname}; repair ownership metadata before migration.`,
        );
      }
      if (previousVersion > targetVersion) {
        throw new Error(
          `OpenClaw agent database ${pathname} uses schema version ${previousVersion}; expected at most ${targetVersion} for this migration.`,
        );
      }
      if (previousVersion !== targetVersion || hasPendingCurrentVersionAgentDatabaseMigration(db)) {
        // Structural migration is known here; row and trigger convergence also
        // fence at their actual mutation owners below.
        beforeMutation();
      }
      if (
        previousVersion >= CANONICAL_SESSION_VALIDATION_SCHEMA_VERSION - 1 &&
        previousVersion < targetVersion &&
        targetVersion <= TRANSCRIPT_FTS_ROW_SCHEMA_VERSION
      ) {
        const previousSchema = getOpenClawAgentMigrationSchema(previousVersion);
        repairCanonicalSqliteIndexes(db, pathname, previousSchema, {
          verifyPhysicalIntegrity: false,
          beforeMutation,
        });
        assertAgentSchemaVersion(
          db,
          { agentId, pathname, version: previousVersion },
          previousSchema,
        );
        if (previousVersion < CANONICAL_SESSION_VALIDATION_SCHEMA_VERSION) {
          db.exec(canonicalSessionValidationSchemaSql(schemaSql));
          seedCanonicalSessionValidationPending(db);
        }
        if (targetVersion >= TRANSCRIPT_FTS_ROW_SCHEMA_VERSION) {
          migrateTranscriptFtsRowSchema(db);
        }
        db.exec(`PRAGMA user_version = ${targetVersion};`);
        persistAgentSchemaMetadata(db, agentId, targetVersion);
        assertAgentSchemaVersion(db, { agentId, pathname, version: targetVersion }, schemaSql);
        assertMigration();
        return;
      }
      if (previousVersion === AGENT_MEDIA_SCHEMA_VERSION) {
        const legacySql = withLegacySessionParticipantsSchema(OPENCLAW_AGENT_SCHEMA_SQL);
        ensureSessionAdditiveColumns(db, beforeMutation);
        verifyAndRepairCanonicalSqliteIndexes(db, pathname, legacySql, {
          beforeMutation,
          validateAfterRepair: () => {
            assertAgentSchemaVersion(
              db,
              { agentId, pathname, version: AGENT_MEDIA_SCHEMA_VERSION },
              legacySql,
            );
          },
        });
      }
      migrateRetiredAgentStateLeaseSchema(db, pathname, targetVersion);
      if (previousVersion === targetVersion) {
        ensureSessionAdditiveColumns(db, beforeMutation);
        ensureSessionEntryValidityProjection(db, beforeMutation);
        ensureSessionKeyContractSchemaInTransaction(db, beforeMutation);
        if (hasPendingMemoryChunkMetadataMigration(db)) {
          migrateMemoryChunkMetadataSchema(db);
          db.exec(schemaSql);
        }
        if (isMediaPrerequisite) {
          migrateTranscriptFtsRowSchema(db);
        }
        // Repeat index repair before the transactional schema assertion so a
        // concurrent opener cannot turn repairable drift into a hard refusal.
        repairCanonicalSqliteIndexes(db, pathname, schemaSql, {
          verifyPhysicalIntegrity: false,
          beforeMutation,
        });
        persistAgentSchemaMetadata(db, agentId, targetVersion);
        assertAgentSchemaVersion(db, { agentId, pathname, version: targetVersion }, schemaSql);
        maintenanceAuthority.assertAgentDatabaseMaintenanceAuthorityIfPresent();
        return;
      } else if (previousVersion === 14) {
        repairAndAssertOpenClawAgentV14SchemaForMigration(db, { agentId, pathname });
      }
      // Structure-gated helpers converge both legacy memory schema lineages.
      dropLegacyMemoryIndexSchema(db);
      dropLegacySessionTranscriptSearchSchema(db);
      dropLegacyRuntimeJournalSchemas(db);
      maintenanceAuthority.renewAgentDatabaseMaintenanceAuthorityIfPresent();
      migrateMemoryIndexSourcesIdentity(db);
      migrateOpenClawAgentSchema(db);
      migrateConversationDeliveryTargetColumn(db);
      backfillOpenClawAgentSchema(db, previousVersion);
      // Remove after 2026-10-01: drop the pre-v11 conversation backfill once schema 11 is the support floor.
      if (previousVersion < 11) {
        backfillSessionConversations(db);
      }
      backfillSessionEntryProvenance(db, previousVersion);
      migrateSessionNodesAndWindows(db, previousVersion);
      maintenanceAuthority.renewAgentDatabaseMaintenanceAuthorityIfPresent();
      ensureSessionAdditiveColumns(db, beforeMutation);
      ensureSessionEntryValidityProjection(db, beforeMutation);
      if (targetVersion >= 18 && previousVersion < 18) {
        migrateSessionParticipantsSchema(db, pathname);
      }
      if (targetVersion >= 19) {
        migrateSessionCreatorNamespaces(db, previousVersion);
      }
      maintenanceAuthority.renewAgentDatabaseMaintenanceAuthorityIfPresent();
      db.exec(schemaSql);
      if (isMediaPrerequisite || targetVersion >= TRANSCRIPT_FTS_ROW_SCHEMA_VERSION) {
        migrateTranscriptFtsRowSchema(db);
      }
      migrateMemoryChunkMetadataSchema(db);
      if (previousVersion < targetVersion) {
        ensureOpenClawAgentBoardSchemaInTransaction(db);
      }
      migrateSessionTranscriptGenerations(db, previousVersion);
      migrateSessionTranscriptActiveProjection(db, previousVersion);
      if (previousVersion < 11) {
        migrateSqliteSchemaToStrictInTransaction(db, schemaSql, {
          databaseLabel: pathname,
        });
      }
      if (
        previousVersion < CANONICAL_SESSION_VALIDATION_SCHEMA_VERSION &&
        targetVersion >= CANONICAL_SESSION_VALIDATION_SCHEMA_VERSION
      ) {
        seedCanonicalSessionValidationPending(db);
      }
      repairCanonicalSqliteIndexes(db, pathname, schemaSql, {
        verifyPhysicalIntegrity: false,
        beforeMutation,
      });
      db.exec(`PRAGMA user_version = ${targetVersion};`);
      persistAgentSchemaMetadata(db, agentId, targetVersion);
      assertAgentSchemaVersion(db, { agentId, pathname, version: targetVersion }, schemaSql);
      if (identityMigration) {
        if (db.prepare("PRAGMA foreign_key_check").all().length > 0) {
          throw new Error(
            `Agent identity migration failed foreign key validation for ${pathname}.`,
          );
        }
      }
      if (schemaMigration) {
        assertMigration();
      }
    });
  } finally {
    if (db.isOpen) {
      db.exec("PRAGMA foreign_keys = ON;");
    }
  }
}

/** Initialize agent schema/ownership metadata on an independently managed connection. */
export function ensureOpenClawAgentDatabaseSchema(
  db: DatabaseSync,
  options: OpenClawAgentDatabaseOptions & { register?: boolean },
): void {
  runSqliteIntegrityOperationSync(ensureOpenClawAgentDatabaseSchemaSteps(db, options));
}

/** Share one schema sequence between synchronous callers and leased maintenance. */
export function* ensureOpenClawAgentDatabaseSchemaSteps(
  db: DatabaseSync,
  options: OpenClawAgentDatabaseOptions & { register?: boolean },
): SqliteIntegrityOperation<void> {
  const agentId = normalizeAgentId(options.agentId);
  const databaseOptions = { ...options, agentId };
  const pathname = resolveOpenClawAgentSqlitePath(databaseOptions);
  const custody = db.location()
    ? captureOpenClawAgentDatabaseRegistration({
        agentId,
        agentPath: pathname,
        admission: captureOpenClawStateWorkerContext({ env: options.env }).admission,
        publish: false,
      })
    : undefined;
  try {
    custody?.begin();
    custody?.beforeMutation();
    if (db.location()) {
      maintenanceAuthority.invalidateOpenClawAgentDatabaseIntegrityBeforeMutation(
        pathname,
        databaseOptions.env,
      );
    }
    ensureOpenClawAgentDatabasePermissions(pathname, databaseOptions);
    db.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
    assertSupportedAgentSchemaVersion(db, pathname);
    assertExistingAgentSchemaOwner(readExistingAgentSchemaMeta(db), agentId, pathname);
    if (readSqliteUserVersion(db) !== AGENT_MEDIA_SCHEMA_VERSION) {
      yield* agentDatabaseIntegrityBeforeMutationSteps(
        db,
        agentId,
        pathname,
        undefined,
        undefined,
        false,
        custody?.beforeMutation,
      );
    }
    configureSqlitePreSchemaPragmas(db, {
      busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
    });
    ensureAgentSchema(db, agentId, pathname, undefined, custody?.beforeMutation);
    ensureOpenClawAgentDatabasePermissions(pathname, databaseOptions);
    if (databaseOptions.register === true) {
      registerOpenClawAgentDatabase({ agentId, path: pathname, env: databaseOptions.env });
    }
  } finally {
    custody?.finish();
  }
}

/** Upgrade older owned databases to the structural schema required by the media cutover. */
export function migrateOpenClawAgentDatabaseToMediaPrerequisiteSchema(
  db: DatabaseSync,
  options: OpenClawAgentDatabaseOptions,
): void {
  const targetVersion = AGENT_MEDIA_SCHEMA_VERSION - 1;
  if (readSqliteUserVersion(db) > targetVersion) {
    return;
  }
  const agentId = normalizeAgentId(options.agentId);
  const pathname = resolveOpenClawAgentSqlitePath({ ...options, agentId });
  const custody = db.location()
    ? captureOpenClawAgentDatabaseRegistration({
        agentId,
        agentPath: pathname,
        admission: captureOpenClawStateWorkerContext({ env: options.env }).admission,
        publish: false,
      })
    : undefined;
  try {
    custody?.begin();
    custody?.beforeMutation();
    if (db.location()) {
      maintenanceAuthority.invalidateOpenClawAgentDatabaseIntegrityBeforeMutation(
        pathname,
        options.env,
      );
    }
    runSqliteIntegrityOperationSync(
      agentDatabaseIntegrityBeforeMutationSteps(
        db,
        agentId,
        pathname,
        undefined,
        undefined,
        false,
        custody?.beforeMutation,
      ),
    );
    configureSqlitePreSchemaPragmas(db, {
      busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
    });
    ensureAgentSchema(db, agentId, pathname, targetVersion, custody?.beforeMutation);
  } finally {
    custody?.finish();
  }
}

export { ensureAgentSchema as ensureOpenClawAgentSchema };
