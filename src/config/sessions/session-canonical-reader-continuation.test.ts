import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  disposeNodeSqliteDependents,
  registerNodeSqliteDisposeCallback,
} from "../../infra/kysely-sync-cache-state.js";
import { deferSqlitePostCommitPublication } from "../../infra/sqlite-post-commit.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { invalidateOpenClawAgentDatabaseValidation } from "../../state/openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveSessionStorePathCore } from "./paths.js";
import { replaceSessionEntrySync } from "./session-accessor.js";
import { readExactSessionEntryRowValidated } from "./session-accessor.sqlite-entry-read.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { patchSessionEntryTarget } from "./session-accessor.sqlite-entry.js";
import {
  readExactSessionEntryFromSourceReadOnly,
  readExactSessionEntryWithContinuation,
} from "./session-accessor.sqlite-exact-read.js";
import {
  assertCanonicalSqliteSessionKeysCurrent,
  captureCanonicalSessionReaderContinuation,
  readWithCanonicalSessionAdmission,
  readWithCanonicalSessionReaderContinuation,
  setCanonicalSqliteSessionMainKey,
} from "./session-canonical-key.js";
import {
  proveNativeDeletionAbort,
  proveNativeIncognitoGuardRetirement,
} from "./session-canonical-reader-incognito.test-support.js";
import {
  withConfiguredSessionEntryReader,
  type ConfiguredSessionEntryRead,
} from "./session-entry-configured-worker-read.js";

const healthy = "agent:main:healthy";
const damaged = "agent:main:damaged";
type FixtureDatabase = ReturnType<typeof openOpenClawAgentDatabase>;

function capture(database: FixtureDatabase) {
  const continuation = captureCanonicalSessionReaderContinuation(database);
  if (!continuation) {
    throw new Error("Expected an existing committed reader admission");
  }
  return continuation;
}

function corrupt(database: FixtureDatabase) {
  database.db
    .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
    .run("{", damaged);
  database.db
    .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
    .run(damaged);
}

function replaceDatabasePath(pathname: string): () => void {
  const replacementPath = `${pathname}.continuation-new`;
  const displacedPath = `${pathname}.continuation-old`;
  const replacement = new DatabaseSync(replacementPath);
  try {
    replacement.exec("CREATE TABLE replacement_marker (value TEXT)");
  } finally {
    replacement.close();
  }
  fs.renameSync(pathname, displacedPath);
  try {
    fs.renameSync(replacementPath, pathname);
  } catch (error) {
    fs.renameSync(displacedPath, pathname);
    throw error;
  }
  return () => fs.renameSync(displacedPath, pathname);
}

async function withReaders(
  run: (fixture: {
    database: FixtureDatabase;
    reader: Extract<
      ReturnType<typeof openOpenClawAgentDatabaseReadOnly>,
      { found: true }
    >["database"];
    options: { agentId: string; env: NodeJS.ProcessEnv };
  }) => void | Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const options = { agentId: "main", env };
    for (const sessionId of ["healthy", "damaged"]) {
      replaceSessionEntrySync(
        { ...options, sessionKey: `agent:main:${sessionId}` },
        { sessionId, updatedAt: 1 },
      );
    }
    const database = openOpenClawAgentDatabase(options);
    assertCanonicalSqliteSessionKeysCurrent(database);
    const opened = openOpenClawAgentDatabaseReadOnly(options);
    if (!opened.found) {
      throw new Error("Expected the seeded read-only database");
    }
    try {
      await run({ database, reader: opened.database, options });
    } finally {
      opened.database.close();
    }
  });
}

it("continues admitted row parsing without admitting the pooled reader's next operation", async () => {
  await withReaders(({ database, reader }) => {
    const held = capture(database);
    const receipt = structuredClone(held.receipt);
    corrupt(database);
    try {
      expect(() =>
        readWithCanonicalSessionAdmission(reader, () =>
          readExactSessionEntryRowValidated(reader, healthy),
        ),
      ).toThrow("openclaw doctor --fix");
      readWithCanonicalSessionReaderContinuation(reader, receipt, () => {
        expect(reader.db.isTransaction).toBe(true);
        expect(readExactSessionEntryRowValidated(reader, healthy)?.entry.sessionId).toBe("healthy");
        expect(() => readExactSessionEntryRowValidated(reader, damaged)).toThrow(
          "openclaw doctor --fix",
        );
      });
      expect(() =>
        readWithCanonicalSessionReaderContinuation(reader, undefined, () =>
          readExactSessionEntryRowValidated(reader, healthy),
        ),
      ).toThrow("openclaw doctor --fix");
      expect(captureCanonicalSessionReaderContinuation(reader)).toBeUndefined();
    } finally {
      held.release();
    }
  });
});

