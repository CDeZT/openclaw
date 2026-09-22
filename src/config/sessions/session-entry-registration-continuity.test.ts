import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { hasSqlitePostCommitScope } from "../../infra/sqlite-post-commit.js";
import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  createAgentDatabaseInspectionRefusal,
  preparePendingAgentDatabase,
  recordAgentDatabaseAdmissions,
} from "../../state/agent-database-admission.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import * as readOnlySchema from "../../state/openclaw-agent-db-readonly-open.js";
import { OpenClawAgentDatabaseReadOnlyScope } from "../../state/openclaw-agent-db-readonly-scope.js";
import * as registryListing from "../../state/openclaw-agent-db-registry-listing.js";
import { invalidateOpenClawAgentDatabaseValidation } from "../../state/openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
  withOpenClawAgentDatabaseAsync,
} from "../../state/openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "../../state/openclaw-agent-execution-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  retainOpenClawStateDatabaseSelector,
} from "../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveSessionStorePathCore } from "./paths.js";
import { replaceSessionEntrySync } from "./session-accessor.js";
import { readExactSessionEntryFromSourceReadOnly } from "./session-accessor.sqlite-exact-read.js";
import { assertCanonicalSqliteSessionKeysCurrent } from "./session-canonical-key.js";
import { withConfiguredSessionEntryReader } from "./session-entry-configured-worker-read.js";
import { historyLane, rotateDatabaseWorkers } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

const sessionKey = "agent:main:registration-continuity";

async function withColdRequester(
  operation: (fixture: {
    options: { agentId: string; env: NodeJS.ProcessEnv; path: string };
    storePath: string;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const options = { agentId: "main", env };
    replaceSessionEntrySync(
      { ...options, sessionKey },
      {
        sessionId: "original-requester",
        updatedAt: 1,
      },
    );
    const database = openOpenClawAgentDatabase(options);
    assertCanonicalSqliteSessionKeysCurrent(database);
    const pathname = database.path;
    await closeOpenClawAgentDatabaseByPathAsync(pathname, options.agentId);
    invalidateOpenClawAgentDatabaseValidation(pathname);
    expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
    await operation({
      options: { ...options, path: pathname },
      storePath: resolveSessionStorePathCore(undefined, options),
    });
  });
}

it.each(["failed", "pending"] as const)(
  "irreversibly fences a cold reader after a real host %s admission refusal without a broadcast",
  async (kind) => {
    await withColdRequester(async ({ options, storePath }) => {
      let stores = 0;
      const unsubscribe = sessionChanges.subscribe((event) => {
        if ("all" in event && event.scope === "stores") stores++;
      });
      try {
        const pending = withConfiguredSessionEntryReader(
          {},
          { ...options, sessionKey, storePath },
          async (reader) => {
            const first = await reader.readEntry();
            first.assertCurrent();
            recordAgentDatabaseAdmissions(
              [
                createAgentDatabaseInspectionRefusal({
                  agentId: options.agentId,
                  paths: [options.path],
                  reason: "canonical host admission refused",
                  pending: kind === "pending",
                }),
              ],
              { env: options.env },
            );
            expect(stores).toBe(0);
            expect(() => reader.assertCurrent()).toThrow("canonical host admission refused");
            recordAgentDatabaseAdmissions([], { env: options.env });
            expect(stores).toBe(0);
            expect(() => first.assertCurrent()).toThrow("revoked");
            await expect(reader.readEntry()).rejects.toThrow("revoked");
          },
        );
        await expect(pending).rejects.toThrow("revoked");
      } finally {
        recordAgentDatabaseAdmissions([], { env: options.env });
        unsubscribe();
      }
    });
  },
  10_000,
);

