// Shared-state transaction exclusion must cover the real outer SQLite transaction.
import type { DatabaseSync } from "node:sqlite";
import { readSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { runWithSqliteCoordinator } from "../infra/sqlite-coordinator.js";
import { withSqlitePostCommitPublications } from "../infra/sqlite-post-commit.js";
import {
  assertSyncTransactionResult,
  logSlowSqliteCoordinatorWait,
  runSqliteImmediateTransactionSync,
  type SqliteTransactionOptions,
} from "../infra/sqlite-transaction.js";
import { acquireStateDatabaseCoordinator } from "../infra/state-database-coordinator.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db-contract.js";

// Native and transformed SDK graphs may share the same transaction owner.
const coordinatedStateTransactions = resolveGlobalSingleton(
  Symbol.for("openclaw.coordinatedStateTransactions"),
  () => new WeakSet<DatabaseSync>(),
);

/** Participants join the existing outer transaction, not a nested savepoint COMMIT. */
export type OpenClawStateCommitParticipant = {
  assertWrite(): void;
  classify(): void;
  prepare(): void;
};
type StateCommitFrame = {
  participants: OpenClawStateCommitParticipant[];
  guards: NonNullable<SqliteTransactionOptions["withCommit"]>[];
  committing: boolean;
};
const commitParticipants = resolveGlobalSingleton(
  Symbol.for("openclaw.stateCommitParticipants"),
  () => new WeakMap<DatabaseSync, StateCommitFrame>(),
);

export function joinOpenClawStateCommit(
  database: DatabaseSync,
  participant: OpenClawStateCommitParticipant,
): void {
  const frame = commitParticipants.get(database);
  if (!frame || frame.committing || !database.isTransaction) {
    throw new Error("State COMMIT participant requires its coordinated outer transaction");
  }
  frame.participants.push(participant);
}

export function withSharedStateWriteCoordinator<T>(
  params: {
    databasePath: string;
    existing?: DatabaseSync;
    busyTimeoutMs?: number;
    operationLabel?: string;
  },
  operation: () => T,
): T {
  if (params.existing?.isTransaction && !coordinatedStateTransactions.has(params.existing)) {
    throw new Error(
      "Cannot join an uncoordinated shared-state transaction; enter through runOpenClawStateWriteTransaction before BEGIN.",
    );
  }
  // Cached and supplied handles join the same lifecycle gate as fresh opens.
  // Acquire before BEGIN and retain through outer commit and postcommit work.
  const started = performance.now();
  let coordinator: ReturnType<typeof acquireStateDatabaseCoordinator>;
  try {
    coordinator = acquireStateDatabaseCoordinator({
      databasePath: params.databasePath,
      busyTimeoutMs:
        params.busyTimeoutMs ??
        (params.existing
          ? readSqliteBusyTimeout(params.existing)
          : OPENCLAW_SQLITE_BUSY_TIMEOUT_MS),
    });
  } finally {
    logSlowSqliteCoordinatorWait(performance.now() - started, {
      databaseLabel: params.databasePath,
      operationLabel: params.operationLabel ?? "state.write",
    });
  }
  return runWithSqliteCoordinator(coordinator, params.operationLabel ?? "state.write", operation);
}

export function runCoordinatedStateTransaction<T>(
  database: DatabaseSync,
  operation: () => T,
  options: SqliteTransactionOptions,
): T {
  return withSqlitePostCommitPublications(database, () => {
    const outer = !database.isTransaction;
    const frame: StateCommitFrame | undefined = outer
      ? { participants: [], guards: [], committing: false }
      : commitParticipants.get(database);
    if (!frame || frame.committing) {
      throw new Error("Missing coordinated state COMMIT owner");
    }
    const { participants, guards } = frame;
    const start = participants.length;
    const guardStart = guards.length;
    if (options.withCommit) guards.push(options.withCommit);
    if (outer) {
      coordinatedStateTransactions.add(database);
      commitParticipants.set(database, frame);
    }
    try {
      return runSqliteImmediateTransactionSync(database, operation, {
        ...options,
        withCommit: outer
          ? (commit) => {
              frame.committing = true;
              // Check every W, then classify all impacts before preparing any receipt.
              for (const participant of participants) participant.assertWrite();
              for (const participant of participants) participant.classify();
              for (const participant of participants) participant.assertWrite();
              for (const participant of participants) participant.prepare();
              for (const participant of participants) participant.assertWrite();
              let committed = false;
              const enterGuard = (index: number): void => {
                const guard = guards[index];
                if (guard) {
                  let entered = false;
                  let active = true;
                  try {
                    assertSyncTransactionResult(
                      guard(() => {
                        if (!active) throw new Error("State COMMIT guard has expired");
                        if (entered) throw new Error("State COMMIT guard was reused");
                        entered = true;
                        enterGuard(index + 1);
                      }),
                    );
                    if (!entered) throw new Error("State COMMIT guard did not commit");
                  } finally {
                    active = false;
                  }
                } else {
                  if (committed) throw new Error("State COMMIT was reused");
                  for (const participant of participants) participant.assertWrite();
                  committed = true;
                  commit();
                }
              };
              enterGuard(0);
            }
          : options.withCommit,
      });
    } catch (error) {
      // Savepoint rollback abandons only its participants; selector hard epochs
      // themselves are irreversible and deliberately are not rewound here.
      participants.length = start;
      guards.length = guardStart;
      throw error;
    } finally {
      if (outer) {
        commitParticipants.delete(database);
        coordinatedStateTransactions.delete(database);
      }
    }
  });
}