it("captures and revalidates existing admission without host SQL", async () => {
  await withReaders(({ database }) => {
    const queries = trackSqliteStatementExecutions(database.db, ["host"], () => "host");
    const exec = vi.spyOn(database.db, "exec").mockImplementation(() => {
      throw new Error("host SQL");
    });
    try {
      const held = capture(database);
      held.assertCurrent();
      held.release();
      expect(() => held.assertCurrent()).toThrow("no longer current");
      expect(queries.counts.host).toBe(0);
      expect(exec).not.toHaveBeenCalled();
    } finally {
      queries.restore();
      exec.mockRestore();
    }
  });
});

it("keeps the transaction owner's synchronous callback guard", async () => {
  await withReaders(({ database, reader }) => {
    const held = capture(database);
    corrupt(database);
    try {
      expect(() =>
        readWithCanonicalSessionReaderContinuation(reader, held.receipt, () =>
          Promise.resolve(readExactSessionEntryRowValidated(reader, healthy)),
        ),
      ).toThrow("must be synchronous");
      expect(reader.db.isTransaction).toBe(false);
    } finally {
      held.release();
    }
  });
});

it.each([
  "release",
  "native close",
  "native dispose",
  "replacement",
  "main key",
  "validation",
  "readiness",
  "admission replacement",
])("preserves strict fresh admission after %s revokes the continuation", async (reason) => {
  await withReaders(({ database, reader }) => {
    const held = capture(database);
    const receipt = structuredClone(held.receipt);
    if (reason === "admission replacement") {
      database.db.exec("UPDATE session_key_contract SET main_key = 'custom' WHERE id = 1");
      assertCanonicalSqliteSessionKeysCurrent(database);
    }
    corrupt(database);
    if (reason === "release") {
      held.release();
    }
    if (reason === "native close") {
      database.db.close();
    }
    if (reason === "native dispose") {
      database.db[Symbol.dispose]();
    }
    if (reason === "replacement") {
      disposeNodeSqliteDependents(database.db, "replace");
    }
    if (reason === "main key") {
      setCanonicalSqliteSessionMainKey(database, "custom");
    }
    if (reason === "validation") {
      invalidateOpenClawAgentDatabaseValidation(database.path);
    }
    if (reason === "readiness") {
      Atomics.store(new Int32Array(held.receipt.validation.canonicalReady), 0, 0);
    }
    try {
      expect(() => held.assertCurrent()).toThrow("no longer current");
      expect(() =>
        readWithCanonicalSessionReaderContinuation(reader, receipt, () =>
          readExactSessionEntryRowValidated(reader, healthy),
        ),
      ).toThrow("openclaw doctor --fix");
    } finally {
      held.release();
    }
  });
});

it("revokes before native disposal while the source connection is still open", async () => {
  await withReaders(({ database }) => {
    const held = capture(database);
    const observations: Array<{ open: boolean; live: number }> = [];
    const stop = registerNodeSqliteDisposeCallback(database.db, () => {
      observations.push({
        open: database.db.isOpen,
        live: Atomics.load(new Int32Array(held.receipt.live), 0),
      });
    });
    try {
      closeOpenClawAgentDatabaseByPath(database.path);
      expect(observations).toContainEqual({ open: true, live: 0 });
    } finally {
      stop();
      held.release();
    }
  });
});

it.each(["release", "readiness"])(
  "refuses publication when %s changes inside the read",
  async (change) => {
    await withReaders(({ database, reader }) => {
      const held = capture(database);
      corrupt(database);
      try {
        expect(() =>
          readWithCanonicalSessionReaderContinuation(reader, structuredClone(held.receipt), () => {
            const result = readExactSessionEntryRowValidated(reader, healthy);
            if (change === "release") {
              held.release();
            } else {
              Atomics.store(new Int32Array(held.receipt.validation.canonicalReady), 0, 0);
            }
            return result;
          }),
        ).toThrow("no longer current");
      } finally {
        held.release();
      }
    });
  },
);

