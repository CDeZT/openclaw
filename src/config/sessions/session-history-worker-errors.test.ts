import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { SessionMetadataUnavailableError } from "../../state/openclaw-agent-db-read-error.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import * as exactRowReader from "./session-accessor.sqlite-exact-read.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";
import { SessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import { SessionTranscriptReadFenceError } from "./session-transcript-read-fence.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import type {
  SessionRowEntryWorkerInput,
  SessionTranscriptWorkerReply,
} from "./session-transcript-worker.types.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

type Request = {
  input: unknown;
  taskId: number;
  nativeSections: SharedArrayBuffer;
};
type Resource = { close: () => Promise<void>; revoke: () => void };
const observed = vi.hoisted(() => ({
  handler: undefined as ((input: unknown) => unknown) | undefined,
  receive: undefined as ((message: Request) => void) | undefined,
  post: vi.fn<(message: unknown) => void>(),
  read: vi.fn<
    typeof import("./session-accessor.sqlite-entry.js").loadSessionEntryReadOnlyInScope
  >(),
  exactRead:
    vi.fn<
      typeof import("./session-accessor.sqlite-exact-read.js").readExactSessionEntryFromSourceReadOnly
    >(),
  list: vi.fn(() => {
    throw new Error("Broad session enumeration is forbidden in exact-row controls");
  }),
  scopeRun: vi.fn<(database: unknown) => void>(),
  close: vi.fn<() => void>(),
  run: vi.fn<(input: unknown) => Promise<unknown>>(),
  rotate: vi.fn<() => Promise<void>>(),
  unregister: vi.fn<() => void>(),
  resources: [] as Resource[],
  nativeWorker: vi.fn(() => {
    throw new Error("Native workers are forbidden in these pure controls");
  }),
}));

vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: observed.nativeWorker,
  parentPort: {
    on: (_event: string, receive: (message: Request) => void) => {
      observed.receive = receive;
    },
    postMessage: (message: unknown) => observed.post(message),
  },
}));
vi.mock("../../infra/runtime-worker-url.js", () => ({
  resolveRuntimeWorkerUrl: () => new URL("file:///synthetic/session-history.worker.mjs"),
  resolveRuntimeWorkerArgv: () => [],
  resolveRuntimeWorkerThreadExecArgv: () => [],
}));
vi.mock("../../infra/worker-task-pool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/worker-task-pool.js")>();
  return {
    ...actual,
    WorkerTaskPool: class {
      run(prepare: () => unknown) {
        return observed.run(prepare());
      }
      rotate() {
        return observed.rotate();
      }
    },
  };
});
vi.mock("../../infra/worker-task-server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/worker-task-server.js")>();
  return {
    ...actual,
    serveWorkerTasks: (handler: (input: unknown) => unknown) => {
      observed.handler = handler;
      actual.serveWorkerTasks(handler);
    },
  };
});
vi.mock("../../state/openclaw-agent-db-resources.js", () => ({
  registerOpenClawAgentDatabaseAsyncResource: (resource: Resource) => {
    observed.resources.push(resource);
    return observed.unregister;
  },
}));
vi.mock("../../state/openclaw-agent-db-readonly-scope.js", () => ({
  OpenClawAgentDatabaseReadOnlyScope: class {
    hasRetainedConnection = true;
    run(database: unknown, operation: () => unknown) {
      observed.scopeRun(database);
      return operation();
    }
    close() {
      observed.close();
    }
  },
}));
vi.mock("./session-accessor.sqlite-entry.js", () => ({
  loadSessionEntryReadOnlyInScope: observed.read,
  listSessionEntriesReadOnly: observed.list,
}));
vi.mock("./session-sharing-store.js", () => ({
  listSessionMembers: () => {
    throw new Error("Native membership reads are forbidden in these pure controls");
  },
}));

