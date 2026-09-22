import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { SessionRowChange } from "../../sessions/session-row-changes.js";
import { createOpenClawStateDatabaseAsyncLifecycle } from "../../state/openclaw-state-db-async-lifecycle.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  withConfiguredSessionEntryReader,
  type ConfiguredSessionEntryReadScope,
  type RetainedConfiguredSessionEntryReader,
} from "./session-entry-configured-worker-read.js";
import type { ConfiguredSessionStoreTargetResult } from "./session-store-target-inventory.js";
import type { SessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

type Prepare =
  typeof import("./session-store-target-inventory.js").prepareConfiguredSessionStoreTargetRead;
type WithDiscovery =
  typeof import("./session-transcript-worker-resources.js").withSessionHistoryWorkerReadCandidates;
type WithDatabase =
  typeof import("./session-transcript-worker-runtime.js").withSessionHistoryWorkerDatabase;
type Retain =
  typeof import("../../state/openclaw-agent-db.js").retainOpenClawAgentDatabaseReadCandidates;
type Capture =
  typeof import("./session-canonical-key.js").captureCanonicalSessionReaderContinuation;
type PrepareRegistry =
  typeof import("../../state/openclaw-agent-db-registry-listing.js").prepareOpenClawAgentDatabaseRegistrySnapshotRead;
type Discovery = Parameters<Parameters<WithDiscovery>[1]>[0];
type NativeDatabase = ReturnType<Retain>["databases"][number];
type Continuation = NonNullable<ReturnType<Capture>>;

const mocks = vi.hoisted(() => ({
  prepare: vi.fn<Prepare>(),
  stateContext: vi.fn(),
  retainSelector: vi.fn(),
  preserves: vi.fn(() => false),
  withDiscovery: vi.fn<WithDiscovery>(),
  withDatabase: vi.fn<WithDatabase>(),
  retain: vi.fn<Retain>(),
  capture: vi.fn<Capture>(),
  registry: vi.fn<PrepareRegistry>(),
  capturePath:
    vi.fn<typeof import("./session-store-read-candidates.js").captureSessionStoreReadCandidate>(),
  subscribe:
    vi.fn<typeof import("../../sessions/session-row-changes.js").sessionChanges.subscribe>(),
  configReader: vi.fn<typeof import("../runtime-snapshot.js").createRuntimeConfigReader>(),
  claim:
    vi.fn<
      typeof import("../../state/openclaw-agent-db-identity.js").createOpenClawAgentDatabaseClaim
    >(),
  pathCurrent:
    vi.fn<
      typeof import("../../state/openclaw-agent-db-identity.js").isOpenClawAgentDatabasePathCurrent
    >(),
  openNative:
    vi.fn<typeof import("../../state/openclaw-agent-db.js").getOpenClawAgentDatabaseIfOpen>(),
  nativeGeneration:
    vi.fn<
      typeof import("../../state/openclaw-agent-db.js").readOpenIncognitoAgentDatabaseGeneration
    >(),
  retainNative:
    vi.fn<typeof import("../../state/openclaw-agent-db-lifecycle.js").retainAgentDatabase>(),
  exactNative:
    vi.fn<
      typeof import("./session-accessor.sqlite-exact-read.js").readExactSessionEntryFromSourceReadOnly
    >(),
}));

vi.mock("../../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: mocks.stateContext,
}));
vi.mock("../../state/openclaw-state-db-cache.js", () => ({
  retainOpenClawStateDatabaseSelector: mocks.retainSelector,
}));
vi.mock("./session-store-target-inventory.js", () => ({
  prepareConfiguredSessionStoreTargetRead: mocks.prepare,
}));
vi.mock("./session-transcript-worker-resources.js", () => ({
  withSessionHistoryWorkerReadCandidates: mocks.withDiscovery,
}));
vi.mock("./session-transcript-worker-runtime.js", () => ({
  withSessionHistoryWorkerDatabase: mocks.withDatabase,
}));
vi.mock("./session-canonical-key.js", () => ({
  captureCanonicalSessionReaderContinuation: mocks.capture,
}));
vi.mock("./session-store-read-candidates.js", () => ({
  captureSessionStoreReadCandidate: mocks.capturePath,
}));
vi.mock("../runtime-snapshot.js", () => ({ createRuntimeConfigReader: mocks.configReader }));
vi.mock("../../sessions/session-row-changes.js", () => ({
  sessionChanges: { subscribe: mocks.subscribe },
}));
vi.mock("../../state/openclaw-agent-db-registry-listing.js", () => ({
  prepareOpenClawAgentDatabaseRegistrySnapshotRead: mocks.registry,
  preservesOpenClawAgentRegistrationRead: mocks.preserves,
}));
vi.mock("../../state/openclaw-agent-db-identity.js", () => ({
  createOpenClawAgentDatabaseClaim: mocks.claim,
  isOpenClawAgentDatabasePathCurrent: mocks.pathCurrent,
}));
vi.mock("../../state/openclaw-agent-db-lifecycle.js", () => ({
  retainAgentDatabase: mocks.retainNative,
}));
vi.mock("../../state/openclaw-agent-db.js", async () => {
  const paths = await import("../../state/openclaw-agent-db.paths.js");
  return {
    getOpenClawAgentDatabaseIfOpen: mocks.openNative,
    readOpenIncognitoAgentDatabaseGeneration: mocks.nativeGeneration,
    retainOpenClawAgentDatabaseReadCandidates: mocks.retain,
    isIncognitoOpenClawAgentSqlitePath: paths.isIncognitoOpenClawAgentSqlitePath,
    resolveIncognitoOpenClawAgentSqlitePath: paths.resolveIncognitoOpenClawAgentSqlitePath,
  };
});
vi.mock("./session-accessor.sqlite-exact-read.js", () => ({
  readExactSessionEntryFromSourceReadOnly: mocks.exactNative,
}));
vi.mock("../../infra/worker-task-pool.js", () => ({
  WorkerTaskError: class extends Error {
    constructor(
      message: string,
      readonly code: string,
    ) {
      super(message);
    }
  },
}));

