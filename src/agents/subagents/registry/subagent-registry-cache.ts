import { expectDefined } from "@openclaw/normalization-core";
import type { DatabasePathIdentity } from "../../../infra/sqlite-worker-identity.js";
import { openClawStateDatabaseCache } from "../../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { SubagentSessionReadLookup } from "./subagent-session-read-scope.js";

export type SubagentRunChange<T> = { entry: T | undefined; committed: boolean };
type SubagentRunsCacheState<T extends SubagentRunReadRecord> = (
  | { snapshot: Map<string, T>; lookup?: SubagentSessionReadLookup; replacementPending?: true }
  | { snapshot?: undefined; lookup?: never; replacementPending?: never }
) & {
  changes?: Map<string, SubagentRunChange<T>>;
  context?: OpenClawStateWorkerContext;
  retiredPublicationIdentity?: DatabasePathIdentity;
};

export type SubagentRunsCache<T extends SubagentRunReadRecord> = {
  state: SubagentRunsCacheState<T>;
  captureContext?: () => OpenClawStateWorkerContext;
  load: () => Map<string, T>;
  copy: (entry: SubagentRunRecord) => T;
  project: (entry: SubagentRunRecord) => T;
};

export function applySubagentRunChanges<T extends SubagentRunReadRecord>(
  runs: Map<string, T>,
  changes: Map<string, SubagentRunChange<T>> | undefined,
): Map<string, T> {
  for (const [runId, { entry }] of changes ?? []) {
    if (entry) {
      runs.set(runId, entry);
    } else {
      runs.delete(runId);
    }
  }
  return runs;
}

export function retainUnpublishedSubagentChanges<T>(
  changes: Map<string, SubagentRunChange<T>> | undefined,
): Map<string, SubagentRunChange<T>> | undefined {
  for (const [runId, change] of changes ?? []) {
    if (change.committed) {
      changes?.delete(runId);
    }
  }
  return changes?.size ? changes : undefined;
}

export function loadPersistedSubagentRunsForRead<T extends SubagentRunReadRecord>(
  cache: SubagentRunsCache<T>,
  cached: Map<string, T> | null,
): Map<string, T> {
  if (cached) {
    return cached;
  }
  const runs = applySubagentRunChanges(cache.load(), cache.state.changes);
  cache.state = {
    snapshot: runs,
    changes: retainUnpublishedSubagentChanges(cache.state.changes),
    context: cache.captureContext?.(),
  };
  return runs;
}

export function getSessionListLookup<T extends SubagentRunReadRecord>(
  cache: SubagentRunsCache<T>,
  snapshot: Map<string, T>,
): SubagentSessionReadLookup {
  const state = cache.state;
  if (!state.snapshot || state.snapshot !== snapshot) {
    // Retired reads derive a fenced snapshot without replacing the current owner's cache.
    return new SubagentSessionReadLookup(snapshot);
  }
  return (state.lookup ??= new SubagentSessionReadLookup(state.snapshot));
}

export function indexedSnapshotRows<T>(snapshot: Map<string, T>, keys: readonly string[]): T[] {
  return keys.map((key) => expectDefined(snapshot.get(key), "indexed subagent cache entry"));
}

export function matchesSubagentCacheContext(
  previous: OpenClawStateWorkerContext | undefined,
  current: OpenClawStateWorkerContext | undefined,
): boolean {
  if (!previous) {
    return true;
  }
  if (
    !current ||
    previous.admission.identity.key !== current.admission.identity.key ||
    previous.maintenanceScope !== current.maintenanceScope
  ) {
    return false;
  }
  try {
    previous.admission.assertCurrent();
    return true;
  } catch {
    return false;
  }
}

/** Read selection cannot consume or clear another database owner's publication. */
export function selectSubagentCacheStateForRead<T extends SubagentRunReadRecord>(
  state: SubagentRunsCacheState<T>,
  preparedContext?: OpenClawStateWorkerContext,
): SubagentRunsCacheState<T> {
  const stateIdentity = state.retiredPublicationIdentity ?? state.context?.admission.identity;
  const matchesOwner = preparedContext
    ? !state.retiredPublicationIdentity &&
      matchesSubagentCacheContext(state.context, preparedContext)
    : !stateIdentity ||
      stateIdentity ===
        openClawStateDatabaseCache.getKnownOpenClawStateDatabaseIdentity(
          resolveOpenClawStateSqlitePath(),
        );
  return matchesOwner ? state : {};
}
