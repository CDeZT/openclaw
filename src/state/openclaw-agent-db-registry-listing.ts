import { AsyncLocalStorage } from "node:async_hooks";
import { lstatSync, statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveStateDir } from "../config/state-dir.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { stageSqliteTransactionState } from "../infra/sqlite-post-commit.js";
import { withStateDatabaseCoordinatorRuntimeDirectory } from "../infra/state-database-coordinator.js";
import { sessionChanges, type SessionRowChange } from "../sessions/session-row-changes.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  type OpenClawAgentDatabaseRegistryReadResult,
  type OpenClawAgentDatabaseRegistrationCommit,
  type OpenClawAgentDatabaseRegistrationFacts,
  type OpenClawRegisteredAgentDatabase,
} from "./openclaw-agent-db-contract.js";
import { readRegisteredAgentDatabaseRows } from "./openclaw-agent-db-registry.read.js";
import {
  isStateDatabaseReadAdmissionInvalidatedError,
  type OpenClawStateDatabaseReadAdmission,
  type OpenClawStateDatabaseSelectorBorrow,
  type OpenClawStateSelectorSource,
} from "./openclaw-state-db-async-lifecycle.js";
import {
  beginOpenClawStateDatabaseSelectorMutation,
  captureOpenClawStateDatabaseReadAdmission,
  invalidateOpenClawStateDatabaseSelectors,
} from "./openclaw-state-db-cache.js";
import type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseOptions,
} from "./openclaw-state-db-contract.js";
import {
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync,
  withExistingOpenClawStateDatabaseReadOnly,
  executeExistingOpenClawStateRead,
} from "./openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
// Registry metadata is process-stable: registry writes invalidate after each commit;
// other-process changes take effect on restart. Polling here puts schema probes back on hot reads.
type AgentDatabaseRegistryMemo = {
  pathname: string;
  token: symbol;
  entries?: readonly OpenClawRegisteredAgentDatabase[];
};
// A plugin may first open a hot-created agent; its registration must invalidate
// native discovery even when subsequent callers reuse the shared connection.
const registry = resolveGlobalSingleton<{ memo?: AgentDatabaseRegistryMemo }>(
  Symbol.for("openclaw.agentDatabaseRegistryMemo"),
  () => ({}),
);

function resolveAgentDatabaseRegistryPath(options: OpenClawStateDatabaseOptions): string {
  return path.resolve(options.path ?? resolveOpenClawStateSqlitePath(options.env ?? process.env));
}

function activateRegisteredAgentDatabasesMemo(
  options: OpenClawStateDatabaseOptions,
): AgentDatabaseRegistryMemo {
  const pathname = resolveAgentDatabaseRegistryPath(options);
  if (registry.memo?.pathname !== pathname) {
    // One active pathname keeps registry metadata process-stable without retaining
    // an unbounded generation map. Switching back creates a fresh generation.
    registry.memo = { pathname, token: Symbol(pathname) };
  }
  return registry.memo;
}

/** Return the process-stable generation for the active agent database registry. */
export function readOpenClawAgentDatabaseRegistryToken(
  options: OpenClawStateDatabaseOptions = {},
): symbol {
  return activateRegisteredAgentDatabasesMemo(options).token;
}

export function invalidateRegisteredAgentDatabasesMemo(
  options: OpenClawStateDatabaseOptions,
): void {
  invalidateOpenClawStateDatabaseSelectors(resolveAgentDatabaseRegistryPath(options));
  invalidateRegisteredAgentDatabaseMetadata(options);
}

/** Full-row freshness always changes, even when the selector owner certifies continuity. */
export function invalidateRegisteredAgentDatabaseMetadata(
  options: OpenClawStateDatabaseOptions,
): void {
  const pathname = resolveAgentDatabaseRegistryPath(options);
  if (registry.memo?.pathname === pathname) {
    registry.memo = { pathname, token: Symbol(pathname) };
  }
}

const registrationEvents = resolveGlobalSingleton(
  Symbol.for("openclaw.agentRegistrationEvents"),
  () => new WeakMap<SessionRowChange, readonly OpenClawStateSelectorSource[]>(),
);

/** The event object is private provenance; a lookalike stores broadcast is never certified. */
export function preservesOpenClawAgentRegistrationRead(
  event: SessionRowChange,
  borrow: OpenClawStateDatabaseSelectorBorrow,
): boolean {
  const source = registrationEvents.get(event)?.find((candidate) => candidate.borrow === borrow);
  if (!source) return false;
  source.assertCurrent();
  return true;
}