const ROOT = path.resolve("/retained-reader-fixture");
const CONFIGURED = path.join(ROOT, "configured.sqlite");
const PHYSICAL = path.join(ROOT, "physical.sqlite");
const KEY = "agent:logical:work-item";
const ENTRY: SessionEntry = {
  sessionId: "same-session",
  lifecycleRevision: "same-revision",
  updatedAt: 1,
};

function nativeDatabase(agentId: string, pathname: string): NativeDatabase {
  return {
    agentId,
    path: pathname,
    get db(): NativeDatabase["db"] {
      throw new Error("Durable facade must not access native SQL");
    },
    get walMaintenance(): NativeDatabase["walMaintenance"] {
      throw new Error("Unexpected native maintenance");
    },
  };
}

function continuation(agentId = "physical-owner"): Continuation {
  const live = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const valid = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const canonicalReady = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  return {
    receipt: {
      agentId,
      identity: "fixture-identity",
      birthtime: "1",
      mainKey: "main",
      canonicalReady: true,
      validation: { agentId, identity: "fixture-identity", valid, canonicalReady },
      live,
    },
    assertCurrent: vi.fn(),
    release: vi.fn(),
  };
}

function harness() {
  const lifecycle = createOpenClawStateDatabaseAsyncLifecycle();
  const stateAdmission = lifecycle.capture(path.join(ROOT, "state.sqlite"));
  mocks.stateContext.mockReturnValue({ admission: stateAdmission });
  mocks.retainSelector.mockImplementation(lifecycle.retainSelector);
  mocks.preserves.mockReturnValue(false);
  const cfg: OpenClawConfig = { session: { store: CONFIGURED } };
  const input: ConfiguredSessionEntryReadScope = {
    agentId: "logical",
    sessionKey: "work-item",
    storePath: CONFIGURED,
    env: { OPENCLAW_STATE_DIR: ROOT },
  };
  const selected = createDeferred<ConfiguredSessionStoreTargetResult>();
  const entered = createDeferred();
  const dispatch = createDeferred();
  const latest = createDeferred<SessionEntry | undefined>();
  const lateEntered = createDeferred();
  const releases: string[] = [];
  const listeners = new Set<(change: SessionRowChange) => void>();
  const unexpected = () => {
    throw new Error("Exact reads must not enumerate rows or read history");
  };
  const owner: SessionHistoryWorkerDatabase = {
    generation: 1,
    acceptedSource: () => undefined,
    searchTranscripts: vi.fn<SessionHistoryWorkerDatabase["searchTranscripts"]>(unexpected),
    readPreview: vi.fn<SessionHistoryWorkerDatabase["readPreview"]>(unexpected),
    readTitleFields: vi.fn<SessionHistoryWorkerDatabase["readTitleFields"]>(unexpected),
    readExactEntries: vi.fn<SessionHistoryWorkerDatabase["readExactEntries"]>(unexpected),
    assertCurrent: vi.fn(),
    readEntry: vi.fn<SessionHistoryWorkerDatabase["readEntry"]>().mockResolvedValue(ENTRY),
    readEntries: vi.fn<SessionHistoryWorkerDatabase["readEntries"]>(unexpected),
    readEntryPresence: vi.fn<SessionHistoryWorkerDatabase["readEntryPresence"]>(unexpected),
    readIdentityEvidence: vi.fn<SessionHistoryWorkerDatabase["readIdentityEvidence"]>(unexpected),
    readMembers: vi.fn<SessionHistoryWorkerDatabase["readMembers"]>(unexpected),
    readUsageCache: vi.fn<SessionHistoryWorkerDatabase["readUsageCache"]>(unexpected),
    run: vi.fn<SessionHistoryWorkerDatabase["run"]>(unexpected),
  };
  const discovery: Discovery = {
    readStoreTarget: vi.fn<Discovery["readStoreTarget"]>(unexpected),
    assertCurrent: vi.fn(),
    readConfiguredTarget: vi
      .fn<Discovery["readConfiguredTarget"]>()
      .mockReturnValue(selected.promise),
    readTargetInventory: vi.fn<Discovery["readTargetInventory"]>(unexpected),
  };
  const registryAssert = vi.fn();
  const registryRead = vi.fn<ReturnType<PrepareRegistry>["read"]>().mockResolvedValue({
    result: { status: "available", entries: [] },
    assertCurrent: registryAssert,
  });
  const candidates = [{ path: CONFIGURED, physicalPath: PHYSICAL }];
  mocks.configReader.mockImplementation((config) => () => config);
  mocks.prepare.mockImplementation((_config, scope) => ({
    agentId: scope.agentId,
    defaultAgentId: "main",
    storePath: scope.storePath,
    env: { ...scope.env },
    candidates,
  }));
  mocks.registry.mockReturnValue({ read: registryRead });
  mocks.capturePath.mockImplementation((pathname, scope) => ({
    path: pathname,
    physicalPath: pathname === CONFIGURED ? PHYSICAL : pathname,
    ...(scope ? { scope } : {}),
  }));
  mocks.pathCurrent.mockReturnValue(true);
  mocks.retain.mockReturnValue({
    databases: [],
    release: () => {
      releases.push("native");
    },
  });
  mocks.claim.mockImplementation((_database, release) => ({
    identity: "fixture-identity",
    incarnation: "fixture-incarnation",
    isCurrent: () => true,
    assertCurrent: vi.fn(),
    release,
  }));
  mocks.openNative.mockReturnValue(undefined);
  mocks.nativeGeneration.mockReturnValue(0);
  mocks.retainNative.mockReturnValue(() => {});
  mocks.subscribe.mockImplementation((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      releases.push("subscription");
    };
  });
  mocks.withDiscovery.mockImplementation(async (_candidates, operation) => {
    try {
      return await operation(discovery);
    } finally {
      releases.push("discovery");
    }
  });
  mocks.withDatabase.mockImplementation(async (_options, operation) => {
    try {
      const result = await operation(owner);
      owner.assertCurrent();
      return result;
    } finally {
      releases.push("database");
    }
  });
  const emit = (change: SessionRowChange) => {
    for (const listener of listeners) {
      listener(change);
    }
  };
  const start = () =>
    withConfiguredSessionEntryReader(cfg, input, async (reader) => {
      expect(reader.sessionKey).toBe(KEY);
      const initial = await reader.readEntry();
      initial.assertCurrent();
      expect(initial.entry).toEqual(ENTRY);
      entered.resolve();
      await dispatch.promise;
      reader.assertCurrent();
      const latest = await reader.readEntry();
      latest.assertCurrent();
      return latest.entry;
    });
  const select = () =>
    selected.resolve({
      kind: "session-configured-target",
      database: { agentId: "physical-owner", path: PHYSICAL },
    });
  return {
    lifecycle,
    stateAdmission,
    cfg,
    input,
    selected,
    entered,
    dispatch,
    latest,
    lateEntered,
    releases,
    listeners,
    owner,
    discovery,
    registryRead,
    registryAssert,
    emit,
    start,
    select,
  };
}

