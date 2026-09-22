import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import * as entryStore from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { readGatewayAccessRevision } from "../gateway-access-revision.js";
import * as groups from "../session-groups.js";
import { testState } from "../test-helpers.runtime-state.js";
import {
  directSessionReq,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";
import * as sessionEvents from "./session-change-event.js";
import { sessionLog } from "./sessions-shared.js";

const { createSessionStoreDir, createSelectedGlobalSessionStore } =
  setupGatewaySessionsHandlerTestHarness();
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  vi.restoreAllMocks();
});

function observeCatalogInvalidationScope() {
  const effects: Array<{ allRows: number; accessRevisionDelta: number }> = [];
  const emit = sessionEvents.emitSessionsChanged;
  vi.spyOn(sessionEvents, "emitSessionsChanged").mockImplementation((...args) => {
    if (args[1].reason !== "groups") {
      return emit(...args);
    }
    // Observe the real owner, isolating catalog effects from legitimate row publication.
    const before = readGatewayAccessRevision();
    let allRows = 0;
    const unsubscribe = sessionChanges.subscribe((change) => {
      if ("all" in change) {
        allRows += 1;
      }
    });
    try {
      emit(...args);
    } finally {
      unsubscribe();
      effects.push({ allRows, accessRevisionDelta: readGatewayAccessRevision() - before });
    }
  });
  return effects;
}

test("creates and patches first-use groups before publishing their invalidation", async () => {
  await createSessionStoreDir();
  const catalogEffects = observeCatalogInvalidationScope();
  const observedGroups: string[][] = [];
  const context = {
    getSessionEventSubscriberConnIds: () => new Set(["group-observer"]),
    broadcastToConnIds: (_event: string, payload: { reason?: string }) => {
      if (payload.reason === "groups") {
        observedGroups.push(groups.listSessionGroups().map(({ name }) => name));
      }
    },
  };
  const key = "agent:main:dashboard:group-publication";
  const created = await directSessionReq(
    "sessions.create",
    { agentId: "main", key, category: "Created" },
    { context },
  );
  expect(created.ok).toBe(true);
  expect(observedGroups).toEqual([expect.arrayContaining(["Created"])]);

  const patched = await directSessionReq(
    "sessions.patch",
    { key, category: "Patched" },
    { context },
  );
  expect(patched.ok).toBe(true);
  expect(observedGroups).toEqual([
    expect.arrayContaining(["Created"]),
    expect.arrayContaining(["Created", "Patched"]),
  ]);
  expect(
    (await directSessionReq("sessions.patch", { key, category: "Patched" }, { context })).ok,
  ).toBe(true);
  expect(observedGroups).toHaveLength(2);
  expect(catalogEffects).toEqual([
    { allRows: 0, accessRevisionDelta: 0 },
    { allRows: 0, accessRevisionDelta: 0 },
  ]);
});

test("joins rejected post-commit group registration before reporting durable create success", async () => {
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:dashboard:group-warning";
  const entered = createDeferredCore();
  const registration = createDeferredCore<boolean>();
  let registering = false;
  vi.spyOn(groups, "ensureSessionGroupRegistered").mockImplementation(() => {
    registering = true;
    entered.resolve();
    return registration.promise;
  });
  const warn = vi.spyOn(sessionLog, "warn").mockImplementation(() => {});
  let replied = false;
  const creating = directSessionReq(
    "sessions.create",
    { agentId: "main", key, category: "Retained" },
    {
      coercePayload: (payload) => {
        replied = true;
        return payload;
      },
    },
  );
  try {
    await Promise.race([
      entered.promise,
      creating.then(() => {
        throw new Error("create finished before category registration");
      }),
    ]);
    expect(loadSessionEntry({ agentId: "main", storePath, sessionKey: key })?.category).toBe(
      "Retained",
    );
    expect(replied).toBe(false);
  } finally {
    if (registering) {
      registration.reject(new Error("registration unavailable"));
    } else {
      registration.resolve(false);
    }
    await creating;
  }
  expect((await creating).ok).toBe(true);
  expect(loadSessionEntry({ agentId: "main", storePath, sessionKey: key })?.category).toBe(
    "Retained",
  );
  expect(warn).toHaveBeenCalledWith(
    "failed to register created session category: registration unavailable",
  );
});