export type OpenClawAgentRegistrationTransactionOwner = {
  assertWrite(): void;
  beforeMutation(): void;
  classify(facts: OpenClawAgentDatabaseRegistrationFacts): void;
  prepareEvent(event: SessionRowChange): void;
  withCommit(commit: () => void): void;
  retainTransaction(): { commit(): void; rollback(): void };
  prepareReceipt?(
    database: DatabaseSync,
    receipt: OpenClawAgentDatabaseRegistrationCommit,
    facts: OpenClawAgentDatabaseRegistrationFacts,
  ): void;
};

/** Catalog mutations fence new and held borrows until the actual outer transaction settles. */
export function stageOpenClawAgentRegistryMutation(
  database: Pick<OpenClawStateDatabase, "db" | "path">,
): void {
  const intent = beginOpenClawStateDatabaseSelectorMutation(
    captureOpenClawStateDatabaseReadAdmission(database.path),
  );
  try {
    if (
      !stageSqliteTransactionState(database.db, {
        stage: () => intent.promoteHard(),
        rollback: () => intent.release(),
        commit: () => intent.release(),
      })
    ) {
      throw new Error("Agent registry mutation requires its outer transaction settlement owner");
    }
  } catch (error) {
    intent.release();
    throw error;
  }
}

/** One bounded pin on the lifecycle record, independent of full metadata cache freshness. */
export function captureOpenClawAgentDatabaseRegistration(params: {
  agentId: string;
  agentPath: string;
  admission: OpenClawStateDatabaseReadAdmission;
  assertWrite?: () => void;
  publish?: boolean;
}) {
  const options = { path: params.admission.databasePath };
  const intent = beginOpenClawStateDatabaseSelectorMutation(params.admission);
  let sources: readonly OpenClawStateSelectorSource[] = [];
  let qualifiedSources: readonly OpenClawStateSelectorSource[] = [];
  let active = false;
  let committed = false;
  let classified = false;
  let finished = false;
  let pending = 0;
  let released = false;
  const release = () => {
    if (finished && pending === 0 && !released) {
      released = true;
      intent.release();
    }
  };
  const assertWrite = () => {
    params.admission.assertCurrent();
    params.assertWrite?.();
    intent.assertCurrent();
  };
  const liveSources = (candidates: readonly OpenClawStateSelectorSource[]) =>
    candidates.filter((source) => {
      if (!intent.canPreserve(source.borrow)) return false;
      try {
        source.assertCurrent();
        return true;
      } catch {
        return false;
      }
    });
  const canPreserve = () => liveSources(classified ? qualifiedSources : sources).length > 0;
  const associateEvent = (event: SessionRowChange) => {
    if (!classified) return;
    const current = liveSources(qualifiedSources);
    if (current.length > 0) registrationEvents.set(event, Object.freeze(current));
  };
  const beforeMutation = () => {
    assertWrite();
    classified = false;
    qualifiedSources = [];
    intent.promoteHard();
    // Promotion can revoke a dependency of W, so it cannot substitute for W.
    assertWrite();
  };
  const classify = (facts: OpenClawAgentDatabaseRegistrationFacts) => {
    assertWrite();
    const old = facts.before;
    const next = facts.after;
    const observed = facts.source;
    if (
      !old ||
      !observed ||
      old.agentId !== params.agentId ||
      next.agentId !== old.agentId ||
      old.path !== params.agentPath ||
      next.path !== old.path ||
      old.schemaVersion !== next.schemaVersion ||
      next.schemaVersion !== OPENCLAW_AGENT_SCHEMA_VERSION ||
      observed.userVersion !== next.schemaVersion ||
      observed.schemaVersion !== next.schemaVersion ||
      observed.role !== "agent" ||
      observed.schemaAgentId !== params.agentId
    ) {
      beforeMutation();
      return;
    }
    // Capture was fixed at begin; each already-held consumer independently
    // proves its own live provenance instead of borrowing the first reader's life.
    qualifiedSources = liveSources(sources).filter(
      ({ facts: held }) =>
        observed.agentId === held.agentId &&
        observed.path === held.path &&
        observed.physicalIdentity === held.physicalIdentity &&
        observed.birthtime === held.birthtime &&
        observed.userVersion === held.userVersion &&
        observed.schemaVersion === held.schemaVersion &&
        observed.role === held.role &&
        observed.schemaAgentId === held.schemaAgentId,
    );
    if (qualifiedSources.length === 0) beforeMutation();
    else classified = true;
  };
  return {
    assertWrite,
    beforeMutation,
    classify,
    abandonPreservation() {
      classified = false;
      qualifiedSources = [];
      try {
        intent.promoteHard();
      } catch (error) {
        if (!isStateDatabaseReadAdmissionInvalidatedError(error)) throw error;
      }
    },
    begin() {
      if (finished) throw new Error("Agent database registration admission is closed");
      assertWrite();
      if (!active) {
        active = true;
        sources = intent.captureSources(params.agentId, params.agentPath);
        invalidateRegisteredAgentDatabaseMetadata(options);
        if (sources.length === 0) beforeMutation();
      }
    },
    prepareEvent(event: SessionRowChange) {
      // All transaction participants have classified before this is invoked.
      associateEvent(event);
    },
    withCommit(commit: () => void) {
      assertWrite();
      if (!canPreserve() && !intent.hard) beforeMutation();
      assertWrite();
      commit();
    },
    retainTransaction() {
      assertWrite();
      pending++;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        pending--;
        // Only prepared owner bookkeeping occurs at COMMIT/rollback.
        invalidateRegisteredAgentDatabaseMetadata(options);
        release();
      };
      return { commit: settle, rollback: settle };
    },
    recordCommitted(receipt: OpenClawAgentDatabaseRegistrationCommit) {
      // Fact binding precedes current-authority checks. Retirement cannot erase COMMIT.
      if (
        finished ||
        !active ||
        receipt.agentId !== params.agentId ||
        receipt.agentPath !== params.agentPath ||
        receipt.stateDatabasePath !== params.admission.databasePath ||
        receipt.stateDatabaseIdentity !== params.admission.identity.key
      ) {
        throw new Error("Agent registration commit differs from its captured owner");
      }
      committed = true;
    },
    finish() {
      if (finished) return;
      try {
        try {
          params.admission.assertCurrent();
        } catch (error) {
          if (isStateDatabaseReadAdmissionInvalidatedError(error)) return;
          throw error;
        }
        if (active) invalidateRegisteredAgentDatabaseMetadata(options);
        if (committed && params.publish !== false) {
          if ((!classified || !canPreserve()) && !intent.hard) intent.promoteHard();
          const event: SessionRowChange = { all: true, scope: "stores" };
          associateEvent(event);
          sessionChanges.emit(event);
        }
      } finally {
        finished = true;
        release();
      }
    },
  };
}