function awaitBoundary(entered: Promise<void>, pending: Promise<unknown>): Promise<void> {
  return Promise.race([
    entered,
    pending.then(() => {
      throw new Error("Reader settled before the held boundary");
    }),
  ]);
}

beforeEach(() => {
  vi.resetAllMocks();
});

it("captures custody before the first await and keeps the same worker owner across dispatch", async () => {
  const h = harness();
  const pending = h.start();
  try {
    expect(mocks.retain).toHaveBeenCalledOnce();
    expect(h.listeners.size).toBe(1);
    expect(h.discovery.readConfiguredTarget).toHaveBeenCalledOnce();
    expect(h.registryRead).not.toHaveBeenCalled();
    h.select();
    await awaitBoundary(h.entered.promise, pending);
    expect(h.releases).toEqual([]);
    // A real recovery publication during dispatch must be readable by the later read.
    h.emit({ sessionKey: KEY, storePath: PHYSICAL });
    const recovered = { ...ENTRY, restartRecoveryDeliverySourceRunId: "exact-source" };
    vi.mocked(h.owner.readEntry).mockResolvedValueOnce(recovered);
    h.dispatch.resolve();
    await expect(pending).resolves.toEqual(recovered);
    expect(mocks.withDatabase).toHaveBeenCalledOnce();
    expect(h.discovery.readConfiguredTarget).toHaveBeenCalledOnce();
    expect(h.owner.readEntry).toHaveBeenCalledTimes(2);
    expect(h.discovery.readTargetInventory).not.toHaveBeenCalled();
    expect(h.owner.readEntries).not.toHaveBeenCalled();
    expect(h.releases).toEqual(["database", "discovery", "native", "subscription"]);
  } finally {
    h.select();
    h.dispatch.resolve();
    await pending.catch(() => undefined);
  }
});

