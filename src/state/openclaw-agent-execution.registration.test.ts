import type { DatabaseSync } from "node:sqlite";
import { serialize } from "node:v8";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  receiveSqliteWorkerReply,
  settleFailedSqliteWorkerJobs,
  settleSqliteWorkerJob,
} from "../infra/sqlite-worker-broker-reply.js";
import type { Job } from "../infra/sqlite-worker-broker.types.js";
import {
  SqliteWorkerError,
  type SqliteWorkerReply,
  type SqliteWorkerRequest,
} from "../infra/sqlite-worker-contract.js";
import type { acquireSqliteWorkerLifecycle } from "../infra/sqlite-worker-lifecycle-preparation.js";
import type { SqliteWorkerAdmissionRequest } from "../infra/sqlite-worker-operation-admission.js";
import { createSqliteWorkerTransferOwner } from "../infra/sqlite-worker-transfer.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import type {
  OpenClawAgentDatabaseRegistrationCommit,
  OpenClawAgentDatabaseRegistrationFacts,
} from "./openclaw-agent-db-contract.js";
import type { OpenClawAgentRegistrationTransactionOwner } from "./openclaw-agent-db-registry-listing.js";
import type { AgentDatabaseExecutionOpen } from "./openclaw-agent-execution-contract.js";

const edge = vi.hoisted(() => {
  const database = {
    agentId: "main",
    path: "/synthetic/agent.sqlite",
    db: { isOpen: true, isTransaction: false },
  };
  return {
    database,
    on: vi.fn(),
    publishReply: vi.fn(),
    open: vi.fn<
      (
        options: unknown,
        lease: unknown,
        committed?: (receipt: OpenClawAgentDatabaseRegistrationCommit) => void,
        registration?: OpenClawAgentRegistrationTransactionOwner,
      ) => typeof database
    >(),
    request: vi.fn<(request: SqliteWorkerAdmissionRequest) => void>(),
    effect:
      vi.fn<
        typeof import("../infra/sqlite-worker-operation-admission.js").deferSqliteWorkerCommitEffect
      >(),
    pendingEffect: undefined as unknown,
    committedEffects: [] as unknown[],
    nativeClose: vi.fn(() => {
      database.db.isOpen = false;
      return true;
    }),
    releaseAgent: vi.fn(),
    releaseShared: vi.fn(),
    acquireLifecycle: vi.fn<typeof acquireSqliteWorkerLifecycle>(),
    releaseLifecycle: vi.fn(),
    forbidden: vi.fn((): never => {
      throw new Error("Registration transport control crossed a native or process boundary");
    }),
  };
});

// The registered worker handler and backend execute; native opening and process custody are synthetic.
vi.mock("node:sqlite", () => ({ DatabaseSync: edge.forbidden }));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    parentPort: { on: edge.on, postMessage: edge.publishReply },
    isMainThread: false,
    threadId: 1,
    isMarkedAsUntransferable: actual.isMarkedAsUntransferable,
    Worker: edge.forbidden,
    MessageChannel: actual.MessageChannel,
    receiveMessageOnPort: actual.receiveMessageOnPort,
  };
});
vi.mock("node:child_process", () => ({
  spawn: edge.forbidden,
  spawnSync: edge.forbidden,
  execFile: edge.forbidden,
  execFileSync: edge.forbidden,
  fork: edge.forbidden,
}));
vi.mock("../infra/node-sqlite.js", () => ({ openNodeSqliteDatabase: edge.forbidden }));
vi.mock("../logging/console.js", () => ({ routeLogsToStderr() {} }));
vi.mock("../process/output-drain.js", () => ({ drainProcessOutput: (done: () => void) => done() }));
vi.mock("../infra/sqlite-worker-identity.js", () => ({
  assertExistingDatabaseIdentity() {},
  readDatabasePathIdentitySync: () => ({ key: "file:fixture" }),
}));
vi.mock("../infra/sqlite-worker-operation-admission.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../infra/sqlite-worker-operation-admission.js")>();
  return {
    ...actual,
    requestSqliteWorkerOperationAdmission: edge.request,
    deferSqliteWorkerCommitEffect: edge.effect,
    withSqliteWorkerOperationAdmission: edge.forbidden,
  };
});
vi.mock("../infra/sqlite-worker-broker-admission.js", () => ({
  releaseSqliteWorkerLifecycle() {},
}));
vi.mock("../infra/sqlite-worker-lifecycle-preparation.js", () => ({
  acquireSqliteWorkerLifecycle: edge.acquireLifecycle,
}));
vi.mock("./openclaw-agent-db.js", () => ({
  openOpenClawAgentDatabase: edge.open,
  getOpenClawAgentDatabaseIfOpen: () => edge.database,
}));
vi.mock("./openclaw-agent-db-identity.js", () => ({
  readOpenClawAgentDatabaseIdentity: () => ({
    identity: "fixture",
    incarnation: "fixture-incarnation",
    filename: edge.database.path,
  }),
}));
vi.mock("./openclaw-agent-db-lease.js", () => ({
  prepareOpenClawAgentDatabaseWorkerLease: () => ({
    receipt: {
      leaseId: "fixture",
      sharedStatePath: "/synthetic/state.sqlite",
      sharedStateIdentity: "file:state",
    },
  }),
}));
vi.mock("./openclaw-agent-db-lifecycle.js", () => ({
  closeOpenClawAgentDatabaseByPath: edge.nativeClose,
  retainAgentDatabase: () => edge.releaseAgent,
}));
vi.mock("./openclaw-state-db.js", () => ({ openOpenClawStateDatabase: () => ({}) }));
vi.mock("./openclaw-state-db-cache.js", () => ({
  requireOpenClawStateDatabaseIdentity: () => ({ key: "file:state" }),
  retainOpenClawStateDatabase: () => ({ release: edge.releaseShared }),
}));
vi.mock("./openclaw-state-worker-error.js", () => ({
  encodeOpenClawStateWorkerError: () => undefined,
  retainOpenClawStateWorkerErrorPayload: edge.forbidden,
}));