it("does not revive a cold reader after its real host preparation guard is lost", async () => {
  await withColdRequester(async ({ options, storePath }) => {
    const refusal = createAgentDatabaseInspectionRefusal({
      agentId: options.agentId,
      paths: [options.path],
      reason: "canonical preparation pending",
      pending: true,
    });
    recordAgentDatabaseAdmissions([refusal], { env: options.env });
    let current = true;
    let stores = 0;
    const unsubscribe = sessionChanges.subscribe((event) => {
      if ("all" in event && event.scope === "stores") stores++;
    });
    try {
      await preparePendingAgentDatabase(
        refusal,
        {
          env: options.env,
          assertCurrent() {
            if (!current) throw new Error("canonical preparation retired");
          },
        },
        async () => {
          const pending = withConfiguredSessionEntryReader(
            {},
            { ...options, sessionKey, storePath },
            async (reader) => {
              const first = await reader.readEntry();
              first.assertCurrent();
              current = false;
              expect(() => reader.assertCurrent()).toThrow("canonical preparation retired");
              current = true;
              expect(stores).toBe(0);
              expect(() => first.assertCurrent()).toThrow("revoked");
              await expect(reader.readEntry()).rejects.toThrow("revoked");
            },
          );
          await expect(pending).rejects.toThrow("revoked");
        },
      );
    } finally {
      recordAgentDatabaseAdmissions([], { env: options.env });
      unsubscribe();
    }
  });
}, 10_000);

it.each(["replacement", "absence"] as const)(
  "never revives after a real worker-observed physical source %s is restored",
  async (change) => {
    await withColdRequester(async ({ options }) => {
      const operation = withSessionHistoryWorkerDatabase(options, async (owner) => {
        const scope = {
          agentId: options.agentId,
          databaseAgentId: options.agentId,
          storePath: options.path,
          sessionKey,
          env: options.env,
        };
        expect((await owner.readEntry(scope))?.sessionId).toBe("original-requester");
        const accepted = owner.acceptedSource();
        if (!accepted) throw new Error("Real accepted read did not retain its source facts");
        accepted.assertCurrent();
        // Join transport cleanup before renaming, including on Windows. This
        // retains the lexical reader, not the retired worker's native handle.
        await rotateDatabaseWorkers(historyLane);
        const original = `${options.path}.worker-held-original`;
        const replacement = `${options.path}.worker-replacement`;
        if (change === "replacement") fs.copyFileSync(options.path, replacement);
        fs.renameSync(options.path, original);
        try {
          if (change === "replacement") fs.renameSync(replacement, options.path);
          // No host source/stat assertion precedes dispatch: the actual worker
          // must observe the failure and send it through its error reply path.
          await expect(owner.readEntry(scope)).rejects.toThrow();
        } finally {
          if (change === "replacement" && fs.existsSync(options.path)) {
            fs.renameSync(options.path, replacement);
          }
          fs.renameSync(original, options.path);
        }
        expect(() => owner.assertCurrent()).toThrow();
        expect(() => accepted.assertCurrent()).toThrow();
        await expect(owner.readEntry(scope)).rejects.toThrow();
      });
      await expect(operation).rejects.toThrow();
    });
  },
  10_000,
);