it.each(["alias", "database", "config ABA", "store topology", "discovery"] as const)(
  "does not adopt copied session IDs after %s changes during the original dispatch",
  async (change) => {
    const h = harness();
    const pending = h.start();
    try {
      h.select();
      await awaitBoundary(h.entered.promise, pending);
      if (change === "alias") {
        mocks.capturePath.mockImplementation((pathname) => ({
          path: pathname,
          physicalPath: path.join(ROOT, "replacement.sqlite"),
        }));
      } else if (change === "database") {
        vi.mocked(h.owner.assertCurrent).mockImplementation(() => {
          throw new Error("database replaced");
        });
      } else if (change === "discovery") {
        vi.mocked(h.discovery.assertCurrent).mockImplementation(() => {
          throw new Error("discovery revoked");
        });
      } else if (change === "store topology") {
        h.emit({ all: true, scope: "stores" });
      } else {
        h.cfg.session = { store: path.join(ROOT, "replacement.sqlite") };
        h.emit({ all: true, scope: "config" });
        h.cfg.session = { store: CONFIGURED };
        h.emit({ all: true, scope: "config" });
      }
      h.dispatch.resolve();
      await expect(pending).rejects.toThrow();
      expect(h.owner.readEntry).toHaveBeenCalledOnce();
      expect(mocks.withDatabase).toHaveBeenCalledOnce();
    } finally {
      h.select();
      h.dispatch.resolve();
      await pending.catch(() => undefined);
    }
  },
);

