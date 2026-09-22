import path from "node:path";
import type { SqliteFileGeneration } from "../infra/sqlite-file-generation.js";
import {
  confirmSqliteFileIntegrity,
  type SqliteIntegrityConfirmation,
} from "../infra/sqlite-integrity.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { assertAgentDatabaseAdmitted } from "./agent-database-admission.js";
import {
  assertAgentDeletionCleanupAliases,
  assertAgentDeletionDatabaseCleanupAccess,
} from "./agent-deletion-cleanup.js";
import { readAgentDeletionJournal } from "./agent-deletion-journal.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db-contract.js";
import {
  agentDatabaseLifecycle as cache,
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabases,
  refreshAgentDatabaseIdleTimer,
  retainAgentDatabase,
  revokePendingAgentDatabaseOpen,
} from "./openclaw-agent-db-lifecycle.js";
import {
  isSameOpenClawAgentDatabasePath,
  unregisterOpenClawAgentDatabase,
} from "./openclaw-agent-db-registry.js";
import {
  matchesAgentDatabaseReadCandidatePath,
  type OpenClawAgentDatabaseReadCandidateResource,
} from "./openclaw-agent-db-resources.js";
import {
  clearOpenClawAgentDatabaseValidationCache,
  invalidateOpenClawAgentDatabaseValidation,
} from "./openclaw-agent-db-validation-cache.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.paths.js";
import { clearOpenClawDatabaseQuarantine } from "./openclaw-quarantine-store.js";
import { observeOpenClawDatabaseMaintenanceResource } from "./openclaw-state-db-async-lifecycle.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db-contract.js";

/** Reconfirm an advisory worker failure on the live owner connection. */
export async function confirmOpenClawAgentDatabaseIntegrity(
  pathname: string,
): Promise<SqliteIntegrityConfirmation> {
  const resolvedPath = path.resolve(pathname);
  await closeOpenClawAgentDatabaseByPathAsync(resolvedPath);
  // Closing breaks process ownership of the pathname. A replacement must
  // revalidate and claim its schema before the path can become trusted again.
  invalidateOpenClawAgentDatabaseValidation(resolvedPath);
  return confirmSqliteFileIntegrity(resolvedPath, resolvedPath);
}

/** Latch background verification damage so later opens fail without rescanning. */
export function recordOpenClawAgentDatabaseOpenFailure(
  pathname: string,
  error: Error,
  generation?: SqliteFileGeneration,
): boolean {
  const recorded = cache.terminal.record(pathname, error, generation);
  if (recorded) {
    // Quarantine revokes this process's trust because doctor may replace the file.
    invalidateOpenClawAgentDatabaseValidation(pathname);
  }
  return recorded;
}

/**
 * Clear a terminal open failure after doctor rewrites the database file.
 * Returns false when the persisted quarantine row survived; callers must
 * surface that, or the next open re-quarantines the repaired file.
 */
export function clearOpenClawAgentDatabaseOpenFailure(
  pathname: string,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  const resolvedPath = path.resolve(pathname);
  const cleared = clearOpenClawDatabaseQuarantine(resolvedPath, { env: options.env });
  cache.terminal.clear(resolvedPath);
  return cleared;
}

/** Return whether the exact cached agent database pathname is still open. */
export function isOpenClawAgentDatabaseOpen(pathname: string): boolean {
  return cache.databases.get(path.resolve(pathname))?.db.isOpen === true;
}

/** Return the matching live cache entry without materializing a database. */
export function getOpenClawAgentDatabaseIfOpen(
  options: OpenClawAgentDatabaseOptions,
): OpenClawAgentDatabase | undefined {
  const database = findOpenClawAgentDatabaseIfOpen(options);
  if (database) {
    refreshAgentDatabaseIdleTimer(database);
  }
  return database;
}