// Kept baseline-applicable: the spy forwards the owner's actual arguments rather
// than depending on the new retained-source API.
test.each(["create", "patch"] as const)(
  "%s registration retains the physical writer ahead of group deletion without resurrection",
  async (method) => {
    const { storePath } = await createSessionStoreDir();
    const key = `agent:main:dashboard:category-delete-${method}`;
    expect((await directSessionReq("sessions.groups.put", { names: ["Race"] })).ok).toBe(true);
    if (method === "patch") {
      expect((await directSessionReq("sessions.create", { agentId: "main", key })).ok).toBe(true);
    }
    const register = groups.ensureSessionGroupRegistered;
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const deleteAdmitted = createDeferredCore();
    const order: string[] = [];
    vi.spyOn(groups, "ensureSessionGroupRegistered").mockImplementation(async (...args) => {
      entered.resolve();
      await resume.promise;
      const result = await register(...args);
      order.push("registration");
      return result;
    });
    const replace = sessionAccessor.applySessionEntryReplacements;
    vi.spyOn(sessionAccessor, "applySessionEntryReplacements").mockImplementation((params) => {
      const result = replace(params);
      deleteAdmitted.resolve();
      return result;
    });
    const mutation = directSessionReq(method === "create" ? "sessions.create" : "sessions.patch", {
      agentId: "main",
      key,
      category: "Race",
    });
    let deletion: ReturnType<typeof directSessionReq> | undefined;
    try {
      await Promise.race([
        entered.promise,
        mutation.then(() => {
          throw new Error("mutation did not reach registration");
        }),
      ]);
      deletion = directSessionReq("sessions.groups.delete", { name: "Race" }).then((result) => {
        order.push("deletion");
        return result;
      });
      await Promise.race([
        deleteAdmitted.promise,
        deletion.then(() => {
          throw new Error("delete did not reach the physical writer");
        }),
      ]);
      await nextTurn();
      expect(sessionAccessor.loadSessionEntry({ storePath, sessionKey: key })?.category).toBe(
        "Race",
      );
      expect(order).toEqual([]);
    } finally {
      resume.resolve();
      await Promise.allSettled([mutation, ...(deletion ? [deletion] : [])]);
    }
    expect((await mutation).ok).toBe(true);
    expect((await deletion)?.ok).toBe(true);
    expect(order).toEqual(["registration", "deletion"]);
    expect(
      sessionAccessor.loadSessionEntry({ storePath, sessionKey: key })?.category,
    ).toBeUndefined();
    expect(groups.listSessionGroups()).toEqual([]);
    await closeOpenClawStateDatabaseAsync();
    expect(groups.listSessionGroups()).toEqual([]);
  },
);

test.each(["create", "patch"] as const)(
  "%s preserves its one durable session write when registration rolls back, and a repeated patch repairs it",
  async (method) => {
    const { storePath } = await createSessionStoreDir();
    const key = `agent:main:dashboard:registration-rollback-${method}`;
    if (method === "patch") {
      expect((await directSessionReq("sessions.create", { agentId: "main", key })).ok).toBe(true);
    }
    const events: string[] = [];
    const context = {
      getSessionEventSubscriberConnIds: () => new Set(["observer"]),
      broadcastToConnIds: (_event: string, payload: { reason?: string }) => {
        if (payload.reason) {
          events.push(payload.reason);
        }
      },
    };
    const warn = vi.spyOn(sessionLog, "warn").mockImplementation(() => {});
    const writeEntry = vi.spyOn(entryStore, "writeSessionEntry");
    const register = groups.ensureSessionGroupRegistered;
    const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    const stages: string[] = [];
    vi.spyOn(groups, "ensureSessionGroupRegistered").mockImplementationOnce(async (...args) => {
      const spy = vi
        .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
        .mockImplementation((admit) =>
          createAdmission((request, grant) => {
            stages.push(request.stage);
            if (request.stage === "commit") {
              throw new Error("catalog commit revoked");
            }
            admit(request, grant);
          }),
        );
      try {
        return await register(...args);
      } finally {
        spy.mockRestore();
      }
    });
    const result = await directSessionReq(
      method === "create" ? "sessions.create" : "sessions.patch",
      { agentId: "main", key, category: "Retained" },
      { context },
    );
    expect(result.ok).toBe(true);
    expect(stages).toEqual(["transaction", "commit"]);
    expect(loadSessionEntry({ storePath, sessionKey: key })?.category).toBe("Retained");
    expect(writeEntry.mock.calls.filter(([, sessionKey]) => sessionKey === key)).toHaveLength(1);
    expect(groups.listSessionGroups()).toEqual([]);
    // Registration rejection invalidates the catalog conservatively, not as a commit claim.
    expect(events.filter((reason) => reason === "groups")).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("catalog commit revoked"));
    expect(
      (await directSessionReq("sessions.patch", { key, category: "Retained" }, { context })).ok,
    ).toBe(true);
    expect(groups.listSessionGroups()).toEqual([{ name: "Retained", position: 0 }]);
    expect(events.filter((reason) => reason === "groups")).toHaveLength(2);
  },
);