it("binds a warm no-continuation row and schema facts to one SQLite snapshot", async () => {
  await withColdRequester(async ({ options }) => {
    const retained = new OpenClawAgentDatabaseReadOnlyScope(true);
    const foreign = new DatabaseSync(options.path);
    try {
      retained.run(options, () => {
        const read = () =>
          readExactSessionEntryFromSourceReadOnly({
            readSource: options,
            sessionKey,
            env: options.env,
          });
        expect(read()?.facts?.userVersion).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
        const realFacts = readOnlySchema.readOpenClawAgentReadOnlySchemaFacts;
        let observed = 0;
        const facts = vi
          .spyOn(readOnlySchema, "readOpenClawAgentReadOnlySchemaFacts")
          .mockImplementation((database) => {
            observed++;
            expect(database.db.isTransaction).toBe(true);
            expect(hasSqlitePostCommitScope(database.db)).toBe(true);
            // This is after row selection, using a genuine second connection.
            foreign.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1}`);
            return realFacts(database);
          });
        try {
          const second = read();
          expect(observed).toBe(1);
          expect(second?.entry?.sessionId).toBe("original-requester");
          expect(second?.facts?.userVersion).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
        } finally {
          facts.mockRestore();
        }
        expect(() => read()).toThrow();
      });
    } finally {
      foreign.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION}`);
      foreign.close();
      retained.close();
    }
  });
});

it.each(["native", "worker"] as const)(
  "keeps the same genuinely cold configured reader across real %s metadata registration",
  async (transport) => {
    await withColdRequester(async ({ options, storePath }) => {
      const otherRoot = { path: path.join(path.dirname(options.path), "other-state.sqlite") };
      const otherToken = registryListing.readOpenClawAgentDatabaseRegistryToken(otherRoot);
      const originalPrepare = registryListing.prepareOpenClawAgentDatabaseRegistrySnapshotRead;
      let registryDemands = 0;
      const prepare = vi
        .spyOn(registryListing, "prepareOpenClawAgentDatabaseRegistrySnapshotRead")
        .mockImplementation((...args) => {
          const prepared = originalPrepare(...args);
          return {
            async read() {
              registryDemands++;
              return await prepared.read();
            },
          };
        });
      let stores = 0;
      const unsubscribe = sessionChanges.subscribe((event) => {
        if ("all" in event && event.scope === "stores") stores++;
      });
      try {
        await withConfiguredSessionEntryReader(
          {},
          { ...options, sessionKey, storePath },
          async (reader) => {
            expect(reader.kind).toBe("durable");
            const selected = reader.readSource;
            const first = await reader.readEntry();
            first.assertCurrent();
            expect(first.entry?.sessionId).toBe("original-requester");
            expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
            expect(registryListing.readOpenClawAgentDatabaseRegistryToken(otherRoot)).toBe(
              otherToken,
            );
            expect(registryDemands).toBe(0);
            if (transport === "native") {
              openOpenClawAgentDatabase(options);
            } else {
              const execution = captureOpenClawAgentDatabaseExecution(options);
              const source: AgentDatabaseRequestExecutionSource = {
                assertCurrent: reader.assertCurrent,
                createAdmission(binding) {
                  return () => ({
                    nativeLocations: binding.nativeLocations,
                    admission: createSqliteWorkerOperationAdmission((request, grant) => {
                      binding.authorize(request);
                      binding.assertCurrent();
                      reader.assertCurrent();
                      if (!grant()) throw new Error("Original requester grant expired");
                    }),
                  });
                },
              };
              try {
                await execution.runExisting(source, (scope) =>
                  scope.execute({ type: "database.prepareWrite", input: undefined }),
                );
              } finally {
                await execution.release();
              }
            }
            expect(stores).toBe(1);
            reader.assertCurrent();
            first.assertCurrent();
            expect(reader.readSource).toBe(selected);
            const next = await reader.readEntry();
            next.assertCurrent();
            expect(next.entry).toEqual(first.entry);
          },
        );
      } finally {
        unsubscribe();
        prepare.mockRestore();
      }
    });
  },
  10_000,
);

it.each(["native", "worker"] as const)(
  "preserves both live same-source readers when the second reader initiates %s registration",
  async (transport) => {
    await withColdRequester(async ({ options, storePath }) => {
      await withConfiguredSessionEntryReader(
        {},
        { ...options, sessionKey, storePath },
        async (first) => {
          const firstRead = await first.readEntry();
          await withConfiguredSessionEntryReader(
            {},
            { ...options, sessionKey, storePath },
            async (second) => {
              const secondRead = await second.readEntry();
              if (transport === "native") {
                await withOpenClawAgentDatabaseAsync(options, () => {}, second.assertCurrent);
              } else {
                const execution = captureOpenClawAgentDatabaseExecution(options);
                const source: AgentDatabaseRequestExecutionSource = {
                  assertCurrent: second.assertCurrent,
                  createAdmission(binding) {
                    return () => ({
                      nativeLocations: binding.nativeLocations,
                      admission: createSqliteWorkerOperationAdmission((request, grant) => {
                        binding.authorize(request);
                        binding.assertCurrent();
                        second.assertCurrent();
                        if (!grant()) throw new Error("Second requester grant expired");
                      }),
                    });
                  },
                };
                try {
                  await execution.runExisting(source, (scope) =>
                    scope.execute({ type: "database.prepareWrite", input: undefined }),
                  );
                } finally {
                  await execution.release();
                }
              }
              first.assertCurrent();
              second.assertCurrent();
              firstRead.assertCurrent();
              secondRead.assertCurrent();
              expect((await second.readEntry()).entry).toEqual(firstRead.entry);
            },
          );
          first.assertCurrent();
        },
      );
    });
  },
  10_000,
);

it.each([
  "duplicate",
  "malformed-first",
  "malformed-last",
  "unbound-first",
  "unbound-last",
  "ungranted",
  "other-domain",
] as const)(
  "reconciles %s effects through the real host and exact worker grant",
  async (fault) => {
    await withColdRequester(async ({ options, storePath }) => {
      let stores = 0;
      let injected = 0;
      let refusedCommit = false;
      const stop = sessionChanges.subscribe((event) => {
        if ("all" in event && event.scope === "stores") stores++;
      });
      try {
        await withConfiguredSessionEntryReader(
          {},
          { ...options, sessionKey, storePath },
          async (reader) => {
            (await reader.readEntry()).assertCurrent();
            const execution = captureOpenClawAgentDatabaseExecution(options);
            const source: AgentDatabaseRequestExecutionSource = {
              assertCurrent: reader.assertCurrent,
              createAdmission(binding) {
                return () => {
                  let ungrantedEffect: Record<string, unknown> | undefined;
                  const admission = createSqliteWorkerOperationAdmission((request, grant) => {
                    binding.authorize(request);
                    binding.assertCurrent();
                    reader.assertCurrent();
                    const facts = asOptionalRecord(request.facts);
                    if (
                      fault === "ungranted" &&
                      request.stage === "commit" &&
                      facts?.kind === "agent-registration-commit"
                    ) {
                      const captured = asOptionalRecord(facts.binding);
                      if (!captured) throw new Error("Real commit request omitted its binding");
                      refusedCommit = true;
                      ungrantedEffect = {
                        kind: "agent-registration",
                        binding: facts.binding,
                        registration: facts.registration,
                        receipt: {
                          agentId: captured.agentId,
                          agentPath: captured.agentPath,
                          stateDatabasePath: captured.stateDatabasePath,
                          stateDatabaseIdentity: captured.stateDatabaseIdentity,
                        },
                      };
                      // authorize records the real request, but its original atomic
                      // grant is deliberately never invoked for this negative case.
                      throw new Error("Controlled refusal before the actual host grant");
                    }
                    if (!grant()) throw new Error("Original requester grant expired");
                  });
                  // Fault-inject only the received-fact view. The actual worker,
                  // private port, atomic grants, finish/service and grant WeakSet
                  // remain the real implementations; no acceptance mock is used.
                  const intercepted = new Proxy(admission, {
                    get(target, property, receiver) {
                      if (property !== "committed") return Reflect.get(target, property, receiver);
                      const committed = target.committed;
                      if (ungrantedEffect) {
                        injected++;
                        return { facts: committed?.facts, effects: [ungrantedEffect] };
                      }
                      const effects = committed?.effects;
                      const effect = effects?.find(
                        (value) => asOptionalRecord(value)?.kind === "agent-registration",
                      );
                      const record = asOptionalRecord(effect);
                      if (!committed || !effects || !record) return committed;
                      injected++;
                      const wrong = {
                        ...record,
                        receipt: {
                          ...asOptionalRecord(record.receipt),
                          stateDatabaseIdentity: "file:not-this-owner",
                        },
                      };
                      const extra =
                        fault === "duplicate"
                          ? effect
                          : fault.startsWith("malformed")
                            ? null
                            : fault === "other-domain"
                              ? { kind: "another-owner-domain" }
                              : wrong;
                      return {
                        ...committed,
                        effects: fault.endsWith("first")
                          ? [extra, ...effects]
                          : [...effects, extra],
                      };
                    },
                  });
                  return { nativeLocations: binding.nativeLocations, admission: intercepted };
                };
              },
            };
            try {
              const result = execution.runExisting(source, (scope) =>
                scope.execute({ type: "database.prepareWrite", input: undefined }),
              );
              if (fault === "other-domain") await result;
              else await expect(result).rejects.toThrow();
              expect(injected).toBeGreaterThan(0);
              expect(refusedCommit).toBe(fault === "ungranted");
              expect(stores).toBe(fault === "ungranted" ? 0 : 1);
            } finally {
              await execution.release();
            }
          },
        );
        expect(stores).toBe(fault === "ungranted" ? 0 : 1);
      } finally {
        stop();
      }
    });
  },
  10_000,
);

it.each(["index", "session-key contract"] as const)(
  "fences a held reader before actual same-version %s convergence DDL",
  async (repair) => {
    await withColdRequester(async ({ options, storePath }) => {
      let observedDdl = 0;
      const pending = withConfiguredSessionEntryReader(
        {},
        { ...options, sessionKey, storePath },
        async (reader) => {
          (await reader.readEntry()).assertCurrent();
          const external = new DatabaseSync(options.path);
          try {
            if (repair === "index") {
              const row = external
                .prepare(
                  "SELECT name FROM sqlite_schema WHERE type = 'index' AND sql LIKE 'CREATE INDEX%' LIMIT 1",
                )
                .get();
              if (typeof row?.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.name)) {
                throw new Error("Fixture requires a canonical nonunique index");
              }
              external.exec(`DROP INDEX ${row.name}`);
            } else {
              external.exec("DROP TABLE session_key_contract");
            }
          } finally {
            external.close();
          }
          const originalExec = DatabaseSync.prototype.exec;
          const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
            this: DatabaseSync,
            sql: string,
          ) {
            if (
              (repair === "index" && /CREATE (?:UNIQUE )?INDEX main\.openclaw_probe_/.test(sql)) ||
              (repair === "session-key contract" &&
                sql.includes("CREATE TABLE IF NOT EXISTS session_key_contract"))
            ) {
              observedDdl++;
              expect(() => reader.assertCurrent()).toThrow();
            }
            return originalExec.call(this, sql);
          });
          try {
            openOpenClawAgentDatabase(options);
            expect(observedDdl).toBeGreaterThan(0);
            expect(() => reader.assertCurrent()).toThrow();
          } finally {
            exec.mockRestore();
          }
        },
      );
      await expect(pending).rejects.toThrow();
      expect(observedDdl).toBeGreaterThan(0);
    });
  },
  10_000,
);