await import("./session-transcript.worker.js");
let sequence = 0;
function input() {
  const database = { agentId: "main", path: `/synthetic/session-read-errors-${++sequence}.sqlite` };
  return {
    kind: "session-row-presence",
    database,
    scope: {
      agentId: "main",
      databaseAgentId: "main",
      sessionKey: "agent:main:errors",
      storePath: database.path,
    },
  };
}
function entryInput(): SessionRowEntryWorkerInput {
  const database = {
    agentId: "store-owner",
    path: `/synthetic/session-entry-${++sequence}.sqlite`,
  };
  return {
    kind: "session-row-entry",
    database,
    scope: {
      agentId: "main",
      databaseAgentId: database.agentId,
      sessionKey: "agent:main:entry",
      storePath: database.path,
      env: { OPENCLAW_STATE_DIR: "/synthetic/source" },
    },
  };
}
function invoke(request: ReturnType<typeof input> | SessionRowEntryWorkerInput) {
  assert(observed.handler);
  return Promise.resolve(observed.handler(request));
}

function readPhysicalEntry(scope: SessionRowEntryWorkerInput["scope"]) {
  return withSessionHistoryWorkerDatabase(
    { agentId: scope.databaseAgentId, path: scope.storePath, env: scope.env },
    (owner) => owner.readEntry(scope),
  );
}

const ROW_IDENTITY = {
  identity: "physical-fixture",
  incarnation: "connection-fixture",
  birthtime: "1",
};
let restoreExactRead = () => {};
beforeEach(() => {
  observed.exactRead.mockReset();
  const exact = vi
    .spyOn(exactRowReader, "readExactSessionEntryFromSourceReadOnly")
    .mockImplementation(observed.exactRead);
  restoreExactRead = () => exact.mockRestore();
  observed.post.mockReset();
  observed.read.mockReset();
  observed.list.mockClear();
  observed.scopeRun.mockClear();
  observed.close.mockReset();
  observed.run.mockReset();
  observed.rotate.mockReset().mockResolvedValue(undefined);
  observed.unregister.mockReset();
});
afterEach(async () => {
  observed.rotate.mockResolvedValue(undefined);
  await Promise.all(observed.resources.splice(0).map((resource) => resource.close()));
  expect(observed.nativeWorker).not.toHaveBeenCalled();
  restoreExactRead();
});

it("preserves the original worker read error when closing succeeds", async () => {
  const primary = new Error("read failed");
  observed.read.mockImplementation(() => {
    throw primary;
  });
  await expect(invoke(input())).rejects.toBe(primary);
  expect(observed.close).toHaveBeenCalledTimes(1);
});

it("retains both worker errors locally when the read and close fail", async () => {
  const primary = new Error("read failed");
  const cleanup = new Error("database close failed");
  observed.read.mockImplementation(() => {
    throw primary;
  });
  observed.close.mockImplementation(() => {
    throw cleanup;
  });
  const failure: unknown = await invoke(input()).catch((error: unknown) => error);
  assert(failure instanceof AggregateError);
  expect(failure.errors).toEqual([primary, cleanup]);
  expect(failure.cause).toBe(cleanup);
  expect(failure.message).toContain(primary.message);
  expect(failure.message).toContain(cleanup.message);
});

const typedFailures = [
  {
    error: new SessionTranscriptColdError("cold-session"),
    reply: { kind: "cold", sessionId: "cold-session" },
  },
  {
    error: new SessionTranscriptProjectionUnavailableError("projected-session"),
    reply: { kind: "projection", sessionId: "projected-session" },
  },
  {
    error: new SessionTranscriptReadFenceError("fence failed"),
    reply: { kind: "fence", message: "fence failed" },
  },
];
it.each(typedFailures)(
  "keeps typed $reply.kind recovery when closing succeeds",
  async ({ error, reply }) => {
    observed.read.mockImplementation(() => {
      throw error;
    });
    await expect(invoke(input())).resolves.toEqual({ ok: false, error: reply });
    expect(observed.close).toHaveBeenCalledTimes(1);
  },
);
it.each(typedFailures)(
  "does not recover typed $reply.kind reads when close also fails",
  async ({ error }) => {
    const cleanup = new Error("close failed");
    observed.read.mockImplementation(() => {
      throw error;
    });
    observed.close.mockImplementation(() => {
      throw cleanup;
    });
    const failure: unknown = await invoke(input()).catch((caught: unknown) => caught);
    assert(failure instanceof AggregateError);
    expect(failure.errors).toEqual([error, cleanup]);
  },
);