test.each(["create", "patch"] as const)(
  "%s never registers or publishes a group after the physical session transaction rolls back",
  async (method) => {
    const { storePath } = await createSessionStoreDir();
    const key = `agent:main:dashboard:session-rollback-${method}`;
    if (method === "patch") {
      expect((await directSessionReq("sessions.create", { agentId: "main", key })).ok).toBe(true);
    }
    const before = loadSessionEntry({ storePath, sessionKey: key });
    const writeEntry = entryStore.writeSessionEntry;
    const failure = new Error("session transaction rolled back");
    const write = vi.spyOn(entryStore, "writeSessionEntry").mockImplementation((...args) => {
      const result = writeEntry(...args);
      if (args[1] === key && args[2].category === "NeverCommitted") {
        throw failure;
      }
      return result;
    });
    const registration = vi.spyOn(groups, "ensureSessionGroupRegistered");
    const events: string[] = [];
    const result = await directSessionReq(
      method === "create" ? "sessions.create" : "sessions.patch",
      { agentId: "main", key, category: "NeverCommitted" },
      {
        context: {
          getSessionEventSubscriberConnIds: () => new Set(["observer"]),
          broadcastToConnIds: (_event: string, payload: { reason?: string }) => {
            if (payload.reason) {
              events.push(payload.reason);
            }
          },
        },
      },
    ).catch((error: unknown) => {
      expect(error).toBe(failure);
      return { ok: false };
    });
    write.mockRestore();
    expect(result.ok).toBe(false);
    expect(loadSessionEntry({ storePath, sessionKey: key })).toEqual(before);
    expect(registration).not.toHaveBeenCalled();
    expect(groups.listSessionGroups()).toEqual([]);
    expect(events).not.toContain("groups");
  },
);

test("batch patch uses one global catalog across physical agent stores and publishes once", async () => {
  const { mainStorePath, workStorePath } = await createSelectedGlobalSessionStore();
  for (const agentId of ["main", "work"]) {
    expect((await directSessionReq("sessions.create", { key: "global", agentId })).ok).toBe(true);
  }
  const groupEvents: Array<{ reason?: string; agentId?: string }> = [];
  const context = {
    getSessionEventSubscriberConnIds: () => new Set(["observer"]),
    broadcastToConnIds: (_event: string, payload: { reason?: string; agentId?: string }) => {
      if (payload.reason === "groups") {
        groupEvents.push(payload);
      }
    },
  };
  const patch = {
    targets: [
      { key: "global", agentId: "main" },
      { key: "global", agentId: "work" },
    ],
    patch: { category: "Shared" },
  };
  expect((await directSessionReq("sessions.patchMany", patch, { context })).ok).toBe(true);
  expect(
    loadSessionEntry({ agentId: "main", storePath: mainStorePath, sessionKey: "global" })?.category,
  ).toBe("Shared");
  expect(
    loadSessionEntry({ agentId: "work", storePath: workStorePath, sessionKey: "global" })?.category,
  ).toBe("Shared");
  const listed = await directSessionReq<{ groups: Array<{ name: string; position: number }> }>(
    "sessions.groups.list",
    {},
  );
  expect(listed.payload?.groups).toEqual([{ name: "Shared", position: 0 }]);
  expect(groupEvents).toHaveLength(1);
  expect(groupEvents[0]?.agentId).toBeUndefined();
  expect((await directSessionReq("sessions.patchMany", patch, { context })).ok).toBe(true);
  expect(groupEvents).toHaveLength(1);
});

