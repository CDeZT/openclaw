import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import { createSessionEntryWithTranscript } from "../config/sessions/session-accessor.entry-mutation.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.sqlite-entry.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { registerSessionGroupInDatabase } from "./session-group-registration.kernel.js";
import {
  ensureSessionGroupRegistered,
  listSessionGroups,
  putSessionGroups,
} from "./session-groups.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => {
  resetConfigRuntimeState();
  const cfg = { session: { maintenance: { mode: "warn" as const } } };
  setRuntimeConfigSnapshot(cfg, cfg);
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("session-group-registration-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  resetConfigRuntimeState();
});

function fixture(env = { OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR }) {
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  return {
    database,
    scope: {
      agentId: "main",
      env,
      storePath: database.path,
      sessionKey: "agent:main:registration",
    },
    entry: { sessionId: "registration", updatedAt: Date.now(), category: "Travel" },
  };
}

it("registers and deduplicates in global append order without host data SQL", async () => {
  const { scope, entry } = fixture();
  putSessionGroups({ cfg: {}, names: ["Work"], env: scope.env });
  await createSessionEntryWithTranscript(scope, () => ({ ok: true, entry }), {
    afterCommitted: async (_entry, source) => {
      const sql = observeHostDataSql(source.env);
      try {
        expect(await ensureSessionGroupRegistered("  Travel  ", source)).toBe(true);
        expect(await ensureSessionGroupRegistered("Travel", source)).toBe(false);
        expect(await ensureSessionGroupRegistered("   ", source)).toBe(false);
        expect(sql.calls.map((call) => call.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
      } finally {
        sql.restore();
      }
    },
  });
  expect(listSessionGroups(scope.env)).toEqual([
    { name: "Work", position: 0 },
    { name: "Travel", position: 1 },
  ]);
  await closeOpenClawStateDatabaseAsync();
  expect(listSessionGroups(scope.env)).toEqual([
    { name: "Work", position: 0 },
    { name: "Travel", position: 1 },
  ]);
});

it("keeps the explicit captured environment and overlapping registration order", async () => {
  const originalRoot = tempDirs.make("session-group-explicit-source-");
  const { scope, entry } = fixture({ OPENCLAW_STATE_DIR: originalRoot });
  const redirectedRoot = path.join(originalRoot, "redirected");
  await createSessionEntryWithTranscript(scope, () => ({ ok: true, entry }), {
    afterCommitted: async (_entry, source) => {
      const registrations = ["First", "Second", "First"].map((name) =>
        ensureSessionGroupRegistered(name, source),
      );
      scope.env.OPENCLAW_STATE_DIR = redirectedRoot;
      vi.stubEnv("OPENCLAW_STATE_DIR", redirectedRoot);
      expect(await Promise.all(registrations)).toEqual([true, true, false]);
    },
  });
  expect(listSessionGroups({ OPENCLAW_STATE_DIR: originalRoot })).toEqual([
    { name: "First", position: 0 },
    { name: "Second", position: 1 },
  ]);
  await expect(fs.stat(redirectedRoot)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["transaction", "commit"] as const)(
  "rolls back registration when physical authority is lost at worker %s admission",
  async (stage) => {
    const { database, scope, entry } = fixture();
    // Open the schema before instrumenting admission; the test targets domain SQL.
    putSessionGroups({ cfg: {}, names: ["Work"], env: scope.env });
    let closing: Promise<boolean> | undefined;
    const stages: string[] = [];
    const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    try {
      await createSessionEntryWithTranscript(scope, () => ({ ok: true, entry }), {
        afterCommitted: async (_entry, source) => {
          const spy = vi
            .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
            .mockImplementation((admit) =>
              createAdmission((request, grant) => {
                stages.push(request.stage);
                if (request.stage === stage) {
                  closing = closeOpenClawAgentDatabaseByPathAsync(database.path, "main");
                }
                admit(request, grant);
              }),
            );
          try {
            await expect(ensureSessionGroupRegistered("Travel", source)).rejects.toThrow(
              "no longer current",
            );
          } finally {
            spy.mockRestore();
          }
        },
      });
    } finally {
      await closing;
    }
    expect(stages).toContain(stage);
    expect(closing).toBeDefined();
    expect(database.db.isOpen).toBe(false);
    expect(loadSessionEntryReadOnly(scope)?.category).toBe("Travel");
    expect(listSessionGroups(scope.env)).toEqual([{ name: "Work", position: 0 }]);
    await closeOpenClawStateDatabaseAsync();
    expect(listSessionGroups(scope.env)).toEqual([{ name: "Work", position: 0 }]);
  },
);

it("runs admission inside the synchronous transaction and rolls back its tentative insert", () => {
  const env = { OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR };
  const database = openOpenClawStateDatabase({ env });
  const stages: string[] = [];
  expect(() =>
    registerSessionGroupInDatabase(database, "Travel", env, (stage) => {
      expect(database.db.isTransaction).toBe(true);
      stages.push(stage);
      if (stage === "commit") {
        expect(listSessionGroups(env)).toEqual([{ name: "Travel", position: 0 }]);
        throw new Error("revoked before commit");
      }
    }),
  ).toThrow("revoked before commit");
  expect(stages).toEqual(["transaction", "commit"]);
  expect(listSessionGroups(env)).toEqual([]);
  expect(registerSessionGroupInDatabase(database, "Travel", env)).toBe(true);
  const refuse = vi.fn(() => {
    throw new Error("must not admit an existing-name write");
  });
  expect(registerSessionGroupInDatabase(database, "Travel", env, refuse)).toBe(false);
  expect(refuse).not.toHaveBeenCalled();
});
