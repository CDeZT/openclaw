import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runCoordinatedStateTransaction } from "../state/openclaw-state-db-write-coordination.js";
import {
  deferSqlitePostCommitPublication,
  withSqlitePostCommitPublications,
} from "./sqlite-post-commit.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import {
  createSqliteWorkerOperationAdmission,
  deferSqliteWorkerCommitEffect,
  deferSqliteWorkerCommitReceipt,
  settleSqliteWorkerOperationContext,
  withSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationContext,
} from "./sqlite-worker-operation-admission.js";

let database: DatabaseSync;
let admission: ReturnType<typeof createSqliteWorkerOperationAdmission>;
let worker: SqliteWorkerOperationContext;
beforeEach(() => {
  database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE changes (value INTEGER NOT NULL)");
  admission = createSqliteWorkerOperationAdmission((_request, grant) => {
    if (!grant()) throw new Error("Fixture admission expired");
  });
  worker = { port: admission.port };
});
afterEach(() => {
  admission.finish();
  database.close();
});
const effect = {
  kind: "agent-registration",
  binding: { intentId: "original-operation" },
  receipt: { owner: "original-state" },
};
const rows = () => database.prepare("SELECT value FROM changes ORDER BY value").all();

it("carries committed registration alongside existing operation facts on native settlement", () => {
  withSqliteWorkerOperationAdmission(worker, () => {
    runCoordinatedStateTransaction(
      database,
      () => {
        database.exec("INSERT INTO changes VALUES (1)");
        deferSqliteWorkerCommitReceipt(database, { kind: "existing-owner", count: 1 });
        deferSqliteWorkerCommitEffect(database, effect);
        expect(worker.committed).toBeUndefined();
      },
      {},
    );
  });
  settleSqliteWorkerOperationContext(worker, "completed");
  expect(admission.committed).toEqual({
    facts: { kind: "existing-owner", count: 1 },
    effects: [effect],
  });
  expect(admission.settlement).toEqual({ kind: "completed", committed: worker.committed });
  expect(rows()).toEqual([{ value: 1 }]);
  admission.finish();
  expect(admission.committed).toEqual(worker.committed);
});

it("retains known COMMIT despite an earlier observer failure and unknown settlement", () => {
  const laterFailure = new Error("validation publication failed after native COMMIT");
  expect(() =>
    withSqliteWorkerOperationAdmission(worker, () => {
      runCoordinatedStateTransaction(
        database,
        () => {
          database.exec("INSERT INTO changes VALUES (1)");
          expect(
            deferSqlitePostCommitPublication(database, () => {
              throw laterFailure;
            }),
          ).toBe(true);
          deferSqliteWorkerCommitEffect(database, effect);
        },
        {},
      );
    }),
  ).toThrow(laterFailure);
  expect(worker.committed).toEqual({ facts: undefined, effects: [effect] });
  expect(rows()).toEqual([{ value: 1 }]);
  settleSqliteWorkerOperationContext(worker, "unknown");
  expect(admission.committed).toEqual(worker.committed);
  expect(admission.settlement).toEqual({ kind: "unknown", committed: worker.committed });
});

it("records actual COMMIT before a guard's later failure and still publishes all owner events", () => {
  const laterFailure = new Error("guard unwind failed");
  const publications: string[] = [];
  expect(() =>
    withSqliteWorkerOperationAdmission(worker, () => {
      runCoordinatedStateTransaction(
        database,
        () => {
          database.exec("INSERT INTO changes VALUES (1)");
          deferSqliteWorkerCommitEffect(database, effect);
          deferSqlitePostCommitPublication(database, () => {
            publications.push("stores");
          });
        },
        {
          withCommit(commit) {
            commit();
            expect(worker.committed).toEqual({ facts: undefined, effects: [effect] });
            throw laterFailure;
          },
        },
      );
    }),
  ).toThrow(laterFailure);
  expect(database.isOpen).toBe(true);
  expect(database.isTransaction).toBe(false);
  expect(rows()).toEqual([{ value: 1 }]);
  expect(publications).toEqual(["stores"]);
  settleSqliteWorkerOperationContext(worker, "unknown");
  expect(admission.committed).toEqual(worker.committed);
});

it("drops a rolled-back savepoint effect while retaining the same operation's other committed facts", () => {
  const rejected = new Error("nested rollback");
  withSqliteWorkerOperationAdmission(worker, () => {
    runCoordinatedStateTransaction(
      database,
      () => {
        deferSqliteWorkerCommitReceipt(database, { kind: "existing-owner" });
        expect(() =>
          runCoordinatedStateTransaction(
            database,
            () => {
              database.exec("INSERT INTO changes VALUES (1)");
              deferSqliteWorkerCommitEffect(database, effect);
              throw rejected;
            },
            {},
          ),
        ).toThrow(rejected);
        database.exec("INSERT INTO changes VALUES (2)");
      },
      {},
    );
  });
  expect(worker.committed).toEqual({ facts: { kind: "existing-owner" } });
  expect(rows()).toEqual([{ value: 2 }]);
});