const input: AgentDatabaseExecutionOpen = {
  leaseId: "fixture",
  agentId: "main",
  databasePath: "/synthetic/agent.sqlite",
  stateDatabasePath: "/synthetic/state.sqlite",
  environment: { OPENCLAW_STATE_DIR: "/synthetic" },
};
const receipt: OpenClawAgentDatabaseRegistrationCommit = {
  agentId: input.agentId,
  agentPath: input.databasePath,
  stateDatabasePath: input.stateDatabasePath,
  stateDatabaseIdentity: "file:state",
};
const registrationFacts: OpenClawAgentDatabaseRegistrationFacts = {
  before: { agentId: input.agentId, path: input.databasePath, schemaVersion: 22 },
  after: { agentId: input.agentId, path: input.databasePath, schemaVersion: 22 },
  source: {
    agentId: input.agentId,
    path: input.databasePath,
    physicalIdentity: "fixture",
    birthtime: "1",
    userVersion: 22,
    schemaVersion: 22,
    role: "agent",
    schemaAgentId: input.agentId,
  },
};
function commitRegistration(owner: OpenClawAgentRegistrationTransactionOwner | undefined) {
  if (!owner) throw new Error("Missing canonical registration transaction owner");
  owner.classify(registrationFacts);
  // This existing transport fixture forbids SQLite; the effect recorder below is its explicit double.
  owner.prepareReceipt?.(edge.database.db as DatabaseSync, receipt, registrationFacts);
  owner.withCommit(() => edge.committedEffects.push(edge.pendingEffect));
}

const replies = new Map<number, Deferred<SqliteWorkerReply>>();
let receive: (request: SqliteWorkerRequest) => void;
let nextId = 0;
let actor = 0;
let nativeOpened = false;

function send(request: SqliteWorkerRequest): Promise<SqliteWorkerReply> {
  const response = createDeferredCore<SqliteWorkerReply>();
  replies.set(request.id, response);
  receive(request);
  return response.promise;
}