it("checks the worker's current main-key policy rather than a still-live old receipt", async () => {
  await withReaders(({ database, reader }) => {
    const held = capture(database);
    corrupt(database);
    database.db.exec("UPDATE session_key_contract SET main_key = 'custom' WHERE id = 1");
    try {
      expect(Atomics.load(new Int32Array(held.receipt.live), 0)).toBe(1);
      expect(() =>
        readWithCanonicalSessionReaderContinuation(reader, held.receipt, () =>
          readExactSessionEntryRowValidated(reader, healthy),
        ),
      ).toThrow("openclaw doctor --fix");
    } finally {
      held.release();
    }
  });
});

it("rechecks continuation lifetime after read transaction publications", async () => {
  await withReaders(({ database, reader }) => {
    const held = capture(database);
    corrupt(database);
    try {
      expect(() =>
        readWithCanonicalSessionReaderContinuation(reader, held.receipt, () => {
          const value = readExactSessionEntryRowValidated(reader, healthy);
          expect(deferSqlitePostCommitPublication(reader.db, held.release)).toBe(true);
          return value;
        }),
      ).toThrow("no longer current");
    } finally {
      held.release();
    }
  });
});

it("does not export a proof whose readiness changed at its admission commit", async () => {
  await withReaders(({ database, options }) => {
    const before = capture(database);
    Atomics.store(new Int32Array(before.receipt.validation.canonicalReady), 0, 0);
    runOpenClawAgentWriteTransaction((current) => {
      assertCanonicalSqliteSessionKeysCurrent(current);
    }, options);
    expect(Atomics.load(new Int32Array(before.receipt.validation.canonicalReady), 0)).toBe(1);
    expect(captureCanonicalSessionReaderContinuation(database)).toBeUndefined();
    assertCanonicalSqliteSessionKeysCurrent(database);
    capture(database).release();
    before.release();
  });
});

it("refuses a receipt for another physical database with the same agent owner", async () => {
  await withReaders(({ database, options }) => {
    const held = capture(database);
    const otherOptions = {
      ...options,
      path: path.join(path.dirname(database.path), "other.sqlite"),
    };
    runOpenClawAgentWriteTransaction((other) => {
      writeSessionEntry(other, healthy, { sessionId: "other-healthy", updatedAt: 1 });
      writeSessionEntry(other, damaged, { sessionId: "other-damaged", updatedAt: 1 });
    }, otherOptions);
    const other = openOpenClawAgentDatabase(otherOptions);
    corrupt(other);
    const opened = openOpenClawAgentDatabaseReadOnly(otherOptions);
    if (!opened.found) {
      throw new Error("Expected the second physical database");
    }
    try {
      expect(() =>
        readWithCanonicalSessionReaderContinuation(opened.database, held.receipt, () =>
          readExactSessionEntryRowValidated(opened.database, healthy),
        ),
      ).toThrow("openclaw doctor --fix");
    } finally {
      held.release();
      opened.database.close();
    }
  });
});

it("does not capture an unadmitted connection or a warm connection inside a transaction", async () => {
  await withReaders(({ database, reader, options }) => {
    expect(captureCanonicalSessionReaderContinuation(reader)).toBeUndefined();
    runOpenClawAgentWriteTransaction(() => {
      expect(captureCanonicalSessionReaderContinuation(database)).toBeUndefined();
    }, options);
    capture(database).release();
  });
});

it.each(["rollback", "manual commit", "invalidate before commit"])(
  "does not export staged admission after %s",
  async (ending) => {
    await withReaders(({ database, options }) => {
      closeOpenClawAgentDatabaseByPath(database.path);
      const reopened = openOpenClawAgentDatabase(options);
      expect(captureCanonicalSessionReaderContinuation(reopened)).toBeUndefined();
      if (ending === "manual commit") {
        reopened.db.exec("BEGIN");
        try {
          assertCanonicalSqliteSessionKeysCurrent(reopened);
          expect(captureCanonicalSessionReaderContinuation(reopened)).toBeUndefined();
        } finally {
          reopened.db.exec("COMMIT");
        }
      } else {
        const run = () =>
          runOpenClawAgentWriteTransaction((current) => {
            assertCanonicalSqliteSessionKeysCurrent(current);
            expect(captureCanonicalSessionReaderContinuation(current)).toBeUndefined();
            if (ending === "rollback") {
              throw new Error("abandoned admission");
            }
            setCanonicalSqliteSessionMainKey(current, "custom");
          }, options);
        if (ending === "rollback") {
          expect(run).toThrow("abandoned admission");
        } else {
          run();
        }
      }
      expect(captureCanonicalSessionReaderContinuation(reopened)).toBeUndefined();
    });
  },
);

