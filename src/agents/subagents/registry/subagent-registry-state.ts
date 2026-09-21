import { expectDefined } from "@openclaw/normalization-core";
import { isVitestRuntimeEnv } from "../../../infra/env.js";
import type { DatabasePathIdentity } from "../../../infra/sqlite-worker-identity.js";
import {
  emitSessionLifecycleEvent,
  type SessionLifecycleEvent,
} from "../../../sessions/session-lifecycle-events.js";
import { isStateDatabaseReadAdmissionInvalidatedError } from "../../../state/openclaw-state-db-async-lifecycle.js";
import { openClawStateDatabaseCache } from "../../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import {
  projectSubagentRunForMaintenance,
  projectSubagentRunForSessionList,
} from "./subagent-delivery-state.js";
import {
  applySubagentRunChanges,
  getSessionListLookup,
  indexedSnapshotRows,
  loadPersistedSubagentRunsForRead,
  matchesSubagentCacheContext,
  retainUnpublishedSubagentChanges,
  selectSubagentCacheStateForRead,
  type SubagentRunChange,
  type SubagentRunsCache,
} from "./subagent-registry-cache.js";
import { getSubagentRunsForChildSession, subagentRuns } from "./subagent-registry-memory.js";
import {
  persistSubagentRegistryChangesAsync,
  supersedePendingSubagentRegistryWrites,
  type SubagentRegistryWriteOptions,
} from "./subagent-registry-persistence.js";
import { publishSubagentRunChanges } from "./subagent-registry-publication.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
/**
 * Subagent registry state persistence bridge.
 *
 * Merges live runs with retained SQLite rows under the process-local registry owner.
 */
