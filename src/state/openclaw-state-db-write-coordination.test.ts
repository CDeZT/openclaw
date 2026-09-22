import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stageSqliteTransactionState } from "../infra/sqlite-post-commit.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import {
  joinOpenClawStateCommit,
  runCoordinatedStateTransaction,
} from "./openclaw-state-db-write-coordination.js";

describe("shared-state actual outer COMMIT participants", () => {
  let database: DatabaseSync;
  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec("CREATE TABLE committed_values (value INTEGER NOT NULL)");
  });
  afterEach(() => database.close());
  const rows = () => database.prepare("SELECT value FROM committed_values").all();

  it("runs nested guards once around the real outer COMMIT, never at savepoint release", () => {
    const order: string[] = [];
    runCoordinatedStateTransaction(
      database,
      () => {
        runCoordinatedStateTransaction(
          database,
          () => {
            database.exec("INSERT INTO committed_values VALUES (1)");
            joinOpenClawStateCommit(database, {
              assertWrite() {
                expect(database.isTransaction).toBe(true);
              },
              classify() {
                order.push("classify");
              },
              prepare() {
                order.push("prepare");
              },
            });
          },
          {
            withCommit(commit) {
              order.push("nested-before");
              commit();
              expect(database.isTransaction).toBe(false);
              order.push("nested-after");
            },
          },
        );
        expect(order).toEqual([]);
      },
      {
        withCommit(commit) {
          order.push("outer-before");
          commit();
          expect(database.isTransaction).toBe(false);
          order.push("outer-after");
        },
      },
    );
    expect(order).toEqual([
      "classify",
      "prepare",
      "outer-before",
      "nested-before",
      "nested-after",
      "outer-after",
    ]);
    expect(rows()).toEqual([{ value: 1 }]);
  });

  it("drops rolled-back nested participants and guards without dropping surviving outer work", () => {
    const failure = new Error("savepoint rejected");
    let abandonedCalls = 0;
    runCoordinatedStateTransaction(
      database,
      () => {
        try {
          runCoordinatedStateTransaction(
            database,
            () => {
              database.exec("INSERT INTO committed_values VALUES (1)");
              joinOpenClawStateCommit(database, {
                assertWrite() {
                  abandonedCalls++;
                },
                classify() {
                  abandonedCalls++;
                },
                prepare() {
                  abandonedCalls++;
                },
              });
              throw failure;
            },
            {
              withCommit(commit) {
                abandonedCalls++;
                commit();
              },
            },
          );
        } catch (error) {
          expect(error).toBe(failure);
        }
        database.exec("INSERT INTO committed_values VALUES (2)");
      },
      {},
    );
    expect(abandonedCalls).toBe(0);
    expect(rows()).toEqual([{ value: 2 }]);
  });

  it("rechecks real W after classification and rolls back rather than publishing a receipt", () => {
    const failure = new Error("original writer revoked");
    let writable = true;
    let prepared = false;
    let committed = false;
    expect(() =>
      runCoordinatedStateTransaction(
        database,
        () => {
          database.exec("INSERT INTO committed_values VALUES (1)");
          stageSqliteTransactionState(database, {
            stage() {},
            rollback() {},
            commit() {
              committed = true;
            },
          });
          joinOpenClawStateCommit(database, {
            assertWrite() {
              if (!writable) throw failure;
            },
            classify() {
              writable = false;
            },
            prepare() {
              prepared = true;
            },
          });
        },
        {},
      ),
    ).toThrow(failure);
    expect(prepared).toBe(false);
    expect(committed).toBe(false);
    expect(rows()).toEqual([]);
  });

  it("classifies all hard impacts before preparing any participant's committed state", () => {
    let hard = false;
    let preparedHard: boolean | undefined;
    runCoordinatedStateTransaction(
      database,
      () => {
        joinOpenClawStateCommit(database, {
          assertWrite() {},
          classify() {},
          prepare() {
            preparedHard = hard;
          },
        });
        runCoordinatedStateTransaction(
          database,
          () => {
            joinOpenClawStateCommit(database, {
              assertWrite() {},
              classify() {
                hard = true;
              },
              prepare() {},
            });
          },
          {},
        );
      },
      {},
    );
    expect(preparedHard).toBe(true);
  });

  it("publishes prepared nonthrowing state only after actual COMMIT", () => {
    let prepared = false;
    let committed = false;
    runCoordinatedStateTransaction(
      database,
      () => {
        database.exec("INSERT INTO committed_values VALUES (1)");
        joinOpenClawStateCommit(database, {
          assertWrite() {},
          classify() {},
          prepare() {
            prepared = true;
          },
        });
        stageSqliteTransactionState(database, {
          stage() {},
          rollback() {},
          commit() {
            committed = prepared && !database.isTransaction;
          },
        });
        expect(committed).toBe(false);
      },
      {},
    );
    expect(committed).toBe(true);
    expect(rows()).toEqual([{ value: 1 }]);
  });

  it("refuses late participant admission after the actual commit boundary begins", () => {
    expect(() =>
      runCoordinatedStateTransaction(
        database,
        () => {
          database.exec("INSERT INTO committed_values VALUES (1)");
          joinOpenClawStateCommit(database, {
            assertWrite() {},
            classify() {},
            prepare() {
              joinOpenClawStateCommit(database, {
                assertWrite() {},
                classify() {},
                prepare() {},
              });
            },
          });
        },
        {},
      ),
    ).toThrow("coordinated outer transaction");
    expect(rows()).toEqual([]);
  });

  it.each([
    { placement: "outer", result: "promise" },
    { placement: "outer", result: "thenable" },
    { placement: "nested", result: "promise" },
    { placement: "nested", result: "thenable" },
  ] as const)(
    "rejects a $result from a composed $placement guard without erasing its COMMIT",
    ({ placement, result }) => {
      let published = false;
      const guard = (commit: () => void) => {
        commit();
        return result === "promise" ? Promise.resolve() : { then: () => undefined };
      };
      const write = () => {
        database.exec("INSERT INTO committed_values VALUES (1)");
        stageSqliteTransactionState(database, {
          stage() {},
          rollback() {},
          commit() {
            published = true;
          },
        });
      };
      expect(() =>
        runCoordinatedStateTransaction(
          database,
          placement === "outer"
            ? write
            : () => runCoordinatedStateTransaction(database, write, { withCommit: guard }),
          placement === "outer" ? { withCommit: guard } : {},
        ),
      ).toThrow("must be synchronous");
      expect(rows()).toEqual([{ value: 1 }]);
      expect(published).toBe(true);
      expect(database.isTransaction).toBe(false);
    },
  );

  it.each(["outer", "nested"] as const)(
    "expires an unused %s commit capability before another transaction starts",
    (placement) => {
      let lateCommit: (() => void) | undefined;
      const guard = (commit: () => void) => {
        lateCommit = commit;
      };
      const write = () => {
        database.exec("INSERT INTO committed_values VALUES (1)");
      };
      expect(() =>
        runCoordinatedStateTransaction(
          database,
          placement === "outer"
            ? write
            : () => runCoordinatedStateTransaction(database, write, { withCommit: guard }),
          placement === "outer" ? { withCommit: guard } : {},
        ),
      ).toThrow("did not commit");
      expect(rows()).toEqual([]);
      const escaped = lateCommit;
      if (!escaped) throw new Error("Expected the guard's original commit capability");
      runCoordinatedStateTransaction(
        database,
        () => {
          database.exec("INSERT INTO committed_values VALUES (2)");
          expect(escaped).toThrow("has expired");
          expect(database.isTransaction).toBe(true);
        },
        {},
      );
      expect(rows()).toEqual([{ value: 2 }]);
    },
  );

  it("expires the primitive's commit capability after a refused guard", () => {
    let lateCommit: (() => void) | undefined;
    expect(() =>
      runSqliteImmediateTransactionSync(
        database,
        () => {
          database.exec("INSERT INTO committed_values VALUES (1)");
        },
        {
          withCommit(commit) {
            lateCommit = commit;
          },
        },
      ),
    ).toThrow("did not commit");
    const escaped = lateCommit;
    if (!escaped) throw new Error("Expected the primitive's original commit capability");
    runSqliteImmediateTransactionSync(database, () => {
      database.exec("INSERT INTO committed_values VALUES (2)");
      expect(escaped).toThrow("has expired");
      expect(database.isTransaction).toBe(true);
    });
    expect(rows()).toEqual([{ value: 2 }]);
  });

  it("rejects a repeated composed commit while preserving the first durable result", () => {
    expect(() =>
      runCoordinatedStateTransaction(
        database,
        () => {
          database.exec("INSERT INTO committed_values VALUES (1)");
        },
        {
          withCommit(commit) {
            commit();
            commit();
          },
        },
      ),
    ).toThrow("was reused");
    expect(rows()).toEqual([{ value: 1 }]);
    expect(database.isTransaction).toBe(false);
  });
});
