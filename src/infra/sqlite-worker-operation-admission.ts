import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { serialize } from "node:v8";
import {
  MessageChannel,
  receiveMessageOnPort,
  type MessagePort,
  type Transferable,
} from "node:worker_threads";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  deferSqlitePostCommitPublication,
  stageSqliteTransactionState,
} from "./sqlite-post-commit.js";
import { SQLITE_WORKER_MAX_MESSAGE_BYTES, SqliteWorkerError } from "./sqlite-worker-contract.js";
import type {
  RetainedWorkerTransactionAdmission,
  SqliteWorkerNativeCommit,
  SqliteWorkerNativeSettlement,
  SqliteWorkerNativeSettlementOwner,
} from "./sqlite-worker-operation-settlement.js";

const REQUESTED = 0;
const GRANTED = 1;
const REFUSED = 2;

/** Only the factory's admission before agent open may certify this refusal. */
export const SqliteWorkerOpenRefusedError = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteWorkerOpenRefusedError"),
  () =>
    class OpenRefusedError extends Error {
      constructor(readonly originalError: unknown) {
        super("SQLite worker admission was refused before agent open", { cause: originalError });
        this.name = "SqliteWorkerOpenRefusedError";
      }
    },
);

export type SqliteWorkerAdmissionRequest = {
  stage: "open" | "prepare" | "transaction" | "commit";
  facts: unknown;
};

export type SqliteWorkerOperationAdmission = SqliteWorkerNativeSettlementOwner & {
  readonly port: MessagePort;
  readonly failure: unknown;
  readonly cleanupFailures: readonly unknown[];
  wasGranted?(request: SqliteWorkerAdmissionRequest): boolean;
  service(): void;
  finish(): void;
};

export type SqliteWorkerAdmissionFactory = (operation: RetainedWorkerTransactionAdmission) => {
  admission: SqliteWorkerOperationAdmission;
  nativeLocations: readonly string[];
};