function cloneRegisteredAgentDatabases(
  entries: readonly OpenClawRegisteredAgentDatabase[],
): OpenClawRegisteredAgentDatabase[] {
  return entries.map((entry) => ({ ...entry }));
}

function hasUnavailableMissingSqlitePath(pathname: string): boolean {
  for (const candidate of resolveSqliteDatabaseFilePaths(pathname)) {
    try {
      lstatSync(candidate);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return true;
      }
    }
  }

  let ancestor = path.dirname(pathname);
  while (true) {
    try {
      const stat = lstatSync(ancestor);
      if (!stat.isSymbolicLink()) {
        return !stat.isDirectory();
      }
      try {
        return !statSync(ancestor).isDirectory();
      } catch {
        return true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return true;
      }
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      return false;
    }
    ancestor = parent;
  }
}

type AgentDatabaseRegistryListOptions = OpenClawStateDatabaseOptions & {
  includeIncompatibleSchemaVersions?: boolean;
};

export function readRegisteredAgentDatabases(
  options: AgentDatabaseRegistryListOptions,
  artifactPreserving: false,
): OpenClawRegisteredAgentDatabase[];
export function readRegisteredAgentDatabases(
  options: AgentDatabaseRegistryListOptions,
  artifactPreserving: true,
): Promise<OpenClawRegisteredAgentDatabase[]>;
export function readRegisteredAgentDatabases(
  options: AgentDatabaseRegistryListOptions,
  artifactPreserving: boolean,
): OpenClawRegisteredAgentDatabase[] | Promise<OpenClawRegisteredAgentDatabase[]> {
  const pathname = resolveAgentDatabaseRegistryPath(options);
  const read = ({ db }: { db: DatabaseSync }) =>
    readRegisteredAgentDatabaseRows(db, pathname, artifactPreserving);
  const finish = (entries: OpenClawRegisteredAgentDatabase[] | undefined) => {
    if (entries === undefined) {
      if (hasUnavailableMissingSqlitePath(pathname)) {
        throw new Error(`OpenClaw state database ${pathname} is unavailable.`);
      }
      return [];
    }
    return options.includeIncompatibleSchemaVersions
      ? entries
      : entries.filter((entry) => entry.schemaVersion === OPENCLAW_AGENT_SCHEMA_VERSION);
  };
  return artifactPreserving
    ? withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync(read, options).then(finish)
    : finish(withExistingOpenClawStateDatabaseReadOnly(read, options));
}