it("aborts native repair before DDL when hard promotion revokes the original caller W", async () => {
  await withColdRequester(async ({ options, storePath }) => {
    let attemptedDdl = 0;
    const pending = withConfiguredSessionEntryReader(
      {},
      { ...options, sessionKey, storePath },
      async (reader) => {
        (await reader.readEntry()).assertCurrent();
        const external = new DatabaseSync(options.path);
        try {
          external.exec("DROP TABLE session_key_contract");
        } finally {
          external.close();
        }
        const originalExec = DatabaseSync.prototype.exec;
        const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
          this: DatabaseSync,
          sql: string,
        ) {
          if (sql.includes("CREATE TABLE IF NOT EXISTS session_key_contract")) attemptedDdl++;
          return originalExec.call(this, sql);
        });
        try {
          await expect(
            withOpenClawAgentDatabaseAsync(
              options,
              () => {
                throw new Error("Revoked requester must not enter its operation");
              },
              reader.assertCurrent,
            ),
          ).rejects.toThrow();
        } finally {
          exec.mockRestore();
        }
      },
    );
    await expect(pending).rejects.toThrow();
    expect(attemptedDdl).toBe(0);
  });
}, 10_000);

it("keeps unrelated durable selector roots current during a real incognito open", async () => {
  await withColdRequester(async ({ options }) => {
    const shared = openOpenClawStateDatabase({ env: options.env });
    const otherPath = path.join(path.dirname(shared.path), "unopened-other-state.sqlite");
    const borrows = [shared.path, otherPath].map((pathname) =>
      retainOpenClawStateDatabaseSelector(captureOpenClawStateDatabaseReadAdmission(pathname)),
    );
    const incognitoPath = resolveIncognitoOpenClawAgentSqlitePath(options);
    try {
      for (const borrow of borrows) borrow.assertCurrent();
      const incognito = openOpenClawAgentDatabase({ ...options, path: incognitoPath });
      expect(incognito.db.location()).toBeNull();
      expect(fs.existsSync(incognitoPath)).toBe(false);
      for (const borrow of borrows) borrow.assertCurrent();
      expect(fs.existsSync(otherPath)).toBe(false);
    } finally {
      for (const borrow of borrows) borrow.release();
      await closeOpenClawAgentDatabaseByPathAsync(incognitoPath, options.agentId);
    }
  });
});

