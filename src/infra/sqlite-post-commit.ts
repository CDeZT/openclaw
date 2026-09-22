import type { DatabaseSync } from "node:sqlite";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

// One connection can cross native and transformed SDK module graphs mid-transaction.
const pendingPublications = resolveGlobalSingleton(
  Symbol.for("openclaw.sqlitePostCommitPublications"),
  () => new WeakMap<DatabaseSync, Array<() => void>>(),
);
const pendingTransactionState = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteTransactionState"),
  () =>
    new WeakMap<
      DatabaseSync,
      Array<{ commit: () => void; rollback: (error: unknown) => void; nativeCommit?: () => void }>
    >(),
);

const committedTransactions = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteCommittedTransactionPublications"),
  () => new WeakMap<DatabaseSync, { publications: number; states: number }>(),
);

/** The transaction primitive calls this immediately after successful native COMMIT. */
export function recordSqliteTransactionCommitted(db: DatabaseSync): void {
  const states = pendingTransactionState.get(db);
  if (!states) return;
  const previous = committedTransactions.get(db);
  committedTransactions.set(db, {
    publications: pendingPublications.get(db)?.length ?? 0,
    states: states.length,
  });
  const errors: unknown[] = [];
  // Only prepared factual recorders run here. Existing state/cache publication
  // remains after guard unwind and scope removal, before observers as before.
  for (const state of states.slice(previous?.states ?? 0)) {
    try {
      state.nativeCommit?.();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "Committed SQLite bookkeeping failed");
}

/** Snapshots read within this managed transaction can still roll back. */
export function hasSqlitePostCommitScope(db: DatabaseSync): boolean {
  return pendingPublications.has(db);
}

/** Publications are non-throwing observers, never part of a durable transaction's result. */
export function deferSqlitePostCommitPublication(db: DatabaseSync, publish: () => void): boolean {
  const pending = pendingPublications.get(db);
  if (!pending) {
    return false;
  }
  pending.push(publish);
  return true;
}

/**
 * Stage private transaction-local state that publishes before fallible observers.
 * Stage, rollback, and commit callbacks must not throw.
 */
export function stageSqliteTransactionState(
  db: DatabaseSync,
  state: {
    stage: () => void;
    rollback: (error: unknown) => void;
    commit: () => void;
    /** Assignment-only recorder at actual native COMMIT; never an authority check. */
    nativeCommit?: () => void;
  },
): boolean {
  const pending = pendingTransactionState.get(db);
  if (!pending) {
    return false;
  }
  state.stage();
  pending.push({
    commit: state.commit,
    rollback: state.rollback,
    nativeCommit: state.nativeCommit,
  });
  return true;
}

/** A lost transaction invalidates every savepoint's staged state and observers. */
export function discardSqliteTransactionState(db: DatabaseSync, error: unknown): void {
  const committed = committedTransactions.get(db);
  pendingPublications.get(db)?.splice(committed?.publications ?? 0);
  const rolledBackState = pendingTransactionState.get(db)?.splice(committed?.states ?? 0) ?? [];
  if (!committed) {
    pendingPublications.delete(db);
    pendingTransactionState.delete(db);
  }
  for (const state of rolledBackState.toReversed()) {
    state.rollback(error);
  }
}

/** Nested rollback restores staged state and discards observers; savepoints wait for outer commit. */
export function withSqlitePostCommitPublications<T>(db: DatabaseSync, transaction: () => T): T {
  const nested = db.isTransaction;
  const publications = nested ? pendingPublications.get(db) : [];
  const transactionState = nested ? pendingTransactionState.get(db) : [];
  const publicationStart = publications?.length ?? 0;
  const stateStart = transactionState?.length ?? 0;
  if (!nested && publications && transactionState) {
    pendingPublications.set(db, publications);
    pendingTransactionState.set(db, transactionState);
  }
  let outcome: { value: T } | { error: unknown };
  try {
    outcome = { value: transaction() };
  } catch (error) {
    const committed = nested ? undefined : committedTransactions.get(db);
    publications?.splice(committed?.publications ?? publicationStart);
    const rolledBackState = transactionState?.splice(committed?.states ?? stateStart) ?? [];
    for (const state of rolledBackState.toReversed()) state.rollback(error);
    if (!committed) throw error;
    // Keep only the actually committed prefix if a later transaction/guard fails.
    outcome = { error };
  } finally {
    if (!nested) {
      pendingPublications.delete(db);
      pendingTransactionState.delete(db);
      committedTransactions.delete(db);
    }
  }
  if (!nested) {
    const failures = "error" in outcome ? [outcome.error] : [];
    for (const state of transactionState ?? []) {
      try {
        state.commit();
      } catch (error) {
        failures.push(error);
      }
    }
    for (const publish of publications ?? []) {
      try {
        publish();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length)
      throw new AggregateError(failures, "SQLite committed publication failed", {
        cause: failures[0],
      });
  }
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}
