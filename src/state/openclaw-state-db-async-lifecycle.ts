import path from "node:path";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-coordinator.js";
import {
  inspectDatabasePathIdentitySync,
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import type { OpenClawAgentDatabaseReadFacts } from "./openclaw-agent-db-contract.js";

export {
  createOpenClawDatabaseMaintenanceScope,
  getOpenClawDatabaseMaintenanceScope,
  isOpenClawDatabaseMaintenanceResourceOwned,
  observeOpenClawDatabaseMaintenanceResource,
  runOutsideOpenClawDatabaseMaintenanceScope,
  type OpenClawDatabaseMaintenanceScope,
} from "./openclaw-state-db-maintenance-scope.js";

const STATE_DATABASE_READ_ADMISSION_INVALIDATED = "STATE_DATABASE_READ_ADMISSION_INVALIDATED";

export class StateDatabaseReadAdmissionInvalidatedError extends Error {
  readonly code = STATE_DATABASE_READ_ADMISSION_INVALIDATED;
}

export function isStateDatabaseReadAdmissionInvalidatedError(error: unknown): boolean {
  return extractErrorCode(error) === STATE_DATABASE_READ_ADMISSION_INVALIDATED;
}

export type OpenClawStateDatabaseReadAdmission = {
  readonly databasePath: string;
  readonly identity: DatabasePathIdentity;
  assertCurrent: () => void;
};
export type OpenClawStateDatabaseAsyncResource = {
  /** Shared execution resources close only after accepted owners settle their remaining work. */
  phase?: "after-resources";
  close: (identity?: DatabasePathIdentity) => Promise<void>;
};

/** A lexical source borrow, independent of registry memo demand or cached handles. */
export type OpenClawStateDatabaseSelectorBorrow = {
  readonly admission: OpenClawStateDatabaseReadAdmission;
  assertCurrent(): void;
  acceptSource(facts: OpenClawAgentDatabaseReadFacts, assertCurrent: () => void): void;
  release(): void;
};

/** Private mutation custody. Hard promotion is irreversible, including on rollback. */
export type OpenClawStateDatabaseSelectorIntent = {
  readonly admission: OpenClawStateDatabaseReadAdmission;
  readonly hard: boolean;
  assertCurrent(): void;
  canPreserve(borrow: OpenClawStateDatabaseSelectorBorrow): boolean;
  captureSources(agentId: string, pathname: string): readonly OpenClawStateSelectorSource[];
  promoteHard(): void;
  release(): void;
};

export type OpenClawStateSelectorSource = {
  readonly borrow: OpenClawStateDatabaseSelectorBorrow;
  readonly facts: OpenClawAgentDatabaseReadFacts;
  assertCurrent(): void;
};

type SelectorCell = {
  epoch: object;
  retired: boolean;
  borrows: number;
  intents: number;
  hard: number;
  sources: Map<OpenClawStateDatabaseSelectorBorrow, OpenClawStateSelectorSource>;
};

type IdentityRecord = {
  identity: DatabasePathIdentity;
  paths: Set<string>;
  generation: object;
  selector?: SelectorCell;
};
type ReadSeal = { record?: IdentityRecord };
type CloseAttempt = {
  seal: ReadSeal;
  retained: Set<OpenClawStateDatabaseAsyncResource>;
  pending?: Promise<boolean>;
  queue?: Set<OpenClawStateDatabaseAsyncResource>;
};

/** The cache owns physical identity and admission across drainage and file exclusion. */
export function createOpenClawStateDatabaseAsyncLifecycle() {
  const resources = new Set<OpenClawStateDatabaseAsyncResource>();
  const records = new Map<string, IdentityRecord>();
  const seals = new Set<ReadSeal>();
  const attempts = new Map<IdentityRecord | undefined, CloseAttempt>();
  let tail = Promise.resolve();
  const admittedRecords = new WeakMap<OpenClawStateDatabaseReadAdmission, IdentityRecord>();
  const borrowedSelectors = new WeakMap<
    OpenClawStateDatabaseSelectorBorrow,
    { record: IdentityRecord; cell: SelectorCell; epoch: object }
  >();
  const selector = (record: IdentityRecord): SelectorCell =>
    (record.selector ??= {
      epoch: {},
      retired: false,
      borrows: 0,
      intents: 0,
      hard: 0,
      sources: new Map(),
    });
  const retireSelector = (record: IdentityRecord) => {
    if (record.selector) {
      record.selector.retired = true;
      record.selector.sources.clear();
      record.selector.epoch = {};
      record.selector = undefined;
    }
  };
  const releaseSelector = (record: IdentityRecord, cell: SelectorCell) => {
    if (!cell.borrows && !cell.intents && record.selector === cell) {
      record.selector = undefined;
    }
  };
  const admittedRecord = (admission: OpenClawStateDatabaseReadAdmission) => {
    admission.assertCurrent();
    const record = admittedRecords.get(admission);
    if (!record || records.get(record.identity.key) !== record) {
      throw new StateDatabaseReadAdmissionInvalidatedError("Unknown state selector admission");
    }
    return record;
  };

  const known = (pathname: string) => {
    const resolvedPath = path.resolve(pathname);
    return [...records.values()].find((record) => record.paths.has(resolvedPath));
  };
  const overlaps = (left: IdentityRecord, right: IdentityRecord) =>
    left.identity.key === right.identity.key ||
    [...left.paths].some((pathname) => right.paths.has(pathname));
  const isSealed = (record: IdentityRecord) =>
    [...seals].some((held) => held.record === undefined || overlaps(held.record, record));
  const assertOpen = (record: IdentityRecord) => {
    if (isSealed(record)) {
      throw new StateDatabaseReadAdmissionInvalidatedError(
        "OpenClaw state database read admission is closed",
      );
    }
  };
  const findPhysicalRecord = (identity: DatabasePathIdentity): IdentityRecord | undefined => {
    const record = records.get(identity.key);
    if (
      !record ||
      !identity.key.startsWith("file:") ||
      record.paths.has(identity.canonicalPath) ||
      isSealed(record)
    ) {
      return record;
    }
    // A closed, deleted database can leave an inode that a new path reuses.
    // Only cold identity binding probes aliases; warmed captures stay unchanged.
    if (
      [...record.paths].some(
        (pathname) => inspectDatabasePathIdentitySync(pathname)?.key === identity.key,
      )
    ) {
      return record;
    }
    invalidate(record);
    forget(record);
    return undefined;
  };
  const resolve = (pathname: string, preparedIdentity?: DatabasePathIdentity): IdentityRecord => {
    const resolvedPath = path.resolve(pathname);
    const cached = known(resolvedPath);
    if (cached && (!preparedIdentity || cached.identity.key === preparedIdentity.key)) {
      // Resolve first creation without replacing an established file's admission.
      return !preparedIdentity && cached.identity.key.startsWith("path:")
        ? resolve(resolvedPath, readDatabasePathIdentitySync(resolvedPath))
        : cached;
    }
    const identity = preparedIdentity ?? readDatabasePathIdentitySync(resolvedPath);
    let record = findPhysicalRecord(identity);
    if (!record && identity.key.startsWith("file:")) {
      // A first creation can become visible through an alias before publication.
      // Reconcile unresolved creation facts here, never on warmed captures.
      record = [...records.values()].find((candidate) => {
        if (!candidate.identity.key.startsWith("path:")) {
          return false;
        }
        try {
          return (
            readDatabasePathIdentitySync(candidate.identity.canonicalPath).key === identity.key
          );
        } catch {
          // Creation can still be opening in a worker. Keep its custody until
          // publication or drainage without spreading unrelated lookup failures.
          return false;
        }
      });
      if (record) {
        records.delete(record.identity.key);
        record.identity = identity;
        records.set(identity.key, record);
      }
    }
    if (!record) {
      record = { identity, paths: new Set(), generation: {} };
      records.set(identity.key, record);
    }
    record.paths.add(resolvedPath).add(identity.canonicalPath);
    return record;
  };
  const resolveForNative = (pathname: string): IdentityRecord | undefined => {
    const cached = known(pathname);
    if (cached) {
      return cached;
    }
    const identity = inspectDatabasePathIdentitySync(pathname);
    return identity ? resolve(pathname, identity) : undefined;
  };
  const invalidate = (record?: IdentityRecord) => {
    for (const current of record ? [record] : records.values()) {
      current.generation = {};
      retireSelector(current);
    }
  };
  const seal = (record?: IdentityRecord): ReadSeal => {
    invalidate(record);
    const held = { record };
    seals.add(held);
    return held;
  };
  const forget = (record: IdentityRecord) => {
    if (!isSealed(record) && records.get(record.identity.key) === record) {
      retireSelector(record);
      records.delete(record.identity.key);
    }
  };

  return {
    identity(pathname: string): DatabasePathIdentity | undefined {
      return known(pathname)?.identity ?? inspectDatabasePathIdentitySync(pathname);
    },
    knownIdentity(this: void, pathname: string): DatabasePathIdentity | undefined {
      return known(pathname)?.identity;
    },
    publish(pathname: string): DatabasePathIdentity {
      const resolvedPath = path.resolve(pathname);
      const identity = readDatabasePathIdentitySync(resolvedPath);
      const previous = known(resolvedPath);
      let record = findPhysicalRecord(identity);
      if (previous && previous.identity.key !== identity.key) {
        if (previous.identity.key.startsWith("path:") && !record) {
          // First canonical creation binds the same captured admission to its file.
          records.delete(previous.identity.key);
          previous.identity = identity;
          records.set(identity.key, previous);
          record = previous;
        } else {
          invalidate(previous);
          forget(previous);
        }
      }
      if (!record) {
        record = resolve(resolvedPath, identity);
      }
      record.paths.add(resolvedPath).add(identity.canonicalPath);
      return identity;
    },
    invalidate(pathname?: string): void {
      if (pathname === undefined) {
        invalidate();
      } else {
        const record = known(pathname);
        if (record) {
          invalidate(record);
        }
      }
    },
    register(resource: OpenClawStateDatabaseAsyncResource): () => void {
      resources.add(resource);
      for (const attempt of attempts.values()) {
        attempt.queue?.add(resource);
      }
      return () => {
        resources.delete(resource);
      };
    },
    capture(this: void, pathname: string): OpenClawStateDatabaseReadAdmission {
      const databasePath = path.resolve(pathname);
      const record = resolve(databasePath);
      assertOpen(record);
      const generation = record.generation;
      const admission: OpenClawStateDatabaseReadAdmission = {
        databasePath,
        get identity() {
          return record.identity;
        },
        assertCurrent() {
          assertOpen(record);
          if (records.get(record.identity.key) !== record || record.generation !== generation) {
            throw new StateDatabaseReadAdmissionInvalidatedError(
              "OpenClaw state database read admission changed",
            );
          }
        },
      };
      admittedRecords.set(admission, record);
      return admission;
    },
    retainSelector(
      admission: OpenClawStateDatabaseReadAdmission,
    ): OpenClawStateDatabaseSelectorBorrow {
      const record = admittedRecord(admission);
      const cell = selector(record);
      const epoch = cell.epoch;
      let released = false;
      const borrow: OpenClawStateDatabaseSelectorBorrow = {
        admission,
        assertCurrent() {
          admission.assertCurrent();
          if (
            released ||
            cell.retired ||
            cell.hard ||
            cell.epoch !== epoch ||
            record.selector !== cell
          ) {
            throw new StateDatabaseReadAdmissionInvalidatedError("State source selector changed");
          }
        },
        acceptSource(facts, assertSourceCurrent) {
          borrow.assertCurrent();
          assertSourceCurrent();
          const previous = cell.sources.get(borrow);
          if (previous) {
            previous.assertCurrent();
            if (JSON.stringify(previous.facts) !== JSON.stringify(facts)) {
              throw new StateDatabaseReadAdmissionInvalidatedError(
                "Accepted state source facts changed",
              );
            }
            return;
          }
          const accepted: OpenClawStateSelectorSource = {
            borrow,
            facts: Object.freeze({ ...facts }),
            assertCurrent() {
              borrow.assertCurrent();
              assertSourceCurrent();
              if (cell.sources.get(borrow) !== accepted) {
                throw new StateDatabaseReadAdmissionInvalidatedError(
                  "State source read was superseded",
                );
              }
            },
          };
          cell.sources.set(borrow, accepted);
        },
        release() {
          if (released) {
            return;
          }
          released = true;
          cell.sources.delete(borrow);
          cell.borrows -= 1;
          borrowedSelectors.delete(borrow);
          releaseSelector(record, cell);
        },
      };
      borrow.assertCurrent();
      cell.borrows += 1;
      borrowedSelectors.set(borrow, { record, cell, epoch });
      return borrow;
    },
    beginSelectorMutation(
      admission: OpenClawStateDatabaseReadAdmission,
    ): OpenClawStateDatabaseSelectorIntent {
      const record = admittedRecord(admission);
      const cell = selector(record);
      const epoch = cell.epoch;
      let released = false;
      let hard = false;
      cell.intents += 1;
      const intent: OpenClawStateDatabaseSelectorIntent = {
        admission,
        get hard() {
          return hard;
        },
        assertCurrent() {
          admission.assertCurrent();
          if (released || cell.retired || record.selector !== cell) {
            throw new StateDatabaseReadAdmissionInvalidatedError("State selector mutation retired");
          }
        },
        canPreserve(borrow) {
          intent.assertCurrent();
          const held = borrowedSelectors.get(borrow);
          if (
            hard ||
            cell.hard ||
            cell.epoch !== epoch ||
            held?.record !== record ||
            held.cell !== cell ||
            held.epoch !== epoch
          ) {
            return false;
          }
          try {
            borrow.assertCurrent();
            return true;
          } catch {
            return false;
          }
        },
        captureSources(agentId, pathname) {
          intent.assertCurrent();
          const captured: OpenClawStateSelectorSource[] = [];
          for (const source of cell.sources.values()) {
            if (
              source.facts.agentId !== agentId ||
              source.facts.path !== pathname ||
              !intent.canPreserve(source.borrow)
            ) {
              continue;
            }
            try {
              source.assertCurrent();
              captured.push(source);
            } catch {
              // A failed read cannot lend continuity to this independent operation.
            }
          }
          return Object.freeze(captured);
        },
        promoteHard() {
          intent.assertCurrent();
          if (!hard) {
            hard = true;
            cell.epoch = {};
            cell.hard += 1;
          }
        },
        release() {
          if (released) {
            return;
          }
          released = true;
          cell.intents -= 1;
          if (hard) {
            cell.hard -= 1;
          }
          releaseSelector(record, cell);
        },
      };
      return intent;
    },
    invalidateSelectors(pathname?: string): void {
      const selected =
        pathname === undefined
          ? records.values()
          : [
              known(pathname) ??
                (() => {
                  // A new lexical alias may name an already captured physical state owner.
                  // This probes identity only; it creates no record, registry memo or database.
                  const identity = inspectDatabasePathIdentitySync(pathname);
                  return identity ? records.get(identity.key) : undefined;
                })(),
            ];
      for (const record of selected) {
        if (record?.selector) {
          record.selector.epoch = {};
        }
      }
    },
    holdExclusion(pathname: string): () => void {
      const record = resolve(pathname);
      const held = seal(record);
      return () => {
        seals.delete(held);
        // Replacement can leave a new physical record sharing this logical path.
        for (const current of records.values()) {
          if (overlaps(record, current)) {
            forget(current);
          }
        }
      };
    },
    close(
      pathname: string | undefined,
      retireNative: (identity?: DatabasePathIdentity) => boolean,
    ): Promise<boolean> {
      const record = pathname === undefined ? undefined : resolveForNative(pathname);
      if (pathname !== undefined && !record) {
        // No worker could enter a non-file target. Retire only the caller's exact
        // native path; undefined must not reach resource.close as a global drain.
        return Promise.resolve(retireNative());
      }
      let attempt = attempts.get(record);
      if (attempt?.pending) {
        return attempt.pending;
      }
      if (!attempt) {
        attempt = { seal: seal(record), retained: new Set() };
        attempts.set(record, attempt);
      }
      const current = attempt;
      const pending = tail
        .then(async () => {
          const closing = new Set([...resources, ...current.retained]);
          for (const entry of attempts.values()) {
            for (const resource of entry.retained) {
              closing.add(resource);
            }
          }
          current.queue = closing;
          const errors: unknown[] = [];
          while (current.queue.size) {
            const ordinary = [...current.queue].filter(
              (resource) => resource.phase !== "after-resources",
            );
            // Failed owners retain the transports they may need during a canonical retry.
            if (!ordinary.length && errors.length) {
              for (const resource of current.queue) {
                current.retained.add(resource);
              }
              break;
            }
            const batch = ordinary.length ? ordinary : [...current.queue];
            for (const resource of batch) {
              current.queue.delete(resource);
            }
            await Promise.all(
              batch.map(async (resource) => {
                try {
                  await resource.close(record?.identity);
                  current.retained.delete(resource);
                } catch (error) {
                  // Unregistration cannot abandon a resource whose close failed.
                  current.retained.add(resource);
                  errors.push(error);
                }
              }),
            );
          }
          if (errors.length === 1) {
            throw errors[0];
          }
          if (errors.length > 1) {
            throw createSqliteLifecycleAggregateError(
              errors,
              "OpenClaw state resource drainage failed",
              errors[0],
            );
          }
          const retired = retireNative(record?.identity);
          attempts.delete(record);
          seals.delete(current.seal);
          if (record === undefined) {
            // A successful whole-cache retry also discharges prior failed path closes.
            for (const [key, entry] of attempts) {
              if (!entry.pending) {
                attempts.delete(key);
                seals.delete(entry.seal);
              }
            }
            for (const entry of records.values()) {
              forget(entry);
            }
          } else {
            forget(record);
          }
          return retired;
        })
        .finally(() => {
          current.queue = undefined;
        });
      current.pending = pending;
      tail = pending.then(
        () => undefined,
        () => undefined,
      );
      void pending.catch(() => {
        // Keep the seal and failed resource custody, while allowing an explicit retry.
        current.pending = undefined;
      });
      return pending;
    },
  };
}