it("carries both failure messages through the existing worker response", async () => {
  const primary = new Error("primary read detail");
  const cleanup = new Error("close detail");
  observed.read.mockImplementation(() => {
    throw primary;
  });
  observed.close.mockImplementation(() => {
    throw cleanup;
  });
  const posted = createDeferredCore<unknown>();
  observed.post.mockImplementation(posted.resolve);
  assert(observed.receive);
  observed.receive({ input: input(), taskId: 7, nativeSections: new SharedArrayBuffer(4) });
  const reply = await posted.promise;
  expect(reply).toEqual({
    status: "failed",
    taskId: 7,
    error: expect.stringContaining(primary.message),
  });
  expect(reply).toMatchObject({ error: expect.stringContaining(cleanup.message) });
});

it("retires idle history workers under critical pressure after active scopes release custody", async () => {
  const pressure = channel("openclaw.memory.critical");
  const request = input();
  const retirement = createDeferredCore();
  const unregistered = createDeferredCore();
  observed.run.mockResolvedValue({ ok: true, value: false });
  observed.rotate.mockReturnValue(retirement.promise);
  observed.unregister.mockImplementation(unregistered.resolve);
  await withSessionHistoryWorkerDatabase(request.database, async (owner) => {
    expect(await owner.readEntryPresence(request.scope)).toBe(false);
    pressure.publish(undefined);
    expect(observed.rotate).not.toHaveBeenCalled();
  });

  pressure.publish(undefined);
  expect(observed.rotate).toHaveBeenCalledTimes(1);
  expect(observed.unregister).not.toHaveBeenCalled();
  pressure.publish(undefined);
  expect(observed.rotate).toHaveBeenCalledTimes(1);
  retirement.resolve();
  await unregistered.promise;
  expect(observed.unregister).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  "awaits retirement and preserves both failures when retirement fails=%s",
  async (fails) => {
    const primary = new WorkerTaskError("worker response failed", "failed");
    const cleanup = new Error("retirement failed");
    const entered = createDeferredCore();
    const retirement = createDeferredCore();
    observed.run.mockRejectedValue(primary);
    observed.rotate.mockImplementation(() => {
      entered.resolve();
      return retirement.promise;
    });
    const request = input();
    let settled = false;
    const pending = withSessionHistoryWorkerDatabase(request.database, (owner) =>
      owner.readEntryPresence(request.scope),
    )
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    await entered.promise;
    expect(settled).toBe(false);
    expect(observed.unregister).not.toHaveBeenCalled();
    if (fails) {
      retirement.reject(cleanup);
    } else {
      retirement.resolve();
    }
    const failure: unknown = await pending;
    if (fails) {
      assert(failure instanceof AggregateError);
      expect(failure.errors).toEqual([primary, cleanup]);
      expect(failure.cause).toBe(cleanup);
      expect(failure.message).toContain(primary.message);
      expect(failure.message).toContain(cleanup.message);
      expect(observed.unregister).not.toHaveBeenCalled();
    } else {
      expect(failure).toBe(primary);
      expect(observed.unregister).toHaveBeenCalledTimes(1);
    }
  },
);

it.each(typedFailures)(
  "preserves typed $reply.kind errors after successful parent retirement",
  async ({ error, reply }) => {
    observed.run.mockResolvedValue({ ok: false, error: reply });
    const request = input();
    const failure: unknown = await withSessionHistoryWorkerDatabase(request.database, (owner) =>
      owner.readEntryPresence(request.scope),
    ).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(error.constructor);
    expect(failure).toMatchObject({ message: error.message });
    expect(observed.rotate).toHaveBeenCalledTimes(1);
  },
);

it("reads one full entry inside the exact physical owner without enumerating", async () => {
  const request = entryInput();
  const entry: SessionEntry = {
    sessionId: "requester-incarnation",
    lifecycleRevision: "revision-1",
    updatedAt: 1,
    restartRecoveryDeliveryRunId: "recovery-successor",
    restartRecoveryDeliverySourceRunId: "original-source",
  };
  observed.exactRead.mockReturnValue({ entry, identity: ROW_IDENTITY });
  await expect(invoke(request)).resolves.toEqual({
    ok: true,
    value: { kind: "session-row-entry", entry, identity: ROW_IDENTITY, facts: null },
  });
  expect(observed.scopeRun).toHaveBeenCalledWith(request.database);
  expect(observed.exactRead).toHaveBeenCalledExactlyOnceWith({
    readSource: request.database,
    sessionKey: request.scope.sessionKey,
    env: request.scope.env,
    continuation: undefined,
    expectedIdentity: undefined,
  });
  expect(observed.list).not.toHaveBeenCalled();
});

it("returns a tagged missing exact entry without inventing an empty session", async () => {
  observed.exactRead.mockReturnValue(undefined);
  await expect(invoke(entryInput())).resolves.toEqual({
    ok: true,
    value: { kind: "session-row-entry", entry: undefined, identity: null, facts: null },
  });
  expect(observed.exactRead).toHaveBeenCalledOnce();
  expect(observed.list).not.toHaveBeenCalled();
});

it.each(["physical owner", "physical path", "incognito key", "incognito path"] as const)(
  "rejects a worker exact-entry request with a different %s before reading",
  async (mismatch) => {
    const request = entryInput();
    if (mismatch === "physical owner") {
      request.scope.databaseAgentId = "replacement";
    } else if (mismatch === "physical path") {
      request.scope.storePath = "/synthetic/replacement.sqlite";
    } else if (mismatch === "incognito key") {
      request.scope.sessionKey = "agent:main:dashboard:incognito-entry";
    } else {
      request.scope.storePath = resolveIncognitoOpenClawAgentSqlitePath({
        agentId: request.scope.agentId,
        env: request.scope.env,
      });
      request.database.path = request.scope.storePath;
    }
    await expect(invoke(request)).rejects.toThrow("retained durable owner");
    expect(observed.exactRead).not.toHaveBeenCalled();
    expect(observed.list).not.toHaveBeenCalled();
    expect(observed.scopeRun).not.toHaveBeenCalled();
  },
);

it("captures the prepared logical key, physical owner and environment before waiting", async () => {
  const request = entryInput();
  const capturedScope = structuredClone(request.scope);
  const reply = createDeferredCore<SessionTranscriptWorkerReply<"session-row-entry">>();
  const entry: SessionEntry = { sessionId: "captured-incarnation", updatedAt: 1 };
  observed.run.mockReturnValueOnce(reply.promise);
  const pending = readPhysicalEntry(request.scope);
  try {
    request.scope.sessionKey = "agent:main:replacement";
    request.scope.storePath = "/synthetic/replacement.sqlite";
    request.scope.databaseAgentId = "replacement";
    request.scope.env.OPENCLAW_STATE_DIR = "/synthetic/replacement";
    expect(observed.run).toHaveBeenCalledExactlyOnceWith({
      kind: "session-row-entry",
      database: request.database,
      scope: capturedScope,
      continuation: undefined,
      expectedIdentity: undefined,
    });
    reply.resolve({
      ok: true,
      value: { kind: "session-row-entry", entry, identity: ROW_IDENTITY },
    });
    await expect(pending).resolves.toEqual(entry);
    expect(observed.exactRead).not.toHaveBeenCalled();
    expect(observed.list).not.toHaveBeenCalled();
  } finally {
    reply.resolve({
      ok: true,
      value: { kind: "session-row-entry", entry, identity: ROW_IDENTITY },
    });
    await pending.catch(() => undefined);
  }
});

it.each(["physical owner", "physical path"] as const)(
  "refuses a readEntry %s mismatch before worker dispatch",
  async (mismatch) => {
    const request = entryInput();
    if (mismatch === "physical owner") {
      request.scope.databaseAgentId = "replacement";
    } else {
      request.scope.storePath = "/synthetic/replacement.sqlite";
    }
    await expect(
      withSessionHistoryWorkerDatabase(request.database, (owner) => owner.readEntry(request.scope)),
    ).rejects.toThrow("differs from its retained owner");
    expect(observed.run).not.toHaveBeenCalled();
    expect(observed.exactRead).not.toHaveBeenCalled();
  },
);

it.each(["key", "path"] as const)(
  "refuses an incognito %s before dispatch without a synchronous fallback",
  async (kind) => {
    const request = entryInput();
    if (kind === "key") {
      request.scope.sessionKey = "agent:main:dashboard:incognito-entry";
    } else {
      request.scope.storePath = resolveIncognitoOpenClawAgentSqlitePath({
        agentId: request.scope.agentId,
        env: request.scope.env,
      });
    }
    await expect(readPhysicalEntry(request.scope)).rejects.toThrow("native owner");
    expect(observed.run).not.toHaveBeenCalled();
    expect(observed.exactRead).not.toHaveBeenCalled();
    expect(observed.list).not.toHaveBeenCalled();
  },
);

it("rejects a revoked row reply and gives a replacement database a new generation", async () => {
  const request = entryInput();
  const reply = createDeferredCore<SessionTranscriptWorkerReply<"session-row-entry">>();
  const generations: number[] = [];
  observed.run.mockReturnValueOnce(reply.promise);
  const pending = withSessionHistoryWorkerDatabase(request.database, (owner) => {
    generations.push(owner.generation);
    return owner.readEntry(request.scope);
  });
  try {
    const resource = observed.resources.at(-1);
    assert(resource);
    resource.revoke();
    reply.resolve({
      ok: true,
      value: {
        kind: "session-row-entry",
        entry: { sessionId: "retired", updatedAt: 1 },
        identity: ROW_IDENTITY,
      },
    });
    await expect(pending).rejects.toThrow("revoked");
    const replacement: SessionEntry = { sessionId: "replacement", updatedAt: 2 };
    observed.run.mockResolvedValueOnce({
      ok: true,
      value: {
        kind: "session-row-entry",
        entry: replacement,
        identity: { ...ROW_IDENTITY, incarnation: "replacement" },
      },
    });
    await expect(
      withSessionHistoryWorkerDatabase(request.database, (owner) => {
        generations.push(owner.generation);
        return owner.readEntry(request.scope);
      }),
    ).resolves.toEqual(replacement);
    expect(generations).toHaveLength(2);
    const [retiredGeneration, replacementGeneration] = generations;
    assert(retiredGeneration !== undefined && replacementGeneration !== undefined);
    expect(replacementGeneration).toBeGreaterThan(retiredGeneration);
    expect(observed.rotate).toHaveBeenCalled();
    expect(observed.exactRead).not.toHaveBeenCalled();
  } finally {
    reply.resolve({
      ok: true,
      value: { kind: "session-row-entry", entry: undefined, identity: null },
    });
    await pending.catch(() => undefined);
  }
});

it.each([false, { kind: "session-entry-list", entries: [] }])(
  "refuses a non-entry worker reply instead of manufacturing a row (%j)",
  async (value) => {
    observed.run.mockResolvedValueOnce({ ok: true, value });
    await expect(readPhysicalEntry(entryInput().scope)).rejects.toThrow("instead of an entry");
    expect(observed.rotate).toHaveBeenCalledOnce();
  },
);

it("preserves exact-row read and retirement failures together", async () => {
  const primary = new WorkerTaskError("exact row failed", "failed");
  const cleanup = new Error("exact row retirement failed");
  observed.run.mockRejectedValueOnce(primary);
  observed.rotate.mockRejectedValueOnce(cleanup);
  const failure: unknown = await readPhysicalEntry(entryInput().scope).catch(
    (error: unknown) => error,
  );
  assert(failure instanceof AggregateError);
  expect(failure.errors).toEqual([primary, cleanup]);
  expect(failure.cause).toBe(cleanup);
});

it("does not report schema-unavailable exact reads as a successful missing row", async () => {
  const unavailable = new SessionMetadataUnavailableError("schema-missing");
  observed.exactRead.mockImplementation(() => {
    throw unavailable;
  });
  await expect(invoke(entryInput())).rejects.toBe(unavailable);
  expect(observed.close).toHaveBeenCalledOnce();
});

it("pins the first exact native identity for a later read on the same owner", async () => {
  const request = entryInput();
  observed.run.mockResolvedValue({
    ok: true,
    value: { kind: "session-row-entry", entry: undefined, identity: ROW_IDENTITY },
  });
  await withSessionHistoryWorkerDatabase(request.database, async (owner) => {
    await owner.readEntry(request.scope);
    await owner.readEntry(request.scope);
  });
  expect(observed.run.mock.calls[1]?.[0]).toMatchObject({ expectedIdentity: ROW_IDENTITY });
});

it("accepts a replacement read transport under the same retained physical source", async () => {
  const request = entryInput();
  const entry: SessionEntry = {
    sessionId: "same-source",
    lifecycleRevision: "same-revision",
    updatedAt: 1,
  };
  const recovered = { ...entry, updatedAt: 2, lastRunId: "recovered-run" };
  observed.run
    .mockResolvedValueOnce({
      ok: true,
      value: { kind: "session-row-entry", entry, identity: ROW_IDENTITY },
    })
    .mockResolvedValueOnce({
      ok: true,
      value: {
        kind: "session-row-entry",
        entry: recovered,
        identity: { ...ROW_IDENTITY, incarnation: "rotated-read-worker" },
      },
    });
  await expect(
    withSessionHistoryWorkerDatabase(request.database, async (owner) => {
      await owner.readEntry(request.scope);
      return await owner.readEntry(request.scope);
    }),
  ).resolves.toBe(recovered);
  expect(observed.run.mock.calls[1]?.[0]).toMatchObject({ expectedIdentity: ROW_IDENTITY });
});

it.each(["physical identity", "birthtime"] as const)(
  "refuses changed source %s even when the row has the same scalar identity",
  async (changed) => {
    const request = entryInput();
    const entry: SessionEntry = {
      sessionId: "copied-session",
      lifecycleRevision: "copied-revision",
      updatedAt: 1,
    };
    const replacement =
      changed === "physical identity"
        ? { ...ROW_IDENTITY, identity: "replacement-file" }
        : { ...ROW_IDENTITY, birthtime: "replacement-birthtime" };
    observed.run
      .mockResolvedValueOnce({
        ok: true,
        value: { kind: "session-row-entry", entry, identity: ROW_IDENTITY },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { kind: "session-row-entry", entry, identity: replacement },
      });
    await expect(
      withSessionHistoryWorkerDatabase(request.database, async (owner) => {
        await owner.readEntry(request.scope);
        return await owner.readEntry(request.scope);
      }),
    ).rejects.toThrow("source changed");
  },
);

it("revokes the lexical borrow while its cached native custody remains retained", async () => {
  const request = entryInput();
  observed.run.mockResolvedValue({
    ok: true,
    value: { kind: "session-row-entry", entry: undefined, identity: ROW_IDENTITY },
  });
  let escaped:
    | import("./session-transcript-worker.types.js").SessionHistoryWorkerDatabase
    | undefined;
  await withSessionHistoryWorkerDatabase(request.database, async (owner) => {
    escaped = owner;
    await owner.readEntry(request.scope);
  });
  expect(observed.rotate).not.toHaveBeenCalled();
  expect(observed.unregister).not.toHaveBeenCalled();
  expect(() => escaped?.assertCurrent()).toThrow("revoked");
  expect(() => escaped?.acceptedSource()).toThrow("revoked");
  await expect(escaped?.readEntry(request.scope)).rejects.toThrow("revoked");
  expect(observed.run).toHaveBeenCalledOnce();
});