/** The caller retains real source custody before invoking the synchronous grant. */
export function createSqliteWorkerOperationAdmission(
  admit: (request: SqliteWorkerAdmissionRequest, grant: () => boolean) => void,
): SqliteWorkerOperationAdmission {
  const { port1, port2 } = new MessageChannel();
  const inOwnerContext = AsyncLocalStorage.snapshot();
  const decisions = new Set<Int32Array>();
  const grants = new WeakSet<SqliteWorkerAdmissionRequest>();
  const cleanupFailures: unknown[] = [];
  let closed = false;
  let failure: unknown;
  let committed: SqliteWorkerNativeSettlementOwner["committed"];
  let settlement: SqliteWorkerNativeSettlement | undefined;
  const waiting = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const refuse = (decision: Int32Array, error: unknown) => {
    if (Atomics.compareExchange(decision, 0, REQUESTED, REFUSED) === REQUESTED) {
      failure ??= error;
      Atomics.notify(decision, 0);
    } else if (Atomics.load(decision, 0) === GRANTED) {
      cleanupFailures.push(error);
    }
  };
  const retainCommitted = (next: SqliteWorkerNativeCommit) => {
    const previousEffects = committed?.effects ?? [];
    const nextEffects = next.effects ?? [];
    const preservesPrefix =
      nextEffects.length >= previousEffects.length &&
      previousEffects.every((effect, index) => isDeepStrictEqual(effect, nextEffects[index]));
    if (!preservesPrefix) {
      failure ??= new SqliteWorkerError(
        "SQLite worker committed effects regressed",
        "outcome-unknown",
      );
      // A broken cumulative snapshot cannot erase facts already received on this
      // operation's private port. Primary-result replacement remains separate.
      committed = {
        facts: next.facts,
        ...(committed?.effects ? { effects: committed.effects } : {}),
      };
      return;
    }
    // Repeated cumulative publications are idempotent, including structured clones.
    committed = next;
  };
  const receive = (message: unknown) => {
    if (isRecord(message) && message.kind === "native-commit") {
      if (
        !isRecord(message.committed) ||
        (message.committed.effects !== undefined && !Array.isArray(message.committed.effects)) ||
        settlement
      ) {
        failure ??= new SqliteWorkerError(
          "SQLite worker commit receipt is invalid",
          "outcome-unknown",
        );
        return;
      }
      retainCommitted({
        facts: message.committed.facts,
        ...(Array.isArray(message.committed.effects) ? { effects: message.committed.effects } : {}),
      });
      return;
    }
    if (isRecord(message) && message.kind === "native-settlement") {
      const value = message.settlement;
      if (
        !isRecord(value) ||
        (value.kind !== "completed" && value.kind !== "unknown") ||
        (value.committed !== undefined &&
          (!isRecord(value.committed) ||
            (value.committed.effects !== undefined && !Array.isArray(value.committed.effects)))) ||
        settlement
      ) {
        failure ??= new SqliteWorkerError(
          "SQLite worker native settlement is invalid",
          "outcome-unknown",
        );
        return;
      }
      if (isRecord(value.committed)) {
        retainCommitted({
          facts: value.committed.facts,
          ...(Array.isArray(value.committed.effects) ? { effects: value.committed.effects } : {}),
        });
      }
      settlement = {
        kind: value.kind,
        ...(committed ? { committed } : {}),
      };
      return;
    }
    if (
      !isRecord(message) ||
      !(message.decision instanceof SharedArrayBuffer) ||
      message.decision.byteLength !== Int32Array.BYTES_PER_ELEMENT ||
      (message.stage !== "open" &&
        message.stage !== "prepare" &&
        message.stage !== "transaction" &&
        message.stage !== "commit")
    ) {
      failure ??= new SqliteWorkerError(
        "SQLite worker admission request is invalid",
        "unavailable",
      );
      return;
    }
    const decision = new Int32Array(message.decision);
    decisions.add(decision);
    if (closed) {
      refuse(decision, new SqliteWorkerError("SQLite worker admission is closed", "closed"));
      return;
    }
    const request: SqliteWorkerAdmissionRequest = { stage: message.stage, facts: message.facts };
    const grant = () => {
      if (closed) {
        return false;
      }
      const granted = Atomics.compareExchange(decision, 0, REQUESTED, GRANTED) === REQUESTED;
      if (granted) {
        grants.add(request);
        Atomics.notify(decision, 0);
      }
      return granted;
    };
    try {
      inOwnerContext(admit, request, grant);
    } catch (error) {
      refuse(decision, error);
      return;
    } finally {
      // Repeated preparation requests must not retain every settled decision.
      decisions.delete(decision);
    }
    if (Atomics.load(decision, 0) === REQUESTED) {
      refuse(decision, new SqliteWorkerError("SQLite worker admission was not granted", "closed"));
    }
  };
  port1.on("message", receive);
  port1.unref();
  const service = () => {
    for (let queued = receiveMessageOnPort(port1); queued; queued = receiveMessageOnPort(port1)) {
      receive(queued.message);
    }
  };
  return {
    port: port2,
    wasGranted: (request) => grants.has(request),
    get failure() {
      return failure;
    },
    get cleanupFailures() {
      return cleanupFailures;
    },
    get committed() {
      // finish drains queued facts before closing the original port.
      if (!closed) service();
      return committed;
    },
    get settlement() {
      return settlement;
    },
    waitForSettlement(deadlineMs) {
      while (true) {
        service();
        if (failure !== undefined) {
          throw toErrorObject(failure, "SQLite worker admission failed");
        }
        if (settlement?.kind === "completed") {
          return settlement;
        }
        const remaining = deadlineMs - performance.now();
        if (settlement?.kind === "unknown" || closed || remaining <= 0) {
          throw new SqliteWorkerError(
            "SQLite worker native settlement is unknown",
            "outcome-unknown",
          );
        }
        Atomics.wait(waiting, 0, 0, Math.min(5, remaining));
      }
    },
    service,
    finish() {
      if (closed) return;
      closed = true;
      // Receipts remain observable; late requests can no longer obtain authority.
      service();
      for (const decision of decisions) {
        if (Atomics.load(decision, 0) === REQUESTED) {
          refuse(decision, new SqliteWorkerError("SQLite worker admission is closed", "closed"));
        }
      }
      port1.close();
      port2.close();
    },
  };
}

export type SqliteWorkerOperationContext = {
  port: MessagePort;
  committed?: SqliteWorkerNativeCommit;
  settled?: true;
};