it("serializes facts before COMMIT so an untransferable fact rolls back without a receipt", () => {
  expect(() =>
    withSqliteWorkerOperationAdmission(worker, () => {
      runCoordinatedStateTransaction(
        database,
        () => {
          database.exec("INSERT INTO changes VALUES (1)");
          deferSqliteWorkerCommitEffect(database, { invalid: () => undefined });
        },
        {},
      );
    }),
  ).toThrow();
  expect(worker.committed).toBeUndefined();
  expect(admission.committed).toBeUndefined();
  expect(rows()).toEqual([]);
});

it("keeps prior factual effects when a later transaction updates primary facts", () => {
  withSqliteWorkerOperationAdmission(worker, () => {
    runCoordinatedStateTransaction(
      database,
      () => {
        deferSqliteWorkerCommitEffect(database, effect);
      },
      {},
    );
    runCoordinatedStateTransaction(
      database,
      () => {
        deferSqliteWorkerCommitReceipt(database, { kind: "later-owner", count: 2 });
      },
      {},
    );
  });
  expect(worker.committed).toEqual({ facts: { kind: "later-owner", count: 2 }, effects: [effect] });
});

it("retains only a committed prefix when a later transaction in the publication scope rolls back", () => {
  const rejected = new Error("second transaction rolled back");
  expect(() =>
    withSqliteWorkerOperationAdmission(worker, () => {
      withSqlitePostCommitPublications(database, () => {
        runSqliteImmediateTransactionSync(database, () => {
          database.exec("INSERT INTO changes VALUES (1)");
          deferSqliteWorkerCommitEffect(database, effect);
        });
        runSqliteImmediateTransactionSync(database, () => {
          database.exec("INSERT INTO changes VALUES (2)");
          deferSqliteWorkerCommitEffect(database, { kind: "must-not-publish" });
          throw rejected;
        });
      });
    }),
  ).toThrow(rejected);
  expect(rows()).toEqual([{ value: 1 }]);
  expect(worker.committed).toEqual({ facts: undefined, effects: [effect] });
  expect(admission.committed).toEqual(worker.committed);
});

it.each([
  { message: "commit", regression: "missing" },
  { message: "commit", regression: "empty" },
  { message: "commit", regression: "changed" },
  { message: "unknown settlement", regression: "missing" },
  { message: "unknown settlement", regression: "empty" },
  { message: "unknown settlement", regression: "changed" },
] as const)(
  "retains received effects when a later $message has a $regression cumulative prefix",
  ({ message, regression }) => {
    worker.port.postMessage({
      kind: "native-commit",
      committed: { facts: { count: 1 }, effects: [effect] },
    });
    expect(admission.committed).toEqual({ facts: { count: 1 }, effects: [effect] });
    const next = {
      facts: { count: 2 },
      ...(regression === "missing"
        ? {}
        : { effects: regression === "empty" ? [] : [{ ...effect, receipt: { owner: "other" } }] }),
    };
    worker.port.postMessage(
      message === "commit"
        ? { kind: "native-commit", committed: next }
        : { kind: "native-settlement", settlement: { kind: "unknown", committed: next } },
    );
    expect(admission.committed).toEqual({ facts: { count: 2 }, effects: [effect] });
    expect(admission.failure).toBeInstanceOf(Error);
    expect(admission.failure).toHaveProperty(
      "message",
      "SQLite worker committed effects regressed",
    );
    if (message === "unknown settlement") {
      expect(admission.settlement).toEqual({
        kind: "unknown",
        committed: { facts: { count: 2 }, effects: [effect] },
      });
    }
  },
);

it("accepts identical cloned cumulative snapshots and later primary facts without duplicating effects", () => {
  const other = { kind: "another-owner", committed: "independent-fact" };
  for (const snapshot of [
    { facts: { count: 1 }, effects: [effect] },
    { facts: { count: 1 }, effects: [structuredClone(effect)] },
    { facts: { count: 2 }, effects: [structuredClone(effect), other] },
    { facts: { count: 3 }, effects: [structuredClone(effect), structuredClone(other)] },
  ]) {
    worker.port.postMessage({ kind: "native-commit", committed: snapshot });
    expect(admission.committed).toEqual(snapshot);
    expect(admission.failure).toBeUndefined();
  }
  expect(admission.committed?.effects).toEqual([effect, other]);
});