function retireFailedReply(
  reply: Extract<SqliteWorkerReply, { ok: false }>,
  request: SqliteWorkerRequest,
  admissionFailure?: unknown,
) {
  const retired = createDeferredCore();
  const completion = createDeferredCore<unknown>();
  const reject = vi.fn((error: unknown) => completion.resolve(error));
  const settleNative = vi.fn();
  const job: Job = {
    request,
    bytes: 0,
    nativeDispatched: true,
    operationAdmission: {
      admission: {
        get port(): MessagePort {
          return edge.forbidden();
        },
        failure: admissionFailure,
        cleanupFailures: [],
        committed: undefined,
        settlement: undefined,
        waitForSettlement: edge.forbidden,
        service: edge.forbidden,
        finish() {},
      },
      releaseService() {},
    },
    settleNative,
    resolve: edge.forbidden,
    reject,
    detach() {},
  };
  receiveSqliteWorkerReply({ current: job, worker: { postMessage: edge.forbidden } }, reply, {
    fail(error, currentError, completed, openOutcome) {
      if (!(error instanceof Error)) {
        throw error;
      }
      settleFailedSqliteWorkerJobs({
        current: job,
        queued: [],
        queuedError: new SqliteWorkerError("retired", "unavailable"),
        error,
        currentError,
        completed,
        openOutcome,
        retire: () => retired.promise,
        finish: settleSqliteWorkerJob,
      });
    },
    finish: edge.forbidden,
    dispatch: edge.forbidden,
  });
  return { retired, completion, reject, settleNative };
}

beforeAll(async () => {
  await import("../infra/sqlite-store.worker.js");
  const registration = edge.on.mock.calls.find(([event]) => event === "message");
  if (!registration || typeof registration[1] !== "function") {
    throw new Error("SQLite worker did not register its request handler");
  }
  receive = registration[1];
});

beforeEach(async () => {
  vi.clearAllMocks();
  nativeOpened = false;
  edge.pendingEffect = undefined;
  edge.committedEffects.length = 0;
  edge.effect.mockImplementation((_database, effect) => {
    edge.pendingEffect = effect;
  });
  edge.database.db.isOpen = true;
  edge.request.mockImplementation(() => {});
  edge.publishReply.mockImplementation((reply: SqliteWorkerReply) => {
    const pending = replies.get(reply.id);
    if (!pending) {
      throw new Error("SQLite worker replied outside an accepted operation");
    }
    replies.delete(reply.id);
    pending.resolve(reply);
  });
  actor += 1;
  expect(
    await send({
      id: ++nextId,
      actor,
      type: "open",
      moduleUrl: new URL("./openclaw-agent-execution.worker.ts", import.meta.url).href,
      databasePath: input.databasePath,
      existingIdentity: "file:fixture",
      input: serialize(input),
    }),
  ).toMatchObject({ ok: true });
});

afterEach(async () => {
  expect((await send({ id: ++nextId, actor, type: "close" })).ok).toBe(true);
  expect(edge.releaseShared).toHaveBeenCalledOnce();
  expect(edge.nativeClose).toHaveBeenCalledTimes(nativeOpened ? 1 : 0);
  expect(edge.releaseAgent).toHaveBeenCalledTimes(nativeOpened ? 1 : 0);
  expect(replies.size).toBe(0);
  expect(edge.forbidden).not.toHaveBeenCalled();
});