it("restores committed admission on rollback without resurrecting old continuations", async () => {
  await withReaders(({ database, options }) => {
    const old = capture(database);
    expect(() =>
      runOpenClawAgentWriteTransaction((current) => {
        current.db.exec("UPDATE session_key_contract SET main_key = 'custom' WHERE id = 1");
        assertCanonicalSqliteSessionKeysCurrent(current);
        expect(captureCanonicalSessionReaderContinuation(current)).toBeUndefined();
        throw new Error("rollback policy");
      }, options),
    ).toThrow("rollback policy");
    expect(() => old.assertCurrent()).toThrow("no longer current");
    const next = capture(database);
    next.assertCurrent();
    next.release();
    old.release();
  });
});

it("keeps an already active worker transaction on the strict admission path", async () => {
  await withReaders(({ database, reader }) => {
    const held = capture(database);
    corrupt(database);
    reader.db.exec("BEGIN");
    try {
      expect(() =>
        readWithCanonicalSessionReaderContinuation(reader, held.receipt, () =>
          readExactSessionEntryRowValidated(reader, healthy),
        ),
      ).toThrow("openclaw doctor --fix");
    } finally {
      reader.db.exec("ROLLBACK");
      held.release();
    }
  });
});

// POSIX permits replacing a pathname while both native connections remain open.
it.runIf(process.platform !== "win32").each(["before host publication", "before worker return"])(
  "rejects physical replacement %s while the original handles remain open",
  async (when) => {
    await withReaders(({ database, reader }) => {
      const held = capture(database);
      let restore: (() => void) | undefined;
      corrupt(database);
      try {
        if (when === "before host publication") {
          expect(
            readWithCanonicalSessionReaderContinuation(reader, held.receipt, () =>
              readExactSessionEntryRowValidated(reader, healthy),
            )?.entry.sessionId,
          ).toBe("healthy");
          restore = replaceDatabasePath(database.path);
          expect(database.db.isOpen).toBe(true);
          expect(() => held.assertCurrent()).toThrow("no longer current");
          expect(captureCanonicalSessionReaderContinuation(database)).toBeUndefined();
        } else {
          expect(() =>
            readWithCanonicalSessionReaderContinuation(reader, held.receipt, () => {
              const result = readExactSessionEntryRowValidated(reader, healthy);
              restore = replaceDatabasePath(database.path);
              expect(reader.db.isOpen).toBe(true);
              return result;
            }),
          ).toThrow("no longer current");
        }
      } finally {
        restore?.();
        held.release();
      }
    });
  },
);

it.each(["COMMIT", "ROLLBACK"])(
  "revokes prior continuations when unmanaged admission cannot stage before %s",
  async (ending) => {
    await withReaders(({ database }) => {
      const held = capture(database);
      database.db.exec("BEGIN");
      try {
        database.db.exec("UPDATE session_key_contract SET main_key = 'custom' WHERE id = 1");
        assertCanonicalSqliteSessionKeysCurrent(database);
        expect(Atomics.load(new Int32Array(held.receipt.live), 0)).toBe(0);
      } finally {
        database.db.exec(ending);
      }
      expect(() => held.assertCurrent()).toThrow("no longer current");
      expect(captureCanonicalSessionReaderContinuation(database)).toBeUndefined();
      held.release();
    });
  },
);

it("forwards exact-reader continuation into the actual admission kernel without warming it", async () => {
  await withReaders(({ database, reader }) => {
    const held = capture(database);
    corrupt(database);
    try {
      expect(
        readExactSessionEntryWithContinuation(reader, healthy, structuredClone(held.receipt)).entry
          ?.sessionId,
      ).toBe("healthy");
      expect(() => readExactSessionEntryWithContinuation(reader, damaged, held.receipt)).toThrow(
        "openclaw doctor --fix",
      );
      expect(captureCanonicalSessionReaderContinuation(reader)).toBeUndefined();
      expect(() => readExactSessionEntryWithContinuation(reader, healthy)).toThrow(
        "openclaw doctor --fix",
      );
      held.release();
      expect(() => readExactSessionEntryWithContinuation(reader, healthy, held.receipt)).toThrow(
        "openclaw doctor --fix",
      );
    } finally {
      held.release();
    }
  });
});