it("retains a failed native repair's hard interval until the exact handle and lease close", async () => {
  await withColdRequester(async ({ options }) => {
    const shared = openOpenClawStateDatabase({ env: options.env });
    const admission = captureOpenClawStateDatabaseReadAdmission(shared.path);
    const previous = retainOpenClawStateDatabaseSelector(admission);
    const assertNewBorrowBlocked = () => {
      let during: ReturnType<typeof retainOpenClawStateDatabaseSelector> | undefined;
      try {
        expect(() => {
          during = retainOpenClawStateDatabaseSelector(admission);
        }).toThrow();
      } finally {
        during?.release();
      }
    };
    const foreign = new DatabaseSync(options.path);
    try {
      const row = foreign
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'index' AND sql LIKE 'CREATE INDEX%' LIMIT 1",
        )
        .get();
      if (typeof row?.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.name)) {
        throw new Error("Fixture requires a canonical nonunique index");
      }
      foreign.exec(`DROP INDEX ${row.name}`);
    } finally {
      foreign.close();
    }
    let attemptedRepair = 0;
    let allowClose = false;
    const nativeExec = DatabaseSync.prototype.exec;
    const nativeClose = DatabaseSync.prototype.close;
    const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      if (
        this.location() === options.path &&
        /CREATE (?:UNIQUE )?INDEX main\.openclaw_probe_/.test(sql)
      ) {
        attemptedRepair++;
        expect(() => previous.assertCurrent()).toThrow();
        throw new Error("controlled repair failure after fencing");
      }
      return nativeExec.call(this, sql);
    });
    const close = vi
      .spyOn(DatabaseSync.prototype, "close")
      .mockImplementation(function (this: DatabaseSync) {
        if (this.isOpen && this.location() === options.path && !allowClose) {
          throw new Error("controlled native close failure");
        }
        return nativeClose.call(this);
      });
    try {
      expect(() => openOpenClawAgentDatabase(options)).toThrow();
      expect(attemptedRepair).toBeGreaterThan(0);
      assertNewBorrowBlocked();
      await expect(
        closeOpenClawAgentDatabaseByPathAsync(options.path, options.agentId),
      ).rejects.toThrow();
      assertNewBorrowBlocked();
      allowClose = true;
      await closeOpenClawAgentDatabaseByPathAsync(options.path, options.agentId);
      expect(() => previous.assertCurrent()).toThrow();
      const next = retainOpenClawStateDatabaseSelector(admission);
      try {
        next.assertCurrent();
      } finally {
        next.release();
      }
      // Already-settled disposal must not repeat a stale exact-cache callback.
      await closeOpenClawAgentDatabaseByPathAsync(options.path, options.agentId);
    } finally {
      allowClose = true;
      close.mockRestore();
      exec.mockRestore();
      previous.release();
      await closeOpenClawAgentDatabaseByPathAsync(options.path, options.agentId);
    }
  });
}, 10_000);

it.runIf(process.platform !== "win32")(
  "rejects physical replacement in the effect guard without another exact read",
  async () => {
    await withColdRequester(async ({ options, storePath }) => {
      const pending = withConfiguredSessionEntryReader(
        {},
        { ...options, sessionKey, storePath },
        async (reader) => {
          const first = await reader.readEntry();
          first.assertCurrent();
          const old = `${options.path}.held-original`;
          const replacement = `${options.path}.replacement`;
          fs.copyFileSync(options.path, replacement);
          fs.renameSync(options.path, old);
          fs.renameSync(replacement, options.path);
          try {
            expect(() => reader.assertCurrent()).toThrow("physical source changed");
            expect(() => first.assertCurrent()).toThrow("revoked");
          } finally {
            fs.renameSync(options.path, replacement);
            fs.renameSync(old, options.path);
          }
        },
      );
      await expect(pending).rejects.toThrow("revoked");
    });
  },
  10_000,
);