/** Inspect a copied registry without creating SQLite artifacts or runtime memo state. */
export async function inspectOpenClawRegisteredAgentDatabases(
  options: AgentDatabaseRegistryListOptions = {},
): Promise<OpenClawRegisteredAgentDatabase[]> {
  return readRegisteredAgentDatabases(options, true);
}

/** List agent databases recorded in the shared OpenClaw state registry. */
export function listOpenClawRegisteredAgentDatabases(
  options: AgentDatabaseRegistryListOptions = {},
): OpenClawRegisteredAgentDatabase[] {
  const memo = activateRegisteredAgentDatabasesMemo(options);
  if (memo.entries) {
    const entries = cloneRegisteredAgentDatabases(memo.entries);
    return options.includeIncompatibleSchemaVersions
      ? entries
      : entries.filter((entry) => entry.schemaVersion === OPENCLAW_AGENT_SCHEMA_VERSION);
  }
  // Discovery runs per row in list hot paths, so the legacy-schema gate and the
  // query share one process-held state handle instead of opening two connections.
  const entries = readRegisteredAgentDatabases(
    { ...options, includeIncompatibleSchemaVersions: true },
    false,
  );
  memo.entries = entries;
  const cloned = cloneRegisteredAgentDatabases(entries);
  return options.includeIncompatibleSchemaVersions
    ? cloned
    : cloned.filter((entry) => entry.schemaVersion === OPENCLAW_AGENT_SCHEMA_VERSION);
}

/** Capture authority now, but activate the canonical memo only if discovery needs it. */
export function prepareOpenClawAgentDatabaseRegistrySnapshotRead(
  inputOptions: AgentDatabaseRegistryListOptions = {},
  owner?: { context: OpenClawStateWorkerContext; selector: OpenClawStateDatabaseSelectorBorrow },
): {
  read(): Promise<{ result: OpenClawAgentDatabaseRegistryReadResult; assertCurrent: () => void }>;
} {
  try {
    const env = cloneEnvWithPlatformSemantics(inputOptions.env ?? process.env);
    env.OPENCLAW_STATE_DIR = resolveStateDir(env);
    const options = {
      ...inputOptions,
      env,
      path: resolveAgentDatabaseRegistryPath({ ...inputOptions, env }),
    };
    const context = owner?.context ?? captureOpenClawStateWorkerContext(options);
    if (
      owner &&
      (owner.selector.admission !== context.admission ||
        context.admission.databasePath !== options.path)
    ) {
      throw new Error("Registry snapshot differs from its captured selector owner");
    }
    const inCapturedScope = AsyncLocalStorage.snapshot();
    return {
      async read() {
        context.admission.assertCurrent();
        owner?.selector.assertCurrent();
        const memo = activateRegisteredAgentDatabasesMemo(options);
        const assertFresh = () => {
          context.admission.assertCurrent();
          owner?.selector.assertCurrent();
          if (registry.memo !== memo) {
            throw new Error("Agent database registry changed during discovery; retry the read.");
          }
        };
        const assertCurrent = owner
          ? () => {
              context.admission.assertCurrent();
              owner.selector.assertCurrent();
            }
          : assertFresh;
        assertCurrent();
        if (!memo.entries) {
          const reply = await inCapturedScope(() =>
            withStateDatabaseCoordinatorRuntimeDirectory(context.coordinatorRuntime, () =>
              executeExistingOpenClawStateRead(options, { type: "agentDatabaseRegistry.read" }),
            ),
          );
          if (reply && (!reply.ok || reply.type !== "agentDatabaseRegistry.read")) {
            throw new Error("Unexpected agent database registry read result");
          }
          const result = reply?.result;
          assertFresh();
          if (
            result?.status === "unavailable" ||
            (result === undefined && hasUnavailableMissingSqlitePath(options.path))
          ) {
            return { result: { status: "unavailable" }, assertCurrent };
          }
          memo.entries ??= result?.entries ?? [];
        }
        const entries = cloneRegisteredAgentDatabases(memo.entries);
        assertCurrent();
        return {
          result: {
            status: "available",
            entries: options.includeIncompatibleSchemaVersions
              ? entries
              : entries.filter((entry) => entry.schemaVersion === OPENCLAW_AGENT_SCHEMA_VERSION),
          },
          assertCurrent,
        };
      },
    };
  } catch (error) {
    return {
      async read() {
        throw error;
      },
    };
  }
}