it("rejects exact-reader continuation from another physical source", async () => {
  await withReaders(({ database, reader }) => {
    const held = capture(database);
    corrupt(database);
    try {
      const otherSource = { ...structuredClone(held.receipt), identity: "another-physical-source" };
      expect(() => readExactSessionEntryWithContinuation(reader, healthy, otherSource)).toThrow(
        "openclaw doctor --fix",
      );
    } finally {
      held.release();
    }
  });
});

it("accepts a new exact read transport for the unchanged physical source", async () => {
  await withReaders(({ reader, options }) => {
    const first = readExactSessionEntryWithContinuation(reader, healthy);
    reader.close();
    const reopened = openOpenClawAgentDatabaseReadOnly(options);
    if (!reopened.found) {
      throw new Error("Expected replacement read transport");
    }
    try {
      const next = readExactSessionEntryWithContinuation(
        reopened.database,
        healthy,
        undefined,
        first.identity,
      );
      expect(next.entry).toEqual(first.entry);
      expect(next.identity.identity).toBe(first.identity.identity);
      expect(next.identity.birthtime).toBe(first.identity.birthtime);
      expect(next.identity.incarnation).not.toBe(first.identity.incarnation);
    } finally {
      reopened.database.close();
    }
  });
});

it("rejects a different physical file at the same locator even with copied row facts", async () => {
  await withReaders(({ database, reader, options }) => {
    const first = readExactSessionEntryWithContinuation(reader, healthy);
    reader.close();
    expect(closeOpenClawAgentDatabaseByPath(database.path)).toBe(true);
    const replacementPath = `${database.path}.source-copy`;
    fs.copyFileSync(database.path, replacementPath);
    fs.renameSync(database.path, `${database.path}.source-before`);
    fs.renameSync(replacementPath, database.path);
    const reopened = openOpenClawAgentDatabaseReadOnly(options);
    if (!reopened.found) {
      throw new Error("Expected the copied replacement database");
    }
    try {
      const replacement = readExactSessionEntryWithContinuation(reopened.database, healthy);
      expect(replacement.entry).toEqual(first.entry);
      expect(replacement.identity.identity).not.toBe(first.identity.identity);
      expect(() =>
        readExactSessionEntryWithContinuation(
          reopened.database,
          healthy,
          undefined,
          first.identity,
        ),
      ).toThrow("physical source was replaced");
    } finally {
      reopened.database.close();
    }
  });
});

it("distinguishes a truly missing exact database from a schema-unavailable native result", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const pathname = state.statePath("exact-unavailable.sqlite");
    const request = {
      readSource: { agentId: "main", path: pathname },
      sessionKey: healthy,
      env: state.env,
    };
    expect(readExactSessionEntryFromSourceReadOnly(request)).toBeUndefined();
    expect(fs.existsSync(pathname)).toBe(false);
    new DatabaseSync(pathname).close();
    expect(() => readExactSessionEntryFromSourceReadOnly(request)).toThrow("schema-missing");
  });
});

it("retains successful native incognito reads without selecting a disk worker", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const sessionKey = "agent:main:dashboard:incognito-exact-reader";
    const scope = { agentId: "main", sessionKey, env: state.env };
    replaceSessionEntrySync(scope, { sessionId: "native-only", updatedAt: 1, incognito: true });
    await withConfiguredSessionEntryReader(
      {},
      {
        ...scope,
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main", env: state.env }),
      },
      (reader) => {
        if (reader.kind !== "incognito") {
          throw new Error("Expected a native incognito reader");
        }
        const read = reader.readEntry();
        expect(read).not.toBeInstanceOf(Promise);
        read.assertCurrent();
        expect(read.entry).toMatchObject({ sessionId: "native-only", incognito: true });
        expect(fs.existsSync(reader.readSource.path)).toBe(false);
      },
    );
  });
});