it("watches the canonical persisted key for a raw alias while the late result is held", async () => {
  const h = harness();
  vi.mocked(h.owner.readEntry)
    .mockResolvedValueOnce(ENTRY)
    .mockImplementationOnce(() => {
      h.lateEntered.resolve();
      return h.latest.promise;
    });
  const pending = h.start();
  try {
    h.select();
    await awaitBoundary(h.entered.promise, pending);
    h.dispatch.resolve();
    await awaitBoundary(h.lateEntered.promise, pending);
    h.emit({ sessionKey: KEY, storePath: CONFIGURED });
    h.latest.resolve({ ...ENTRY, restartRecoveryDeliverySourceRunId: "old-receipt" });
    await expect(pending).rejects.toThrow("row changed");
    expect(vi.mocked(h.owner.readEntry).mock.calls.map(([scope]) => scope.sessionKey)).toEqual([
      KEY,
      KEY,
    ]);
  } finally {
    h.select();
    h.dispatch.resolve();
    h.latest.resolve(undefined);
    await pending.catch(() => undefined);
  }
});

it("forwards only the captured continuation matching the exact physical agent and path", async () => {
  const h = harness();
  const exact = nativeDatabase("physical-owner", PHYSICAL);
  const differentPath = nativeDatabase("physical-owner", `${PHYSICAL}.other`);
  const other = nativeDatabase("other-owner", CONFIGURED);
  const accepted = continuation();
  const wrongPath = continuation();
  const unrelated = continuation("other-owner");
  mocks.retain.mockReturnValue({ databases: [differentPath, other, exact], release: vi.fn() });
  mocks.capture.mockImplementation((database) => {
    if (database === differentPath) {
      return wrongPath;
    }
    if (database === other) {
      return unrelated;
    }
    if (database === exact) {
      return accepted;
    }
    throw new Error("Unexpected retained reader fixture");
  });
  const pending = h.start();
  try {
    expect(mocks.capture).toHaveBeenCalledTimes(3);
    h.select();
    await awaitBoundary(h.entered.promise, pending);
    h.dispatch.resolve();
    await pending;
    expect(h.owner.readEntry).toHaveBeenCalledTimes(2);
    for (const [, receipt] of vi.mocked(h.owner.readEntry).mock.calls) {
      expect(receipt).toBe(accepted.receipt);
    }
    expect(accepted.release).toHaveBeenCalledOnce();
    expect(wrongPath.release).toHaveBeenCalledOnce();
    expect(unrelated.release).toHaveBeenCalledOnce();
  } finally {
    h.select();
    h.dispatch.resolve();
    await pending.catch(() => undefined);
  }
});

it("demands registry facts only when configured ownership requires them, without row inventory", async () => {
  const h = harness();
  vi.mocked(h.discovery.readConfiguredTarget)
    .mockResolvedValueOnce({ kind: "session-target-registry-required" })
    .mockResolvedValueOnce({
      kind: "session-configured-target",
      database: { agentId: "physical-owner", path: PHYSICAL },
    });
  const pending = h.start();
  try {
    await awaitBoundary(h.entered.promise, pending);
    expect(h.registryRead).toHaveBeenCalledOnce();
    expect(
      vi.mocked(h.discovery.readConfiguredTarget).mock.calls[1]?.[0].registeredDatabases,
    ).toEqual([]);
    expect(h.discovery.readTargetInventory).not.toHaveBeenCalled();
    h.registryAssert.mockImplementation(() => {
      throw new Error("registry owner changed");
    });
    h.dispatch.resolve();
    await expect(pending).rejects.toThrow("registry owner changed");
    expect(h.owner.readEntry).toHaveBeenCalledOnce();
  } finally {
    h.dispatch.resolve();
    await pending.catch(() => undefined);
  }
});