type WorkerAdmissionScope = {
  // Published SDK request helpers share these port/active carrier fields.
  port: MessagePort;
  owner: SqliteWorkerOperationContext;
  active: boolean;
  prepared?: SqliteWorkerNativeCommit;
};
// Source brokers and built plugin backends can load separate module copies in
// one Worker. Share the carrier, while each operation still owns its private port.
const currentAdmission = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteWorkerOperationAdmission"),
  () => new AsyncLocalStorage<WorkerAdmissionScope>(),
);

/** Install only the private port belonging to the broker's currently executing operation. */
export function withSqliteWorkerOperationAdmission<T>(
  owner: SqliteWorkerOperationContext,
  operation: () => T,
): T {
  const scope: WorkerAdmissionScope = { owner, port: owner.port, active: true };
  try {
    return currentAdmission.run(scope, operation);
  } finally {
    scope.active = false;
  }
}

/** Prepare serialization before COMMIT; record the native fact before fallible transport. */
function prepareSqliteWorkerCommit(
  database: DatabaseSync,
  update: (previous: SqliteWorkerNativeCommit | undefined) => SqliteWorkerNativeCommit,
): void {
  const scope = currentAdmission.getStore();
  if (!scope?.active) {
    throw new SqliteWorkerError("SQLite receipt requires its retained admission", "unavailable");
  }
  const previous = scope.prepared;
  const next = update(previous ?? scope.owner.committed);
  if (serialize(next).byteLength > SQLITE_WORKER_MAX_MESSAGE_BYTES) {
    throw new SqliteWorkerError(
      "SQLite worker commit receipt exceeds the transport limit",
      "overloaded",
    );
  }
  const captured = structuredClone(next);
  if (
    !stageSqliteTransactionState(database, {
      stage() {
        scope.prepared = captured;
      },
      rollback() {
        scope.prepared = previous;
      },
      nativeCommit() {
        scope.owner.committed = captured;
      },
      commit() {},
    }) ||
    !deferSqlitePostCommitPublication(database, () => {
      scope.owner.port.postMessage({ kind: "native-commit", committed: scope.owner.committed }, []);
    })
  ) {
    throw new Error("SQLite worker receipt requires a transaction publication owner");
  }
}

/** Preserve other operation facts when a later owner records its primary result. */
export function deferSqliteWorkerCommitReceipt(database: DatabaseSync, facts: unknown): void {
  prepareSqliteWorkerCommit(database, (previous) => ({
    facts,
    ...(previous?.effects ? { effects: previous.effects } : {}),
  }));
}

/** Add an independently bound fact without replacing the operation's existing result facts. */
export function deferSqliteWorkerCommitEffect(database: DatabaseSync, effect: unknown): void {
  prepareSqliteWorkerCommit(database, (previous) => ({
    facts: previous?.facts,
    effects: [...(previous?.effects ?? []), effect],
  }));
}

/** The executing worker calls this only after its backend's native settlement check. */
export function settleSqliteWorkerOperationContext(
  owner: SqliteWorkerOperationContext,
  kind: "completed" | "unknown",
): void {
  if (owner.settled) {
    return;
  }
  owner.settled = true;
  owner.port.postMessage(
    {
      kind: "native-settlement",
      settlement: { kind, ...(owner.committed ? { committed: owner.committed } : {}) },
    },
    [],
  );
}

/** Called on the SQLite worker, after transaction entry and before its row mutation. */
export function requestSqliteWorkerOperationAdmission(
  request: SqliteWorkerAdmissionRequest,
  transferList: Transferable[] = [],
): void {
  const scope = currentAdmission.getStore();
  if (!scope?.active) {
    throw new SqliteWorkerError("SQLite operation requires its retained admission", "unavailable");
  }
  const decision = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  scope.port.postMessage({ ...request, decision: decision.buffer }, transferList);
  // Host scheduling delay does not revoke the retained owner's authority. The
  // broker keeps this port through settlement and joins worker exit on failure;
  // only the live host owner can grant or refuse the pending request.
  while (Atomics.load(decision, 0) === REQUESTED) {
    Atomics.wait(decision, 0, REQUESTED);
  }
  if (Atomics.load(decision, 0) !== GRANTED) {
    throw new SqliteWorkerError("SQLite transaction admission was refused", "closed");
  }
}