import {
  loadSubagentRunsForChildSessionFromSqlite,
  loadSubagentRunsForControllerFromSqlite,
  loadSubagentRunsForSessionFromSqlite,
  loadSubagentRunsByRunIdsFromSqlite,
  loadSubagentRegistryFromSqlite,
  loadSubagentMaintenanceRunsFromSqlite,
  loadSubagentSessionListRunsFromSqlite,
  loadSubagentRunsForSessionsFromSqlite,
  saveSubagentRegistryChangesToSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry.store.sqlite.js";
import type { SubagentRunMaintenanceRecord, SubagentRunRecord } from "./subagent-registry.types.js";
import {
  collectSubagentSessionReadKeys,
  SubagentSessionReadLookup,
} from "./subagent-session-read-scope.js";

const persistedSubagentRunsReadCache: SubagentRunsCache<SubagentRunRecord> = {
  state: {},
  captureContext: captureOpenClawStateWorkerContext,
  load: loadSubagentRegistryFromSqlite,
  copy: structuredClone,
  project: (entry) => entry,
};
const persistedSubagentSessionListRunsReadCache: SubagentRunsCache<SubagentRunReadRecord> = {
  state: {},
  captureContext: captureOpenClawStateWorkerContext,
  load: () => loadSubagentSessionListRunsFromSqlite(),
  copy: projectSubagentRunForSessionList,
  project: projectSubagentRunForSessionList,
};
const persistedSubagentMaintenanceRunsReadCache: SubagentRunsCache<SubagentRunMaintenanceRecord> = {
  state: {},
  load: () => loadSubagentMaintenanceRunsFromSqlite(),
  copy: projectSubagentRunForMaintenance,
  project: projectSubagentRunForMaintenance,
};

// Read caches deliberately advance on failed best-effort writes. Keep notification facts
// commit-owned so a successful retry still refreshes the parent, including after archive.
const committedSwarmNotifications = new Map<
  string,
  { event: SessionLifecycleEvent; signature: string }
>();

function swarmNotification(entry: SubagentRunRecord | undefined) {
  if (
    !entry?.collect ||
    !entry.swarmRequesterSessionKey ||
    !entry.requesterAgentId ||
    !entry.groupId
  ) {
    return undefined;
  }
  return {
    event: {
      sessionKey: entry.swarmRequesterSessionKey,
      agentId: entry.requesterAgentId,
      reason: "swarm",
    },
    // Compare the summary's raw inputs, never child results, labels or error text.
    signature: JSON.stringify([
      entry.swarmRequesterSessionKey,
      entry.requesterAgentId,
      entry.groupId,
      entry.createdAt,
      entry.childSessionKey,
      entry.execution.status,
      entry.collectorCompletion?.status,
    ]),
  };
}

function updateCommittedSwarmNotifications(
  runs: Map<string, SubagentRunRecord>,
  changedRunIds?: readonly string[],
): SessionLifecycleEvent[] {
  const events = new Map<string, SessionLifecycleEvent>();
  const ids = changedRunIds ?? new Set([...committedSwarmNotifications.keys(), ...runs.keys()]);
  for (const runId of ids) {
    const previous = committedSwarmNotifications.get(runId);
    const next = swarmNotification(runs.get(runId));
    if (previous?.signature === next?.signature) {
      continue;
    }
    if (next) {
      committedSwarmNotifications.set(runId, next);
    } else {
      committedSwarmNotifications.delete(runId);
    }
    for (const notification of [previous, next]) {
      if (notification) {
        const event = notification.event;
        events.set(JSON.stringify([event.sessionKey, event.agentId]), event);
      }
    }
  }
  return [...events.values()];
}

type SubagentRegistryPersistListener = (sessionKeys?: readonly (string | undefined)[]) => void;

const SUBAGENT_REGISTRY_PERSIST_LISTENERS = new Set<SubagentRegistryPersistListener>();

function emitSubagentRegistryPersisted(keys?: Array<string | undefined>): void {
  publishSubagentRunChanges(keys);
  for (const listener of SUBAGENT_REGISTRY_PERSIST_LISTENERS) {
    try {
      listener(keys);
    } catch {
      // Persistence already succeeded; observers are best-effort.
    }
  }
}

/** Wake process-local readers after a registry mutation, even if persistence failed. */
export function onSubagentRegistryPersisted(listener: SubagentRegistryPersistListener): () => void {
  SUBAGENT_REGISTRY_PERSIST_LISTENERS.add(listener);
  return () => {
    SUBAGENT_REGISTRY_PERSIST_LISTENERS.delete(listener);
  };
}

function rememberSubagentRunsSnapshot<T extends SubagentRunReadRecord>(
  cache: SubagentRunsCache<T>,
  runs: Map<string, SubagentRunRecord>,
  changedRunIds: readonly string[] | undefined,
  committed: boolean,
): void {
  let context: OpenClawStateWorkerContext | undefined;
  let retiredPublicationIdentity: DatabasePathIdentity | undefined;
  try {
    context = cache.captureContext?.();
  } catch (error) {
    if (!isStateDatabaseReadAdmissionInvalidatedError(error)) {
      throw error;
    }
    if (cache === persistedSubagentSessionListRunsReadCache) {
      cache.state = {};
      return;
    }
    // The full registry still publishes accepted memory while its read owner drains.
    // This is provenance, not read authority; native retirement replaces the identity object.
    retiredPublicationIdentity = expectDefined(
      openClawStateDatabaseCache.getKnownOpenClawStateDatabaseIdentity(
        resolveOpenClawStateSqlitePath(),
      ),
      "retired subagent registry publication identity",
    );
  }
  const previous = retiredPublicationIdentity
    ? (cache.state.retiredPublicationIdentity ?? cache.state.context?.admission.identity) ===
      retiredPublicationIdentity
      ? cache.state
      : {}
    : !cache.state.retiredPublicationIdentity &&
        matchesSubagentCacheContext(cache.state.context, context)
      ? cache.state
      : {};
  const owner = { context, retiredPublicationIdentity };
  const snapshot = previous.snapshot;
  if (!changedRunIds) {
    cache.state = {
      snapshot: new Map([...runs].map(([runId, entry]) => [runId, cache.copy(entry)])),
      ...(!committed ? { replacementPending: true as const } : {}),
      ...owner,
    };
    return;
  }
  const changes = previous.changes ?? new Map<string, SubagentRunChange<T>>();
  if (!snapshot) {
    // Until the first full read, named writes cannot account for durable-only rows.
    for (const runId of changedRunIds) {
      const entry = runs.get(runId);
      changes.set(runId, { entry: entry ? cache.copy(entry) : undefined, committed });
    }
    cache.state = { changes, ...owner };
    return;
  }
  const lookup = previous.lookup;
  // A failed projection/update cannot leave derived membership ahead of its Map.
  previous.lookup = undefined;
  for (const runId of new Set(changedRunIds)) {
    const entry = runs.get(runId);
    if (entry) {
      snapshot.set(runId, cache.copy(entry));
    } else {
      snapshot.delete(runId);
    }
    if (!committed || previous.replacementPending) {
      // Exact commits exempt only their rows from an unsettled full replacement.
      changes.set(runId, { entry: snapshot.get(runId), committed });
    } else {
      changes.delete(runId);
    }
    lookup?.set(runId, snapshot.get(runId));
  }
  cache.state = {
    snapshot,
    ...owner,
    changes: changes.size ? changes : undefined,
    ...(previous.replacementPending ? { replacementPending: true } : {}),
    ...(lookup ? { lookup } : {}),
  };
}

function rememberPersistedSubagentRunsSnapshot(
  runs: Map<string, SubagentRunRecord>,
  changedRunIds?: readonly string[],
  committed = true,
): Array<string | undefined> | undefined {
  const previous =
    persistedSubagentSessionListRunsReadCache.state.snapshot ??
    persistedSubagentRunsReadCache.state.snapshot;
  const keys =
    previous &&
    changedRunIds?.flatMap((runId) =>
      [previous.get(runId), runs.get(runId)].flatMap((run) => [
        run?.childSessionKey,
        run?.requesterSessionKey,
        run?.controllerSessionKey,
        run?.swarmRequesterSessionKey,
      ]),
    );
  for (const cache of [
    persistedSubagentRunsReadCache,
    persistedSubagentSessionListRunsReadCache,
    persistedSubagentMaintenanceRunsReadCache,
  ]) {
    rememberSubagentRunsSnapshot(cache, runs, changedRunIds, committed);
  }
  return keys;
}

/** Publishes registry rows already committed by a cross-owner shared-state transaction. */
export function publishSubagentRunsAfterAtomicStore(
  runs: Map<string, SubagentRunRecord>,
  changedRunIds: readonly string[],
  deferredObserverEvents: Array<() => void>,
): void {
  supersedePendingSubagentRegistryWrites(changedRunIds);
  const keys = rememberPersistedSubagentRunsSnapshot(runs, changedRunIds);
  const events = updateCommittedSwarmNotifications(runs, changedRunIds);
  deferredObserverEvents.push(() => {
    emitSubagentRegistryPersisted(keys);
    events.forEach(emitSessionLifecycleEvent);
  });
}

function shouldReadPersistedSubagentRuns(): boolean {
  return !isVitestRuntimeEnv() || process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE === "1";
}

function getPersistedSubagentRunsSnapshot<T extends SubagentRunReadRecord>(
  cache: SubagentRunsCache<T>,
): Map<string, T> | null {
  let context: OpenClawStateWorkerContext | undefined;
  try {
    context = cache.captureContext?.();
  } catch (error) {
    if (
      cache === persistedSubagentSessionListRunsReadCache ||
      !isStateDatabaseReadAdmissionInvalidatedError(error)
    ) {
      throw error;
    }
    const state = selectSubagentCacheStateForRead(cache.state);
    // A sealed full-registry read can consume published facts, never refill from SQLite.
    return applySubagentRunChanges(new Map(state.snapshot), state.changes);
  }
  if (
    cache.state.retiredPublicationIdentity ||
    !matchesSubagentCacheContext(cache.state.context, context)
  ) {
    cache.state = { context };
    return null;
  }
  return cache.state.snapshot ?? null;
}

export function clearSubagentRunsReadCacheForTest(): void {
  supersedePendingSubagentRegistryWrites();
  committedSwarmNotifications.clear();
  persistedSubagentRunsReadCache.state = {};
  persistedSubagentSessionListRunsReadCache.state = {};
  persistedSubagentMaintenanceRunsReadCache.state = {};
}

function persistSubagentRuns(
  runs: Map<string, SubagentRunRecord>,
  changedRunIds: readonly string[] | undefined,
  strict: boolean,
): void {
  supersedePendingSubagentRegistryWrites(changedRunIds);
  let committed = false;
  try {
    if (changedRunIds) {
      saveSubagentRegistryChangesToSqlite(runs, changedRunIds);
    } else {
      saveSubagentRegistryToSqlite(runs);
    }
    committed = true;
  } catch (error) {
    if (strict) {
      throw error;
    }
  }
  // In-process readers must observe the authoritative memory snapshot before the wake.
  const keys = rememberPersistedSubagentRunsSnapshot(runs, changedRunIds, committed);
  const events = committed ? updateCommittedSwarmNotifications(runs, changedRunIds) : [];
  emitSubagentRegistryPersisted(keys);
  events.forEach(emitSessionLifecycleEvent);
}

export function persistSubagentRunsToDisk(
  runs: Map<string, SubagentRunRecord>,
  // Undefined replaces the complete snapshot; an array applies exact row mutations.
  changedRunIds?: readonly string[],
) {
  persistSubagentRuns(runs, changedRunIds, false);
}

export function persistSubagentRunsToDiskOrThrow(
  runs: Map<string, SubagentRunRecord>,
  // Undefined replaces the complete snapshot; an array applies exact row mutations.
  changedRunIds?: readonly string[],
) {
  persistSubagentRuns(runs, changedRunIds, true);
}

export function persistSubagentRunsToDiskAsyncOrThrow(
  runs: Map<string, SubagentRunRecord>,
  changedRunIds: readonly string[],
  options: SubagentRegistryWriteOptions,
): Promise<void> {
  return persistSubagentRegistryChangesAsync(runs, changedRunIds, options, (snapshot, runIds) => {
    options.onCommitted?.();
    const keys = rememberPersistedSubagentRunsSnapshot(snapshot, runIds);
    const events = updateCommittedSwarmNotifications(snapshot, runIds);
    emitSubagentRegistryPersisted(keys);
    events.forEach(emitSessionLifecycleEvent);
  });
}

export function restoreSubagentRunsFromDisk(params: {
  runs: Map<string, SubagentRunRecord>;
  mergeOnly?: boolean;
}) {
  const restored = loadSubagentRegistryFromSqlite();
  supersedePendingSubagentRegistryWrites();
  const keys = rememberPersistedSubagentRunsSnapshot(restored);
  let added = 0;
  for (const [runId, entry] of restored.entries()) {
    if (!runId || !entry) {
      continue;
    }
    if (params.mergeOnly && params.runs.has(runId)) {
      continue;
    }
    params.runs.set(runId, entry);
    const notification = swarmNotification(entry);
    if (notification) {
      committedSwarmNotifications.set(runId, notification);
    } else {
      committedSwarmNotifications.delete(runId);
    }
    subagentRuns.commitOwnership(entry);
    added += 1;
  }
  emitSubagentRegistryPersisted(keys);
  return added;
}

function getSubagentRunsSnapshot<T extends SubagentRunReadRecord>(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  cache: SubagentRunsCache<T>,
  scope?: {
    load?: () => Iterable<T>;
    fresh?: boolean;
    borrowPersisted?: boolean;
    matches: (entry: SubagentRunReadRecord) => boolean;
  },
): Map<string, T> {
  const merged = new Map<string, T>();
  if (shouldReadPersistedSubagentRuns()) {
    try {
      // Scoped reads use indexed SQL until a complete owner snapshot is available.
      const cached = scope?.load && !scope.fresh ? getPersistedSubagentRunsSnapshot(cache) : null;
      const persisted = scope?.load
        ? (cached?.values() ?? scope.load())
        : loadPersistedSubagentRunsForRead(cache, getPersistedSubagentRunsSnapshot(cache)).values();
      for (const entry of persisted) {
        if (!scope || scope.matches(entry)) {
          merged.set(
            entry.runId,
            scope?.load && !scope.borrowPersisted ? structuredClone(entry) : entry,
          );
        }
      }
    } catch {
      // Ignore disk read failures and fall back to local memory.
    }
  }
  return overlaySubagentRunsSnapshot(merged, inMemoryRuns, cache, scope);
}

function overlaySubagentRunsSnapshot<T extends SubagentRunReadRecord>(
  merged: Map<string, T>,
  inMemoryRuns: Map<string, SubagentRunRecord>,
  cache: SubagentRunsCache<T>,
  scope?: {
    load?: () => Iterable<T>;
    borrowPersisted?: boolean;
    matches: (entry: SubagentRunReadRecord) => boolean;
  },
  preparedContext?: OpenClawStateWorkerContext,
): Map<string, T> {
  const state = selectSubagentCacheStateForRead(cache.state, preparedContext);
  if (shouldReadPersistedSubagentRuns()) {
    if (preparedContext && state.replacementPending) {
      // Only a failed full publication gives its intended snapshot replacement authority.
      // Named commits release their IDs back to fresh SQL while other intent remains pending.
      for (const runId of merged.keys()) {
        if (!state.changes?.get(runId)?.committed) {
          merged.delete(runId);
        }
      }
      for (const [runId, entry] of state.snapshot) {
        if (!state.changes?.get(runId)?.committed && (!scope || scope.matches(entry))) {
          merged.set(runId, structuredClone(entry));
        }
      }
    }
    for (const [runId, { entry, committed }] of state.changes ?? []) {
      if (preparedContext && committed) {
        continue;
      }
      if (entry && (!scope || scope.matches(entry))) {
        merged.set(
          runId,
          preparedContext || (scope?.load && !scope.borrowPersisted)
            ? structuredClone(entry)
            : entry,
        );
      } else {
        merged.delete(runId);
      }
    }
  }
  for (const [runId, entry] of inMemoryRuns) {
    if (!scope || scope.matches(entry)) {
      merged.set(runId, cache.project(entry));
    } else {
      // Live memory wins even when a run moved out of the persisted scope.
      merged.delete(runId);
    }
  }
  return merged;
}

export function getSubagentRunsSnapshotForRead(
  inMemoryRuns: Map<string, SubagentRunRecord>,
): Map<string, SubagentRunRecord> {
  return getSubagentRunsSnapshot(inMemoryRuns, persistedSubagentRunsReadCache);
}

/** All generations of exact children, sharing the existing snapshot and its publication-owned lookup. */
export function getSubagentRunsSnapshotForChildSessions(
  childSessionKeys: readonly string[],
): Map<string, SubagentRunRecord> {
  const keys = new Set(childSessionKeys.map((key) => key.trim()).filter(Boolean));
  const selected = new Map<string, SubagentRunRecord>();
  if (keys.size === 0) {
    return selected;
  }
  if (shouldReadPersistedSubagentRuns()) {
    try {
      const cache = persistedSubagentRunsReadCache;
      const snapshot = loadPersistedSubagentRunsForRead(
        cache,
        getPersistedSubagentRunsSnapshot(cache),
      );
      const lookup = getSessionListLookup(cache, snapshot);
      for (const runId of lookup.selectChildren(keys)) {
        // A live row can have moved out of a persisted child bucket.
        const persisted = snapshot.get(runId);
        const entry = persisted && (subagentRuns.get(persisted.runId) ?? persisted);
        if (entry && keys.has(entry.childSessionKey.trim())) {
          selected.set(entry.runId, entry);
        }
      }
    } catch {
      // Match the readable registry's best-effort durable fallback.
    }
  }
  if (shouldReadPersistedSubagentRuns()) {
    const state = selectSubagentCacheStateForRead(persistedSubagentRunsReadCache.state);
    for (const [runId, { entry: persisted }] of state.changes ?? []) {
      const entry = subagentRuns.get(runId) ?? persisted;
      if (entry && keys.has(entry.childSessionKey.trim())) {
        selected.set(runId, entry);
      } else {
        selected.delete(runId);
      }
    }
  }
  for (const key of keys) {
    for (const entry of getSubagentRunsForChildSession(key)) {
      selected.set(entry.runId, entry);
    }
  }
  return selected;
}

export function getSubagentMaintenanceRunsSnapshotForRead(
  inMemoryRuns: Map<string, SubagentRunRecord>,
): Map<string, SubagentRunMaintenanceRecord> {
  return getSubagentRunsSnapshot(inMemoryRuns, persistedSubagentMaintenanceRunsReadCache);
}

export function getSubagentRunsSnapshotForRunIds(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  runIds: readonly string[],
): Map<string, SubagentRunRecord> {
  const requested = new Set(runIds.map((runId) => runId.trim()));
  if (requested.size === 0) {
    return new Map();
  }
  const matches = (entry: SubagentRunReadRecord) =>
    requested.has(entry.runId) || Boolean(entry.swarmRunId && requested.has(entry.swarmRunId));
  return getSubagentRunsSnapshot(inMemoryRuns, persistedSubagentRunsReadCache, {
    load: () => {
      const readSelected = () => {
        const projection = loadPersistedSubagentRunsForRead(
          persistedSubagentSessionListRunsReadCache,
          getPersistedSubagentRunsSnapshot(persistedSubagentSessionListRunsReadCache),
        );
        const physicalRunIds = [...projection.values()].filter(matches).map((entry) => entry.runId);
        return { physicalRunIds, entries: loadSubagentRunsByRunIdsFromSqlite(physicalRunIds) };
      };
      let selected = readSelected();
      if (
        selected.entries.length !== selected.physicalRunIds.length ||
        selected.entries.some((entry) => !matches(entry))
      ) {
        // Another process may replace a physical row while preserving its stable collector id.
        persistedSubagentSessionListRunsReadCache.state = {};
        selected = readSelected();
      }
      return selected.entries;
    },
    matches,
  });
}

export function getSubagentSessionListRunsSnapshotForRead(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  controllerSessionKeys?: readonly string[],
): Map<string, SubagentRunReadRecord> {
  if (controllerSessionKeys) {
    const keys = new Set(controllerSessionKeys.map((key) => key.trim()).filter(Boolean));
    if (keys.size === 0) {
      return new Map();
    }
    const cache = persistedSubagentSessionListRunsReadCache;
    return getSubagentRunsSnapshot(inMemoryRuns, cache, {
      fresh: true,
      load: () => {
        const cached = getPersistedSubagentRunsSnapshot(cache);
        const lookup = cached ? getSessionListLookup(cache, cached) : undefined;
        return cached && lookup
          ? indexedSnapshotRows(cached, lookup.selectControllers(keys))
          : loadSubagentSessionListRunsFromSqlite([...keys]).values();
      },
      matches: (entry) => keys.has(entry.controllerSessionKey?.trim() || entry.requesterSessionKey),
    });
  }
  return getSubagentRunsSnapshot(inMemoryRuns, persistedSubagentSessionListRunsReadCache);
}

function getSubagentSessionTreeSnapshot<T extends SubagentRunReadRecord>(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  sessionKeys: readonly string[],
  cache: SubagentRunsCache<T>,
  load: () => { sessionKeys: Set<string>; runs: Map<string, T>; complete: boolean },
): Map<string, T> {
  if (!sessionKeys.some((key) => key.trim())) {
    return new Map();
  }
  const cached = shouldReadPersistedSubagentRuns() ? getPersistedSubagentRunsSnapshot(cache) : null;
  const lookup = cached ? getSessionListLookup(cache, cached) : undefined;
  const indexed = lookup?.selectSessions(sessionKeys, inMemoryRuns.values());
  let selected =
    indexed?.sessionKeys ??
    collectSubagentSessionReadKeys(sessionKeys, cached?.values() ?? [], inMemoryRuns.values());
  return getSubagentRunsSnapshot(inMemoryRuns, cache, {
    // The loader owns cache selection so topology and metadata use the same source.
    fresh: true,
    // Descendant queries only inspect records, matching their unscoped snapshots.
    borrowPersisted: true,
    load: () => {
      if (cached) {
        return indexed ? indexedSnapshotRows(cached, indexed.cacheKeys) : cached.values();
      }
      const snapshot = load();
      // A tree covering every physical row may populate the existing full cache.
      if (snapshot.complete) {
        applySubagentRunChanges(snapshot.runs, cache.state.changes);
        const loadedLookup =
          cache === persistedSubagentSessionListRunsReadCache
            ? new SubagentSessionReadLookup(snapshot.runs)
            : undefined;
        const loadedIndex = loadedLookup?.selectSessions(sessionKeys, inMemoryRuns.values());
        snapshot.sessionKeys =
          loadedIndex?.sessionKeys ??
          collectSubagentSessionReadKeys(
            sessionKeys,
            snapshot.runs.values(),
            inMemoryRuns.values(),
          );
        cache.state = {
          snapshot: snapshot.runs,
          changes: retainUnpublishedSubagentChanges(cache.state.changes),
          context: cache.captureContext?.(),
          ...(loadedLookup ? { lookup: loadedLookup } : {}),
        };
        if (loadedIndex) {
          selected = snapshot.sessionKeys;
          return indexedSnapshotRows(snapshot.runs, loadedIndex.cacheKeys);
        }
      }
      selected = snapshot.sessionKeys;
      return snapshot.runs.values();
    },
    matches: (entry) => selected.has(entry.childSessionKey.trim()),
  });
}

/** Exact rows share the owner snapshot while projecting only their complete requester trees. */
export function getSubagentSessionListRunsSnapshotForSessions(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  sessionKeys: readonly string[],
): Map<string, SubagentRunReadRecord> {
  return getSubagentSessionTreeSnapshot(
    inMemoryRuns,
    sessionKeys,
    persistedSubagentSessionListRunsReadCache,
    () => loadSubagentRunsForSessionsFromSqlite(sessionKeys, inMemoryRuns.values(), "session-list"),
  );
}

/** Settlement reads retain the canonical codec and raw local reservation ownership. */
export function getSubagentRunsSnapshotForSessions(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  sessionKeys: readonly string[],
): Map<string, SubagentRunRecord> {
  return getSubagentSessionTreeSnapshot(
    inMemoryRuns,
    sessionKeys,
    persistedSubagentRunsReadCache,
    () => loadSubagentRunsForSessionsFromSqlite(sessionKeys, inMemoryRuns.values(), "full"),
  );
}

export function getSubagentRunsSnapshotForController(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  controllerSessionKey: string,
): Map<string, SubagentRunRecord> {
  const key = controllerSessionKey.trim();
  if (!key) {
    return new Map();
  }
  return getSubagentRunsSnapshot(inMemoryRuns, persistedSubagentRunsReadCache, {
    load: () => loadSubagentRunsForControllerFromSqlite(key),
    matches: (entry) => (entry.controllerSessionKey?.trim() || entry.requesterSessionKey) === key,
  });
}

/** Current-turn results use the owner snapshot or hydrate only their scoped payloads. */
export function getSubagentRunsSnapshotForSession(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  sessionKey: string,
  storePath?: string,
): Map<string, SubagentRunRecord> {
  const key = sessionKey.trim();
  if (!key) {
    return new Map();
  }
  const ownsStore = (ownerPath: string | undefined) =>
    storePath === undefined || ownerPath === storePath;
  return getSubagentRunsSnapshot(inMemoryRuns, persistedSubagentRunsReadCache, {
    load: () => loadSubagentRunsForSessionFromSqlite(key),
    matches: (entry) =>
      (entry.controllerSessionKey?.trim() === key && ownsStore(entry.controllerStorePath)) ||
      (entry.requesterSessionKey.trim() === key && ownsStore(entry.requesterStorePath)),
  });
}

export function getSubagentRunsSnapshotForChildSession(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  childSessionKey: string,
): Map<string, SubagentRunRecord> {
  const key = childSessionKey.trim();
  if (!key) {
    return new Map();
  }
  return getSubagentRunsSnapshot(inMemoryRuns, persistedSubagentRunsReadCache, {
    load: () => loadSubagentRunsForChildSessionFromSqlite(key),
    matches: (entry) => entry.childSessionKey === key,
  });
}

/** Merge freshly read durable rows with this database's unpublished owner state and live runs. */
export function getPreparedSubagentRunsSnapshotForChildSession(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  childSessionKey: string,
  persisted: readonly SubagentRunRecord[],
  context: OpenClawStateWorkerContext,
): Map<string, SubagentRunRecord> {
  return overlaySubagentRunsSnapshot(
    new Map(persisted.map((entry) => [entry.runId, structuredClone(entry)])),
    inMemoryRuns,
    persistedSubagentRunsReadCache,
    { matches: (entry) => entry.childSessionKey === childSessionKey },
    context,
  );
}