export function findOpenClawAgentDatabaseIfOpen(
  options: OpenClawAgentDatabaseOptions,
): OpenClawAgentDatabase | undefined {
  const agentId = normalizeAgentId(options.agentId);
  assertAgentDatabaseAdmitted(agentId, { env: options.env });
  const pathname = resolveOpenClawAgentSqlitePath({ ...options, agentId });
  // Incognito skips durable database leases, but still follows the agent deletion fence.
  if (
    isIncognitoOpenClawAgentSqlitePath(pathname, options) &&
    readAgentDeletionJournal(agentId, { env: options.env })
  ) {
    throw new Error(`OpenClaw agent database is unavailable while agent ${agentId} is deleted.`);
  }
  const database = cache.databases.get(pathname);
  if (!database?.db.isOpen) {
    assertAgentDeletionCleanupAliases(options, isSameOpenClawAgentDatabasePath);
    return undefined;
  }
  if (cache.failures.has(pathname)) {
    throw cache.failures.get(pathname);
  }
  if (database.agentId !== agentId) {
    throw new Error(
      `OpenClaw agent database ${pathname} is already open for agent ${database.agentId}; requested agent ${agentId}.`,
    );
  }
  assertAgentDeletionDatabaseCleanupAccess(database, options);
  observeOpenClawDatabaseMaintenanceResource(database.db);
  return database;
}

/** Pin only admitted native readers already present in captured discovery families. */
export function retainOpenClawAgentDatabaseReadCandidates(
  candidates: readonly Pick<OpenClawAgentDatabaseReadCandidateResource, "path" | "scope">[],
  env: NodeJS.ProcessEnv,
): { databases: readonly OpenClawAgentDatabase[]; release: () => void } {
  const retained: Array<{ database: OpenClawAgentDatabase; release: () => void }> = [];
  const release = () => {
    for (const reader of retained.toReversed()) {
      reader.release();
    }
  };
  try {
    for (const database of cache.databases.values()) {
      if (
        !database.db.isOpen ||
        database.db.isTransaction ||
        cache.incognito.has(database) ||
        !candidates.some((candidate) =>
          matchesAgentDatabaseReadCandidatePath(candidate, database.path),
        )
      ) {
        continue;
      }
      let admitted: OpenClawAgentDatabase | undefined;
      try {
        admitted = getOpenClawAgentDatabaseIfOpen({
          agentId: database.agentId,
          path: database.path,
          env,
        });
      } catch {
        // A refused cached writer cannot supply a read continuation. Fresh reads
        // retain the existing independent read-only schema and ownership checks.
        continue;
      }
      if (admitted === database) {
        retained.push({ database, release: retainAgentDatabase(database.db) });
      }
    }
    return { databases: retained.map(({ database }) => database), release };
  } catch (error) {
    release();
    throw error;
  }
}

/** Close and unregister one unambiguous transient agent database by filesystem identity. */
export function disposeOpenClawAgentDatabaseByPath(
  pathname: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): boolean {
  const resolvedPath = path.resolve(pathname);
  for (const pendingPath of cache.pending.keys()) {
    if (isSameOpenClawAgentDatabasePath(pendingPath, resolvedPath)) {
      revokePendingAgentDatabaseOpen(pendingPath);
    }
  }
  for (const retained of cache.retainedCloses) {
    if (isSameOpenClawAgentDatabasePath(retained.path, resolvedPath)) {
      retained.close();
    }
  }
  // Disposal can be followed by file deletion or recreation, so revalidate next open.
  invalidateOpenClawAgentDatabaseValidation(resolvedPath);
  const matchingDatabases = [...cache.databases.values()].filter((candidate) =>
    isSameOpenClawAgentDatabasePath(candidate.path, resolvedPath),
  );
  if (matchingDatabases.length > 1) {
    return false;
  }
  const database = matchingDatabases[0];
  if (database && cache.incognito.has(database)) {
    return closeOpenClawAgentDatabaseByPath(database.path);
  }
  if (!database) {
    return false;
  }
  try {
    unregisterOpenClawAgentDatabase({
      agentId: database.agentId,
      path: database.path,
      ...(options.env ? { env: options.env } : {}),
    });
  } finally {
    // Secret-bearing transient DBs must close even when registry maintenance
    // fails; Windows otherwise cannot remove the file during caller cleanup.
    closeOpenClawAgentDatabaseByPath(database.path);
  }
  return true;
}

/** Release fixture handles and pathname trust before a test root is recreated. */
export function closeOpenClawAgentDatabasesForTest(rootPath?: string): void {
  closeOpenClawAgentDatabases(rootPath);
  clearOpenClawAgentDatabaseValidationCache(rootPath);
  cache.terminal.clearAll(rootPath);
}