describe("committed agent registration across failed native opening", () => {
  it.each(["inline", "framed"] as const)(
    "retains the shared-state lifecycle location through %s command delivery",
    async (delivery) => {
      edge.open.mockImplementation((_options, _lease, _committed, registration) => {
        commitRegistration(registration);
        nativeOpened = true;
        return edge.database;
      });
      edge.acquireLifecycle.mockResolvedValue({
        coordinator: {
          path: "/synthetic/coordinator.sqlite",
          closed: false,
          release: edge.releaseLifecycle,
        },
        admission: undefined,
      });
      const { port1, port2 } = new MessageChannel();
      port1.on("message", (message: { type: "result"; reply: SqliteWorkerReply }) => {
        edge.publishReply(message.reply);
      });
      const transfer = createSqliteWorkerTransferOwner();
      const command = { type: "database.prepareWrite", input: undefined };
      const request = {
        id: ++nextId,
        actor,
        stateDatabasePath: input.stateDatabasePath,
        stateContext: {
          environment: input.environment,
          coordinatorRuntime: { directory: "/synthetic/coordinators", keepAlive: false },
        },
        workerStateLifecycle: { deadlineNs: process.hrtime.bigint() + 1_000_000_000n },
        lifecyclePreparation: port2,
      };
      try {
        let reply: SqliteWorkerReply;
        if (delivery === "inline") {
          reply = await send({ ...request, type: "execute", input: serialize(command) });
        } else {
          const handle = transfer.start([{ kind: "command", value: command }].values(), {
            kinds: ["command"],
          });
          reply = await send({ ...request, type: "execute-start", transfer: handle });
          expect(reply).toMatchObject({ ok: true, input: "next" });
          expect(edge.acquireLifecycle).not.toHaveBeenCalled();
          for (;;) {
            const frame = transfer.next(handle.id);
            reply = await send({
              id: request.id,
              actor,
              type: "execute-frame",
              input: serialize(frame),
            });
            if (frame.done) {
              transfer.end(handle.id);
              break;
            }
            expect(reply).toMatchObject({ ok: true, input: "next" });
          }
        }
        expect(reply).toMatchObject({ ok: true });
        expect(edge.acquireLifecycle).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ databasePath: input.stateDatabasePath }),
        );
        expect(edge.open).toHaveBeenCalledOnce();
        expect(edge.releaseLifecycle).toHaveBeenCalledOnce();
      } finally {
        transfer.close();
        port1.close();
        port2.close();
      }
    },
  );

  it.each([
    { name: "failed open", openingSucceeds: false, reportRefused: false },
    { name: "failed open and native retirement", openingSucceeds: false, reportRefused: true },
    {
      name: "successful open with refused native identity publication",
      openingSucceeds: true,
      reportRefused: true,
    },
  ])(
    "reports the COMMIT and joins retirement after $name",
    async ({ openingSucceeds, reportRefused }) => {
      const openingError = new Error("Validation publication failed after registration COMMIT");
      const reportingError = new Error(
        "Original caller retired before native identity publication",
      );
      const retirementError = new Error("Native retirement failed after committed registration");
      edge.open.mockImplementation((_options, _lease, _committed, registration) => {
        commitRegistration(registration);
        if (openingSucceeds) {
          nativeOpened = true;
          return edge.database;
        }
        throw openingError;
      });
      edge.request.mockImplementation((request) => {
        if (
          reportRefused &&
          request.stage === "prepare" &&
          request.facts &&
          typeof request.facts === "object" &&
          "identity" in request.facts &&
          !("kind" in request.facts)
        ) {
          throw reportingError;
        }
      });
      const reply = await send({
        id: ++nextId,
        actor,
        type: "execute",
        input: serialize({ type: "database.prepareWrite", input: undefined }),
      });
      const selectorRequest = edge.request.mock.calls.find(
        ([request]) => request.stage === "transaction",
      )?.[0];
      expect(selectorRequest?.facts).toMatchObject({
        kind: "agent-registration-selector",
        registration: registrationFacts,
      });
      if (
        !selectorRequest ||
        !selectorRequest.facts ||
        typeof selectorRequest.facts !== "object" ||
        !("binding" in selectorRequest.facts)
      )
        throw new Error("Missing operation-local binding");
      expect(selectorRequest.facts.binding).toEqual({
        intentId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        ),
        leaseId: input.leaseId,
        agentId: input.agentId,
        agentPath: input.databasePath,
        stateDatabasePath: input.stateDatabasePath,
        stateDatabaseIdentity: "file:state",
      });
      expect(edge.committedEffects).toEqual([
        {
          kind: "agent-registration",
          binding: selectorRequest.facts.binding,
          receipt,
          registration: registrationFacts,
        },
      ]);
      expect(
        edge.request.mock.calls.some(
          ([request]) =>
            request.stage === "prepare" &&
            request.facts &&
            typeof request.facts === "object" &&
            "kind" in request.facts &&
            request.facts.kind === "agent-registration-committed",
        ),
      ).toBe(false);
      expect(reply.ok).toBe(false);
      if (reply.ok) {
        throw new Error("Failed native opening unexpectedly succeeded");
      }
      if (!openingSucceeds) {
        expect(reply.error.message).toContain(openingError.message);
      }
      if (reportRefused && openingSucceeds) {
        expect(reply.error.message).toContain(reportingError.message);
      }
      expect(reply.retire).toBe(true);

      const { retired, completion, reject, settleNative } = retireFailedReply(
        reply,
        { type: "execute", id: reply.id, actor, input: new Uint8Array() },
        reportRefused && openingSucceeds ? reportingError : undefined,
      );
      expect(reject).not.toHaveBeenCalled();
      expect(settleNative).not.toHaveBeenCalled();
      if (!openingSucceeds && reportRefused) retired.reject(retirementError);
      else retired.resolve();
      const failure = await completion.promise;
      expect(failure).toMatchObject({ code: "outcome-unknown" });
      if (!openingSucceeds && !reportRefused) {
        expect(String(failure)).toContain(openingError.message);
      }
      if (reportRefused && openingSucceeds) {
        expect(String(failure)).toContain(reportingError.message);
      }
      if (!openingSucceeds && reportRefused) {
        expect(failure).toBeInstanceOf(AggregateError);
        if (!(failure instanceof AggregateError))
          throw new Error("Expected retained cleanup aggregation");
        const failures = failure.errors;
        expect(String(failures[0])).toContain(openingError.message);
        expect(failures[1]).toBe(retirementError);
      }
      expect(settleNative).toHaveBeenCalledExactlyOnceWith({
        kind: "unknown",
        error: expect.objectContaining({ message: reply.error.message }),
      });
    },
  );

  it("keeps a fully initialized actor available without reporting registration again", async () => {
    edge.open.mockImplementation((_options, _lease, _committed, registration) => {
      commitRegistration(registration);
      nativeOpened = true;
      return edge.database;
    });
    for (let index = 0; index < 2; index += 1) {
      expect(
        await send({
          id: ++nextId,
          actor,
          type: "execute",
          input: serialize({ type: "database.prepareWrite", input: undefined }),
        }),
      ).toMatchObject({ ok: true });
    }
    expect(edge.open).toHaveBeenCalledOnce();
    expect(edge.committedEffects).toHaveLength(1);
    expect(edge.request.mock.calls.filter(([request]) => request.stage === "commit")).toHaveLength(
      1,
    );
  });

  it("recognizes a separately evaluated backend's inner open refusal before completed settlement", async () => {
    edge.open.mockImplementation(() => {
      nativeOpened = true;
      return edge.database;
    });
    expect(
      await send({
        id: ++nextId,
        actor,
        type: "execute",
        input: serialize({ type: "database.prepareWrite", input: undefined }),
      }),
    ).toMatchObject({ ok: true });
    edge.open.mockClear();
    const initialAdmission = await import("../infra/sqlite-worker-operation-admission.js");
    vi.resetModules();
    const duplicateAdmission = await vi.importActual<
      typeof import("../infra/sqlite-worker-operation-admission.js")
    >("../infra/sqlite-worker-operation-admission.js");
    expect(duplicateAdmission.createSqliteWorkerOperationAdmission).not.toBe(
      initialAdmission.createSqliteWorkerOperationAdmission,
    );
    // Resetting modules alone retains mock factories; install the second actual graph explicitly.
    vi.doMock("../infra/sqlite-worker-operation-admission.js", () => ({
      ...duplicateAdmission,
      requestSqliteWorkerOperationAdmission: edge.request,
      deferSqliteWorkerCommitEffect: edge.effect,
      withSqliteWorkerOperationAdmission: edge.forbidden,
    }));
    const refused = new Error("Authority revoked after preflight and before native agent open");
    edge.request.mockReset();
    edge.request
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw refused;
      });
    const opening: SqliteWorkerRequest = {
      id: ++nextId,
      actor: actor + 1_000_000,
      type: "open",
      moduleUrl: new URL("./openclaw-agent-execution.worker.ts", import.meta.url).href,
      databasePath: input.databasePath,
      existingIdentity: "file:fixture",
      openAdmission: "input",
      input: serialize(input),
    };
    try {
      const reply = await send(opening);
      expect(reply).toMatchObject({
        ok: false,
        openOutcome: "refused-before-agent-open",
        error: { message: refused.message },
      });
      if (reply.ok) {
        throw new Error("Refused backend unexpectedly opened");
      }
      expect(reply.openNotEntered).toBeUndefined();
      expect(edge.request.mock.calls).toEqual([
        [{ stage: "open", facts: input }],
        [{ stage: "open", facts: input }],
      ]);
      expect(edge.open).not.toHaveBeenCalled();
      const { retired, completion, reject, settleNative } = retireFailedReply(
        reply,
        opening,
        refused,
      );
      expect(reject).not.toHaveBeenCalled();
      expect(settleNative).not.toHaveBeenCalled();
      retired.resolve();
      expect(await completion.promise).toBe(refused);
      expect(settleNative).toHaveBeenCalledExactlyOnceWith({ kind: "completed" });
    } finally {
      vi.doMock("../infra/sqlite-worker-operation-admission.js", () => initialAdmission);
      vi.resetModules();
    }
  });
});