it("does not try native reads after durable configured discovery fails", async () => {
  const h = harness();
  const pending = h.start();
  h.selected.reject(new Error("configured store unavailable"));
  await expect(pending).rejects.toThrow("configured store unavailable");
  expect(mocks.openNative).not.toHaveBeenCalled();
  expect(mocks.exactNative).not.toHaveBeenCalled();
  expect(mocks.withDatabase).not.toHaveBeenCalled();
});

it("positively selects an absent process-held incognito owner without creating or dispatching", async () => {
  const h = harness();
  h.input.sessionKey = "agent:logical:dashboard:incognito-test";
  let captured: RetainedConfiguredSessionEntryReader | undefined;
  await expect(
    withConfiguredSessionEntryReader(h.cfg, h.input, (reader) => {
      captured = reader;
      if (reader.kind !== "incognito") {
        throw new Error("Expected the native reader");
      }
      const read = reader.readEntry();
      read.assertCurrent();
      expect(read.entry).toBeUndefined();
      return "original-outcome";
    }),
  ).resolves.toBe("original-outcome");
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.withDiscovery).not.toHaveBeenCalled();
  expect(mocks.exactNative).not.toHaveBeenCalled();
  expect(mocks.withDatabase).not.toHaveBeenCalled();
  expect(() => captured?.assertCurrent()).toThrow("revoked");
});

it("retains configuration authority through asynchronous discovery cleanup", async () => {
  const h = harness();
  const cleanupEntered = createDeferred();
  const cleanup = createDeferred();
  mocks.withDiscovery.mockImplementation(async (_candidates, operation) => {
    const value = await operation(h.discovery);
    cleanupEntered.resolve();
    await cleanup.promise;
    return value;
  });
  const pending = h.start();
  try {
    h.select();
    await awaitBoundary(h.entered.promise, pending);
    h.dispatch.resolve();
    await awaitBoundary(cleanupEntered.promise, pending);
    expect(h.listeners.size).toBe(1);
    h.emit({ all: true, scope: "config" });
    cleanup.resolve();
    await expect(pending).rejects.toThrow("revoked");
  } finally {
    h.select();
    h.dispatch.resolve();
    cleanup.resolve();
    await pending.catch(() => undefined);
  }
});

const activityChanges: Array<{ name: string; change: SessionRowChange }> = [
  // Exact shapes from agent-run-registry-state.ts:32 and subagent-registry-publication.ts.
  { name: "broad agent runs", change: { all: true, scope: "agent-runs" } },
  { name: "keyed agent activity", change: { sessionKey: KEY, agentId: "logical" } },
  { name: "broad subagent runs", change: { all: true, scope: "subagent-runs" } },
  { name: "keyed subagent activity", change: { sessionKey: KEY } },
  {
    name: "automation projection",
    change: { sessionKey: KEY, agentId: "logical", scope: "automation" },
  },
];