it("keeps a warmed configured requester authorized inside the real target-patch commit", async () => {
  await withReaders(async ({ database, options }) => {
    const held = capture(database);
    const storePath = resolveSessionStorePathCore(undefined, options);
    let commitCalls = 0;
    let attemptedRead: Promise<ConfiguredSessionEntryRead> | undefined;
    try {
      await withConfiguredSessionEntryReader(
        {},
        {
          ...options,
          storePath,
          sessionKey: healthy,
        },
        async (retained) => {
          if (retained.kind !== "durable") {
            throw new Error("Expected a durable requester");
          }
          const initial = await retained.readEntry();
          initial.assertCurrent();
          expect(initial.entry?.sessionId).toBe("healthy");
          const updated = await patchSessionEntryTarget(
            {
              agentId: options.agentId,
              storePath,
              target: { canonicalKey: healthy, storeKeys: [healthy] },
            },
            () => ({ label: "real-guarded-commit" }),
            {
              skipMaintenance: true,
              assertCommitAllowed: () => {
                // This is the real writer's synchronous transaction, not a predicate stub.
                expect(database.db.isTransaction).toBe(true);
                commitCalls++;
                retained.assertCurrent();
                expect(() => held.assertCurrent()).toThrow("continuation is no longer current");
                attemptedRead = retained.readEntry();
                // Observe read-only rejection outside the synchronous transaction below.
                void attemptedRead.catch(() => undefined);
              },
            },
          );
          expect(commitCalls).toBe(1);
          expect(updated).toMatchObject({ sessionId: "healthy", label: "real-guarded-commit" });
          expect(database.db.isTransaction).toBe(false);
          if (!attemptedRead) {
            throw new Error("The real commit guard did not attempt its read control");
          }
          await expect(attemptedRead).rejects.toThrow("continuation is no longer current");
          held.assertCurrent();
          const latest = await retained.readEntry();
          latest.assertCurrent();
          expect(latest.entry).toMatchObject({
            sessionId: "healthy",
            label: "real-guarded-commit",
          });
        },
      );
    } finally {
      held.release();
      await attemptedRead?.catch(() => undefined);
    }
  });
}, 10_000);

it("refuses a real guarded target patch after its captured native source closes and reopens", async () => {
  await withReaders(async ({ database, options }) => {
    const storePath = resolveSessionStorePathCore(undefined, options);
    let commitCalls = 0;
    let replacement: ReturnType<typeof openOpenClawAgentDatabase> | undefined;
    const attempted = withConfiguredSessionEntryReader(
      {},
      {
        ...options,
        storePath,
        sessionKey: healthy,
      },
      async (retained) => {
        const initial = await retained.readEntry();
        initial.assertCurrent();
        expect(initial.entry?.sessionId).toBe("healthy");
        await closeOpenClawAgentDatabaseByPathAsync(database.path, options.agentId);
        replacement = openOpenClawAgentDatabase(options);
        expect(replacement).not.toBe(database);
        return await patchSessionEntryTarget(
          {
            agentId: options.agentId,
            storePath,
            target: { canonicalKey: healthy, storeKeys: [healthy] },
          },
          () => ({ label: "must-not-commit" }),
          {
            skipMaintenance: true,
            assertCommitAllowed: () => {
              expect(replacement?.db.isTransaction).toBe(true);
              commitCalls++;
              retained.assertCurrent();
            },
          },
        );
      },
    );
    await expect(attempted).rejects.toThrow(/revoked|no longer current|changed/);
    expect(commitCalls).toBe(1);
    if (!replacement) {
      throw new Error("Expected the real replacement writer");
    }
    expect(readExactSessionEntryWithContinuation(replacement, healthy).entry).toMatchObject({
      sessionId: "healthy",
    });
    expect(readExactSessionEntryWithContinuation(replacement, healthy).entry?.label).not.toBe(
      "must-not-commit",
    );
  });
}, 10_000);

it.for(["native-close", "deletion"] as const)(
  "keeps repeated incognito guards free of durable SQL and retains %s refusal",
  { timeout: 10_000 },
  async (ending, context) => {
    await proveNativeIncognitoGuardRetirement(ending, context);
  },
);

it.for(["before-drain-entry", "held-drain"] as const)(
  "joins journaled native cancellation at %s before full fixture retirement",
  { timeout: 10_000 },
  async (phase, context) => {
    await proveNativeDeletionAbort(phase, context);
  },
);