test.each(["create", "patch"] as const)(
  "%s reloads the global catalog when source retirement follows a granted registration commit",
  async (method) => {
    const { storePath } = await createSessionStoreDir();
    const catalogEffects = observeCatalogInvalidationScope();
    const key = `agent:main:dashboard:registration-settled-close-${method}`;
    if (method === "patch") {
      expect((await directSessionReq("sessions.create", { agentId: "main", key })).ok).toBe(true);
    }
    const observed: string[][] = [];
    const context = {
      getSessionEventSubscriberConnIds: () => new Set(["observer"]),
      broadcastToConnIds: (_event: string, payload: { reason?: string }) => {
        if (payload.reason === "groups") {
          observed.push(groups.listSessionGroups().map(({ name }) => name));
        }
      },
    };
    const warn = vi.spyOn(sessionLog, "warn").mockImplementation(() => {});
    const writeEntry = vi.spyOn(entryStore, "writeSessionEntry");
    const register = groups.ensureSessionGroupRegistered;
    const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    let closing: Promise<boolean> | undefined;
    vi.spyOn(groups, "ensureSessionGroupRegistered").mockImplementationOnce(async (...args) => {
      const physical = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" });
      const spy = vi
        .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
        .mockImplementation((admit) =>
          createAdmission((request, grant) => {
            // Use the real grant. Retirement after it cannot undo the admitted COMMIT.
            admit(request, grant);
            if (request.stage === "commit") {
              closing = closeOpenClawAgentDatabaseByPathAsync(physical.path, "main");
            }
          }),
        );
      try {
        return await register(...args);
      } finally {
        spy.mockRestore();
      }
    });
    try {
      const result = await directSessionReq(
        method === "create" ? "sessions.create" : "sessions.patch",
        { agentId: "main", key, category: "Durable" },
        { context },
      );
      expect(result.ok).toBe(true);
    } finally {
      await closing;
    }
    expect(closing).toBeDefined();
    expect(writeEntry.mock.calls.filter(([, sessionKey]) => sessionKey === key)).toHaveLength(1);
    expect(loadSessionEntry({ storePath, sessionKey: key })?.category).toBe("Durable");
    expect(groups.listSessionGroups()).toEqual([{ name: "Durable", position: 0 }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no longer current"));
    await closeOpenClawStateDatabaseAsync();
    expect(groups.listSessionGroups()).toEqual([{ name: "Durable", position: 0 }]);
    expect(observed).toEqual([["Durable"]]);
    expect(catalogEffects).toEqual([{ allRows: 0, accessRevisionDelta: 0 }]);
  },
);

test("reset-main preserves its category without registering an unapplied category request", async () => {
  testState.sessionConfig = { dmScope: "main" };
  const { storePath } = await createSessionStoreDir();
  const created = await directSessionReq<{ key: string; sessionId: string }>("sessions.create", {
    agentId: "main",
    key: "main",
    category: "Original",
  });
  expect(created.ok).toBe(true);
  const beforeRevision = loadSessionEntry({
    storePath,
    sessionKey: "agent:main:main",
  })?.lifecycleRevision;
  const reset = await directSessionReq<{
    key: string;
    sessionId: string;
    entry: { category?: string };
  }>("sessions.create", {
    agentId: "main",
    parentSessionKey: "main",
    emitCommandHooks: true,
    category: "UnusedRequest",
  });
  expect(reset.ok).toBe(true);
  expect(reset.payload?.key).toBe(created.payload?.key);
  expect(reset.payload?.sessionId).toBe(created.payload?.sessionId);
  expect(reset.payload?.entry.category).toBe("Original");
  expect(
    loadSessionEntry({ storePath, sessionKey: "agent:main:main" })?.lifecycleRevision,
  ).not.toBe(beforeRevision);
  expect(loadSessionEntry({ storePath, sessionKey: "agent:main:main" })?.category).toBe("Original");
  expect(groups.listSessionGroups()).toEqual([{ name: "Original", position: 0 }]);
});