it.each(activityChanges)(
  "keeps retained custody and the row snapshot through $name",
  async ({ change }) => {
    const h = harness();
    vi.mocked(h.owner.readEntry)
      .mockResolvedValueOnce(ENTRY)
      .mockImplementationOnce(() => {
        h.lateEntered.resolve();
        return h.latest.promise;
      });
    const pending = h.start();
    try {
      h.select();
      await awaitBoundary(h.entered.promise, pending);
      h.emit(change);
      h.dispatch.resolve();
      await awaitBoundary(h.lateEntered.promise, pending);
      h.emit(change);
      h.latest.resolve(ENTRY);
      await expect(pending).resolves.toEqual(ENTRY);
      expect(h.owner.readEntry).toHaveBeenCalledTimes(2);
      expect(mocks.withDatabase).toHaveBeenCalledOnce();
      expect(h.discovery.readConfiguredTarget).toHaveBeenCalledOnce();
    } finally {
      h.select();
      h.dispatch.resolve();
      h.latest.resolve(undefined);
      await pending.catch(() => undefined);
    }
  },
);

const acceptanceChanges: Array<{ name: string; change: SessionRowChange; stale: boolean }> = [
  {
    name: "committed requester row",
    change: { sessionKey: KEY, storePath: PHYSICAL },
    stale: true,
  },
  { name: "configured-alias row", change: { sessionKey: KEY, storePath: CONFIGURED }, stale: true },
  {
    name: "same-store invalidation",
    change: { all: true, scope: { storePath: PHYSICAL } },
    stale: true,
  },
  {
    name: "other row",
    change: { sessionKey: "agent:logical:other", storePath: PHYSICAL },
    stale: false,
  },
  {
    name: "other physical store",
    change: { sessionKey: KEY, storePath: path.join(ROOT, "other.sqlite") },
    stale: false,
  },
  {
    name: "other-store invalidation",
    change: { all: true, scope: { storePath: path.join(ROOT, "other.sqlite") } },
    stale: false,
  },
  { name: "keyed activity", change: { sessionKey: KEY, agentId: "logical" }, stale: false },
  { name: "broad agent activity", change: { all: true, scope: "agent-runs" }, stale: false },
  { name: "profile observation", change: { all: true, scope: "profiles" }, stale: false },
];

it.each(acceptanceChanges)(
  "checks $name in the consuming await frame",
  async ({ change, stale }) => {
    const h = harness();
    const order: string[] = [];
    const pending = withConfiguredSessionEntryReader(h.cfg, h.input, async (reader) => {
      if (reader.kind !== "durable") {
        throw new Error("Expected the durable reader");
      }
      const read = await reader.readEntry().then((completed) => {
        // The helper has already returned and passed its internal row-version check.
        completed.assertCurrent();
        order.push("read-resolved");
        queueMicrotask(() => {
          h.emit(change);
          order.push("publication");
        });
        return completed;
      });
      order.push("consumer");
      expect(order).toEqual(["read-resolved", "publication", "consumer"]);
      expect(() => reader.assertCurrent()).not.toThrow();
      expect(read.entry).toEqual(ENTRY);
      if (stale) {
        expect(() => read.assertCurrent()).toThrow("row changed before read acceptance");
      } else {
        expect(() => read.assertCurrent()).not.toThrow();
      }
      expect(h.owner.readEntry).toHaveBeenCalledOnce();
      return "acceptance-observed";
    });
    h.select();
    await expect(pending).resolves.toBe("acceptance-observed");
    expect(mocks.withDatabase).toHaveBeenCalledOnce();
  },
);

it("invalidates the old read guard without poisoning a later read after a recovery commit", async () => {
  const h = harness();
  const recovered = { ...ENTRY, restartRecoveryDeliverySourceRunId: "late-exact-source" };
  const pending = withConfiguredSessionEntryReader(h.cfg, h.input, async (reader) => {
    const initial = await reader.readEntry();
    initial.assertCurrent();
    h.emit({ sessionKey: KEY, storePath: PHYSICAL });
    expect(() => reader.assertCurrent()).not.toThrow();
    expect(() => initial.assertCurrent()).toThrow("row changed before read acceptance");
    vi.mocked(h.owner.readEntry).mockResolvedValueOnce(recovered);
    const latest = await reader.readEntry();
    latest.assertCurrent();
    expect(latest.entry).toEqual(recovered);
    expect(() => initial.assertCurrent()).toThrow("row changed before read acceptance");
    return latest.entry;
  });
  h.select();
  await expect(pending).resolves.toEqual(recovered);
  expect(h.owner.readEntry).toHaveBeenCalledTimes(2);
  expect(mocks.withDatabase).toHaveBeenCalledOnce();
});

it.each(["effect", "final"] as const)(
  "cold no-registry reader rejects pre-mutation hard promotion at %s",
  async (boundary) => {
    const h = harness();
    const pending = withConfiguredSessionEntryReader(h.cfg, h.input, async (reader) => {
      const first = await reader.readEntry();
      first.assertCurrent();
      expect(h.registryRead).not.toHaveBeenCalled();
      expect(mocks.retain).toHaveReturnedWith(expect.objectContaining({ databases: [] }));
      const mutation = h.lifecycle.beginSelectorMutation(h.stateAdmission);
      try {
        mutation.promoteHard();
        expect(() => h.lifecycle.retainSelector(h.stateAdmission)).toThrow();
        if (boundary === "effect") expect(() => reader.assertCurrent()).toThrow("selector changed");
        // No stores event or later read is needed, and rollback cannot restore the epoch.
      } finally {
        mutation.release();
      }
      expect(() => reader.assertCurrent()).toThrow("selector changed");
      return "must-not-be-accepted";
    });
    h.select();
    await expect(pending).rejects.toThrow("selector changed");
    expect(h.registryRead).not.toHaveBeenCalled();
    expect(h.owner.readEntry).toHaveBeenCalledOnce();
  },
);

it("releases the selector even when native-reader cleanup throws", async () => {
  const h = harness();
  const cleanup = new Error("native cleanup failed");
  mocks.retain.mockReturnValue({
    databases: [],
    release() {
      throw cleanup;
    },
  });
  const pending = withConfiguredSessionEntryReader(h.cfg, h.input, async (reader) => {
    const read = await reader.readEntry();
    read.assertCurrent();
  });
  h.select();
  await expect(pending).rejects.toBe(cleanup);
  const retained = mocks.retainSelector.mock.results[0]?.value;
  expect(() => retained.assertCurrent()).toThrow("selector changed");
  expect(h.listeners.size).toBe(0);
});

it("does not publish a source witness for a row rejected after its awaited read", async () => {
  const h = harness();
  h.owner.acceptedSource = () => ({
    facts: {
      agentId: "physical-owner",
      path: PHYSICAL,
      physicalIdentity: "fixture",
      birthtime: "1",
      userVersion: 22,
      schemaVersion: 22,
      role: "agent",
      schemaAgentId: "physical-owner",
    },
    assertCurrent() {},
  });
  vi.mocked(h.owner.readEntry).mockImplementationOnce(async () => {
    h.emit({ sessionKey: KEY, storePath: PHYSICAL });
    return ENTRY;
  });
  const pending = withConfiguredSessionEntryReader(h.cfg, h.input, async (reader) => {
    await expect(reader.readEntry()).rejects.toThrow("row changed before read acceptance");
    const writer = h.lifecycle.beginSelectorMutation(h.stateAdmission);
    try {
      expect(writer.captureSource("physical-owner", PHYSICAL)).toBeUndefined();
    } finally {
      writer.release();
    }
  });
  h.select();
  await pending;
});

it("fails closed when exact-event recognition throws and never revives on a later event", async () => {
  const h = harness();
  const pending = h.start();
  try {
    h.select();
    await awaitBoundary(h.entered.promise, pending);
    mocks.preserves.mockImplementationOnce(() => {
      throw new Error("Read borrow expired");
    });
    h.emit({ all: true, scope: "stores" });
    mocks.preserves.mockReturnValue(true);
    h.emit({ all: true, scope: "stores" });
    h.dispatch.resolve();
    await expect(pending).rejects.toThrow("revoked");
    expect(h.owner.readEntry).toHaveBeenCalledOnce();
  } finally {
    h.select();
    h.dispatch.resolve();
    await pending.catch(() => undefined);
  }
});
