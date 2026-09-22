import path from "node:path";
import { describe, expect, it, vi, type TestContext } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createInternalAgentTurnFacade } from "../../../gateway/agent-turn/internal-facade.js";
import { WRITE_SCOPE } from "../../../gateway/method-scopes.js";
import { createGatewayMethodRegistry } from "../../../gateway/methods/registry.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlers,
} from "../../../gateway/server-methods/types.js";
import { dispatchGatewayMethodInProcess } from "../../../gateway/server-plugin-in-process-dispatch.js";
import { withPluginRuntimeGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { trackAsyncWork } from "../../../shared/async-work-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
  type EmbeddedAgentQueueHandle,
} from "../../embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../embedded-agent-runner/runs.test-support.js";
import { maybeSteerSubagentAnnounce } from "./subagent-announce-active-wake.js";
import { SourceOwnerChangedError } from "./subagent-announce-delivery-retry.js";
import {
  dispatchSubagentAnnounceAgent,
  getSubagentRequesterSessionActivity,
  setSubagentAnnounceDeliveryDepsForTest,
  withRequesterSessionReader,
  type SubagentAnnounceDeliveryDeps,
  type SubagentRequesterSessionReader,
} from "./subagent-announce-delivery.runtime.js";
import { runSubagentAnnounceDispatch } from "./subagent-announce-dispatch.js";

function createContext(handlers: GatewayRequestHandlers): GatewayRequestContext {
  const context = {
    trackExecution: trackAsyncWork,
    deps: {},
    getRuntimeConfig: () => ({}),
    getGatewayMethodRegistry: () => createRegistry(handlers),
    logGateway: {
      warn: vi.fn(),
      error: vi.fn(),
    },
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    dedupe: new Map(),
  } as unknown as GatewayRequestContext;
  context.createAgentTurnFacade = (principal) =>
    createInternalAgentTurnFacade({
      ...principal,
      getContext: () => context,
      getMethodRegistry: () => createRegistry(handlers),
    });
  return context;
}

function createRegistry(handlers: GatewayRequestHandlers) {
  return createGatewayMethodRegistry(
    Object.entries(handlers).map(([name, handler]) => ({
      name,
      handler,
      owner: { kind: "core" as const, area: "test" },
      scope: WRITE_SCOPE,
    })),
  );
}

describe("subagent announce Gateway instance dispatch", () => {
  it("delivers a detached announce through its explicit instance resolver", async () => {
    const context = createContext({
      agent: ({ respond }) => respond(true, { raw: true }),
    });
    const idempotencyKey = "detached-subagent-announce";
    context.dedupe.set(`agent:${idempotencyKey}`, {
      ts: Date.now(),
      ok: true,
      payload: { runId: "announce-run", status: "ok", summary: "delivered" },
    });

    await expect(
      dispatchSubagentAnnounceAgent(
        {
          message: "Process one completed child result.",
          idempotencyKey,
        },
        {
          expectFinal: true,
          forceSyntheticClient: true,
          resolveGatewayContext: () => context,
        },
      ),
    ).resolves.toEqual({ runId: "announce-run", status: "ok", summary: "delivered" });
  });

  it("delivers through a lifecycle-fenced instance resolver scope", async () => {
    const context = createContext({
      agent: ({ respond }) => respond(true, { raw: true }),
    });
    const idempotencyKey = "scoped-subagent-announce";
    context.dedupe.set(`agent:${idempotencyKey}`, {
      ts: Date.now(),
      ok: true,
      payload: { runId: "scoped-announce-run", status: "ok", summary: "delivered" },
    });

    await expect(
      withPluginRuntimeGatewayContextResolver(
        () => context,
        () =>
          dispatchSubagentAnnounceAgent(
            {
              message: "Process one completed child result.",
              idempotencyKey,
            },
            {
              expectFinal: true,
              forceSyntheticClient: true,
            },
          ),
      ),
    ).resolves.toEqual({
      runId: "scoped-announce-run",
      status: "ok",
      summary: "delivered",
    });
  });
  it("rejects a nested-wake owner retired after selection before either Gateway dispatches", async () => {
    const retiredAgent = vi.fn(({ respond }) => respond(true, { raw: true }));
    const retiredContext = createContext({ agent: retiredAgent });
    const replacementAgent = vi.fn(({ respond }) => respond(true, { raw: true }));
    const replacementContext = createContext({ agent: replacementAgent });
    const resolveGatewayContext = vi
      .fn<() => GatewayRequestContext | undefined>()
      .mockReturnValueOnce(retiredContext)
      .mockReturnValue(undefined);

    await withPluginRuntimeGatewayContextResolver(
      () => replacementContext,
      async () => {
        await expect(
          dispatchGatewayMethodInProcess(
            "agent",
            {
              message: "Continue after nested descendants settle.",
              idempotencyKey: "retired-nested-wake",
            },
            {
              forceSyntheticClient: true,
              resolveGatewayContext,
            },
          ),
        ).rejects.toThrow("current gateway instance binding");
      },
    );
    expect(resolveGatewayContext).toHaveBeenCalledTimes(2);
    expect(retiredAgent).not.toHaveBeenCalled();
    expect(replacementAgent).not.toHaveBeenCalled();
  });
});

describe("subagent announce active requester admission", () => {
  const requesterSessionKey = "agent:main:announce-requester";
  const sessionId = "announce-requester";
  const steerMessage = "Child task finished.";

  async function dispatchToRequester(
    handle: EmbeddedAgentQueueHandle,
    guards: {
      isSourceSessionAdmissionAllowed?: () => boolean;
      isSourceSessionEffectsAllowed?: () => boolean;
    },
  ) {
    const direct = vi.fn(async () => ({ delivered: true, path: "direct" as const }));
    setSubagentAnnounceDeliveryDepsForTest({
      getRuntimeConfig: () => ({}),
      getRequesterSessionActivity: () => ({ sessionId, isActive: true }),
      loadRequesterSessionEntry: () => ({
        cfg: {},
        canonicalKey: requesterSessionKey,
        agentId: "main",
        entry: { sessionId, updatedAt: 1 },
      }),
    });
    try {
      setActiveEmbeddedRun(sessionId, handle, requesterSessionKey);
      const result = await runSubagentAnnounceDispatch({
        expectsCompletionMessage: false,
        steer: () => maybeSteerSubagentAnnounce({ requesterSessionKey, steerMessage, ...guards }),
        direct,
      });
      return { result, direct };
    } finally {
      clearActiveEmbeddedRun(sessionId, handle, requesterSessionKey);
      setSubagentAnnounceDeliveryDepsForTest();
    }
  }

  it.each([
    { name: "refuses source admission revoked during preparation", revoke: "before-injection" },
    {
      name: "keeps accepted delivery when source admission later closes",
      revoke: "after-injection",
    },
    {
      name: "retains the source effects fence after acceptance",
      revoke: "effects-after-injection",
    },
  ] as const)("$name", async ({ revoke }) => {
    const reachedBoundary = createDeferredCore();
    const continueDelivery = createDeferredCore();
    const injected: string[] = [];
    let admissionAllowed = true;
    let effectsAllowed = true;
    const handle = createEmbeddedRunHandle({ supportsTranscriptCommitWait: true });
    handle.messageInjectionV2 = {
      version: 2,
      isAvailable: () => true,
      queueMessage: async (text, _options, assertCurrent) => {
        if (revoke === "before-injection") {
          reachedBoundary.resolve();
          await continueDelivery.promise;
        }
        assertCurrent();
        injected.push(text);
        if (revoke !== "before-injection") {
          reachedBoundary.resolve();
          await continueDelivery.promise;
        }
      },
    };
    const delivery = dispatchToRequester(handle, {
      isSourceSessionAdmissionAllowed: () => admissionAllowed,
      isSourceSessionEffectsAllowed: () => effectsAllowed,
    });
    try {
      await Promise.race([
        reachedBoundary.promise,
        delivery.then(() => {
          throw new Error("Announcement settled before reaching V2 injection");
        }),
      ]);
      expect(injected).toEqual(revoke === "before-injection" ? [] : [steerMessage]);
      if (revoke === "effects-after-injection") {
        effectsAllowed = false;
      } else {
        admissionAllowed = false;
      }
      continueDelivery.resolve();
      const { result, direct } = await delivery;
      expect(injected).toEqual(revoke === "before-injection" ? [] : [steerMessage]);
      expect(direct).not.toHaveBeenCalled();
      expect(result).toMatchObject(
        revoke === "after-injection"
          ? { delivered: true, path: "steered" }
          : { delivered: false, path: "none", reason: "source_owner_changed", terminal: true },
      );
    } finally {
      continueDelivery.resolve();
      await delivery;
    }
  });

  it.each([false, true])(
    "routes announcements to a legacy requester with source admission guard=%s",
    async (guarded) => {
      const injected: string[] = [];
      const handle = createEmbeddedRunHandle({
        supportsTranscriptCommitWait: true,
        queueMessage: async (text) => {
          injected.push(text);
        },
      });
      const { result, direct } = await dispatchToRequester(
        handle,
        guarded ? { isSourceSessionAdmissionAllowed: () => true } : {},
      );

      expect(injected).toEqual(guarded ? [] : [steerMessage]);
      expect(direct).toHaveBeenCalledTimes(guarded ? 1 : 0);
      expect(result).toMatchObject({ delivered: true, path: guarded ? "direct" : "steered" });
    },
  );
});

describe("retained subagent requester reader runtime", () => {
  type WithConfigured = SubagentAnnounceDeliveryDeps["withConfiguredSessionEntryReader"];
  type ConfiguredReader = Parameters<Parameters<WithConfigured>[2]>[0];
  type DurableReader = Extract<ConfiguredReader, { kind: "durable" }>;
  type NativeReader = Extract<ConfiguredReader, { kind: "incognito" }>;
  type ConfiguredSnapshot = Awaited<ReturnType<ConfiguredReader["readEntry"]>>;
  type Row = NonNullable<ConfiguredSnapshot["entry"]>;
  type Requester = Awaited<ReturnType<SubagentRequesterSessionReader["read"]>>["requester"];
  type RouteChange = "configured-store" | "canonical-key" | "logical-owner" | "storage-key-only";
  const routeChanges: readonly RouteChange[] = [
    "configured-store",
    "canonical-key",
    "logical-owner",
    "storage-key-only",
  ];
  const storePath = path.resolve("/retained-requester-fixture/configured.sqlite");
  const physicalPath = path.resolve("/retained-requester-fixture/physical.sqlite");
  const canonicalKey = "agent:logical:focus";
  const nativeKey = "agent:logical:dashboard:incognito-reader-proof";
  const initialRow: Row = { sessionId: "prepared-row", updatedAt: 1, lifecycleRevision: "row-1" };
  const lateRow: Row = { ...initialRow, updatedAt: 2, lastRunId: "recovered-run" };

  function createFixtureConfig(): OpenClawConfig {
    return {
      session: { store: storePath, mainKey: "focus", scope: "per-sender" },
      agents: {
        ownership: "explicit",
        list: [{ id: "logical" }, { id: "other" }],
        defaults: { sessionStore: { agentId: "logical" } },
      },
    };
  }

  function createReaderFixture(
    { signal: testSignal, onTestFinished }: Pick<TestContext, "signal" | "onTestFinished">,
    options: { native?: boolean; holdCleanup?: boolean; releaseCallerWork?: () => void } = {},
  ) {
    testSignal.throwIfAborted();
    const cfg = createFixtureConfig();
    let currentConfig = cfg;
    let held = false;
    let finishing = false;
    let finished: Promise<void> | undefined;
    let firstSnapshotFailure: Error | undefined;
    const requesterOperations: Promise<unknown>[] = [];
    const ownerOperations: Promise<unknown>[] = [];
    const acquisition = createDeferredCore();
    const admit = createDeferredCore();
    const firstRead = createDeferredCore();
    const secondRead = createDeferredCore();
    const firstRow = createDeferredCore<Row | undefined>();
    const secondRow = createDeferredCore<Row | undefined>();
    const cleanupEntered = createDeferredCore();
    const cleanup = createDeferredCore();
    if (!options.holdCleanup) {
      cleanup.resolve();
    }
    const releaseHeldFences = () => {
      admit.resolve();
      firstRow.resolve(initialRow);
      secondRow.resolve(lateRow);
      options.releaseCallerWork?.();
      cleanup.resolve();
    };
    const abortTest = () => releaseHeldFences();
    const finish = (): Promise<void> => {
      finishing = true;
      releaseHeldFences();
      finished ??= (async () => {
        try {
          // Join real runtime calls, then the actual controlled owner operations.
          // Expected rejection is asserted by the case, not rethrown by teardown.
          await Promise.allSettled(requesterOperations);
          await Promise.allSettled(ownerOperations);
        } finally {
          testSignal.removeEventListener("abort", abortTest);
          setSubagentAnnounceDeliveryDepsForTest();
        }
      })();
      return finished;
    };
    testSignal.addEventListener("abort", abortTest, { once: true });
    onTestFinished(finish);
    const released = vi.fn<() => void>();
    const acquired =
      vi.fn<(cfg: Parameters<WithConfigured>[0], scope: Parameters<WithConfigured>[1]) => void>();
    const ownerCurrent = vi.fn<ConfiguredReader["assertCurrent"]>(() => {
      testSignal.throwIfAborted();
      if (!held) {
        throw new Error("controlled configured reader is closed");
      }
    });
    const firstSnapshotCurrent = vi.fn<ConfiguredSnapshot["assertCurrent"]>(() => {
      ownerCurrent();
      if (firstSnapshotFailure) {
        throw firstSnapshotFailure;
      }
    });
    const secondSnapshotCurrent = vi.fn<ConfiguredSnapshot["assertCurrent"]>(() => ownerCurrent());
    const nativeSnapshotCurrent = vi.fn<ConfiguredSnapshot["assertCurrent"]>(() => ownerCurrent());
    const durableRead = vi
      .fn<DurableReader["readEntry"]>()
      .mockImplementationOnce(async () => {
        firstRead.resolve();
        const entry = await firstRow.promise;
        return { entry, assertCurrent: firstSnapshotCurrent };
      })
      .mockImplementationOnce(async () => {
        secondRead.resolve();
        const entry = await secondRow.promise;
        return { entry, assertCurrent: secondSnapshotCurrent };
      });
    const nativeRow: Row = { ...initialRow, incognito: true };
    const nativeRead = vi.fn<NativeReader["readEntry"]>(() => ({
      entry: nativeRow,
      assertCurrent: nativeSnapshotCurrent,
    }));
    const durableOwner: DurableReader = {
      kind: "durable",
      agentId: "logical",
      sessionKey: canonicalKey,
      storePath,
      readSource: { agentId: "physical-owner", path: physicalPath },
      assertCurrent: ownerCurrent,
      readEntry: durableRead,
    };
    const nativeOwner: NativeReader = {
      kind: "incognito",
      agentId: "logical",
      sessionKey: nativeKey,
      storePath,
      readSource: { agentId: "logical", path: "controlled-native-owner" },
      assertCurrent: ownerCurrent,
      readEntry: nativeRead,
    };
    // This holder controls only backend admission/lifetime, not requester routing.
    // Preserve generic callback results without vi.fn generic erasure or casts.
    function holdConfigured<T>(
      capturedConfig: Parameters<WithConfigured>[0],
      scope: Parameters<WithConfigured>[1],
      operation: (reader: ConfiguredReader) => T | Promise<T>,
    ): Promise<T> {
      testSignal.throwIfAborted();
      if (finishing) {
        throw new Error("Configured fixture admission started after cleanup");
      }
      acquired(capturedConfig, scope);
      const facts = {
        agentId: scope.agentId,
        sessionKey: scope.sessionKey,
        storePath: scope.storePath,
      };
      const owner: ConfiguredReader = options.native
        ? { ...nativeOwner, ...facts }
        : { ...durableOwner, ...facts };
      held = true;
      acquisition.resolve();
      const pending = (async () => {
        try {
          await admit.promise;
          testSignal.throwIfAborted();
          const value = await operation(owner);
          owner.assertCurrent();
          return value;
        } catch (error) {
          // A failed callback cannot strand its own error behind held cleanup.
          releaseHeldFences();
          throw error;
        } finally {
          cleanupEntered.resolve();
          await cleanup.promise;
          held = false;
          released();
        }
      })();
      ownerOperations.push(pending);
      void pending.catch(() => undefined);
      return pending;
    }
    function startRequesterRead<T>(
      requesterSessionKey: string,
      explicitAgentId: string | undefined,
      operation: (reader: SubagentRequesterSessionReader) => T | Promise<T>,
    ): Promise<T> {
      testSignal.throwIfAborted();
      if (finishing) {
        throw new Error("Requester fixture started after cleanup");
      }
      const pending = withRequesterSessionReader(requesterSessionKey, explicitAgentId, operation);
      requesterOperations.push(pending);
      // Keep the original promise/outcome for assertions while owning rejection on abort.
      void pending.catch(() => undefined);
      return pending;
    }
    const withConfiguredSessionEntryReader: WithConfigured = holdConfigured;
    const unexpectedSyncRead = () => {
      throw new Error("prepared requester must not reload synchronous entry state");
    };
    const loadRequesterSessionEntry =
      vi.fn<SubagentAnnounceDeliveryDeps["loadRequesterSessionEntry"]>(unexpectedSyncRead);
    const loadSessionEntry =
      vi.fn<SubagentAnnounceDeliveryDeps["loadSessionEntry"]>(unexpectedSyncRead);
    const getRuntimeConfig = vi.fn<SubagentAnnounceDeliveryDeps["getRuntimeConfig"]>(
      () => currentConfig,
    );
    setSubagentAnnounceDeliveryDepsForTest({
      getRuntimeConfig,
      loadRequesterSessionEntry,
      loadSessionEntry,
      withConfiguredSessionEntryReader,
    });
    return {
      cfg,
      acquired,
      acquisition,
      admit,
      firstRead,
      secondRead,
      firstRow,
      secondRow,
      cleanupEntered,
      cleanup,
      released,
      ownerCurrent,
      durableRead,
      nativeRead,
      nativeRow,
      loadRequesterSessionEntry,
      loadSessionEntry,
      getRuntimeConfig,
      testSignal,
      startRequesterRead,
      releaseHeldFences,
      finish,
      invalidateFirstSnapshot: (error: Error) => {
        firstSnapshotFailure = error;
      },
      isHeld: () => held,
      rebindConfig: (next: OpenClawConfig) => {
        currentConfig = next;
      },
    };
  }

  type Fixture = ReturnType<typeof createReaderFixture>;

  async function waitForReaderBoundary<T>(
    fixture: Fixture,
    entered: Promise<T>,
    pending: Promise<unknown>,
    boundary: string,
  ): Promise<T> {
    const value = await Promise.race([
      entered,
      pending.then(() => {
        throw new Error(`Requester operation settled before ${boundary}`);
      }),
    ]);
    fixture.testSignal.throwIfAborted();
    return value;
  }

  function changeRoute(fixture: Fixture, change: RouteChange) {
    fixture.rebindConfig({
      ...fixture.cfg,
      session: {
        ...fixture.cfg.session,
        ...(change === "configured-store" ? { store: `${storePath}.replacement` } : {}),
        ...(change === "canonical-key" || change === "storage-key-only"
          ? { mainKey: "replacement" }
          : {}),
      },
      ...(change === "logical-owner"
        ? {
            agents: { ...fixture.cfg.agents, defaults: { sessionStore: { agentId: "other" } } },
          }
        : {}),
    });
  }

  function routeInput(change: RouteChange) {
    return {
      key: change === "logical-owner" ? "global" : change === "storage-key-only" ? "focus" : "main",
      agentId: change === "logical-owner" ? undefined : "logical",
    };
  }

  function expectNoSyncRead(
    fixture: Pick<Fixture, "loadRequesterSessionEntry" | "loadSessionEntry">,
  ) {
    expect(fixture.loadRequesterSessionEntry).not.toHaveBeenCalled();
    expect(fixture.loadSessionEntry).not.toHaveBeenCalled();
  }

  it("keeps one configured physical owner across initial read, caller work, late read, and cleanup", async (context) => {
    const callerWorkEntered = createDeferredCore();
    const finishCallerWork = createDeferredCore();
    const fixture = createReaderFixture(context, {
      holdCleanup: true,
      releaseCallerWork: () => finishCallerWork.resolve(),
    });
    const requesterReader = createDeferredCore<SubagentRequesterSessionReader>();
    let settled = false;
    try {
      const pending = fixture.startRequesterRead("  main  ", "logical", async (reader) => {
        requesterReader.resolve(reader);
        expect(reader.kind).toBe("durable");
        const firstSnapshot = await reader.read();
        firstSnapshot.assertCurrent();
        const first = firstSnapshot.requester;
        expect(first).toStrictEqual({
          cfg: fixture.cfg,
          canonicalKey,
          agentId: "logical",
          storePath,
          entry: initialRow,
        });
        callerWorkEntered.resolve();
        await finishCallerWork.promise;
        reader.assertCurrent();
        const lateSnapshot = await reader.read();
        lateSnapshot.assertCurrent();
        const late = lateSnapshot.requester;
        expect(late.entry).toBe(lateRow);
        return { sessionId: late.entry?.sessionId, marker: 42 };
      });
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      // Acquisition begins before the first await; caller use does not.
      expect(fixture.acquired).toHaveBeenCalledExactlyOnceWith(fixture.cfg, {
        agentId: "logical",
        sessionKey: canonicalKey,
        storePath,
        env: { ...process.env },
      });
      expect(fixture.acquired.mock.calls[0]?.[1].env).not.toBe(process.env);
      expect(fixture.durableRead).not.toHaveBeenCalled();
      expect(fixture.isHeld()).toBe(true);
      fixture.admit.resolve();
      const reader = await waitForReaderBoundary(
        fixture,
        requesterReader.promise,
        pending,
        "requester callback",
      );
      await waitForReaderBoundary(
        fixture,
        fixture.firstRead.promise,
        pending,
        "initial read entry",
      );
      fixture.firstRow.resolve(initialRow);
      await waitForReaderBoundary(fixture, callerWorkEntered.promise, pending, "caller work entry");
      expect(fixture.acquired).toHaveBeenCalledTimes(1);
      expect(fixture.durableRead).toHaveBeenCalledTimes(1);
      expect(fixture.released).not.toHaveBeenCalled();
      // An accepted old row may become stale without revoking the retained owner.
      fixture.invalidateFirstSnapshot(new Error("initial snapshot superseded during caller work"));
      finishCallerWork.resolve();
      await waitForReaderBoundary(fixture, fixture.secondRead.promise, pending, "late read entry");
      expect(fixture.acquired).toHaveBeenCalledTimes(1);
      fixture.secondRow.resolve(lateRow);
      await waitForReaderBoundary(
        fixture,
        fixture.cleanupEntered.promise,
        pending,
        "cleanup entry",
      );
      expect(fixture.isHeld()).toBe(true);
      expect(settled).toBe(false);
      fixture.cleanup.resolve();
      expect(await pending).toStrictEqual({ sessionId: initialRow.sessionId, marker: 42 });
      expect(fixture.durableRead).toHaveBeenCalledTimes(2);
      expect(fixture.nativeRead).not.toHaveBeenCalled();
      expect(fixture.released).toHaveBeenCalledTimes(1);
      expect(() => reader.read()).toThrow("controlled configured reader is closed");
      expectNoSyncRead(fixture);
    } finally {
      await fixture.finish();
    }
  });

  it.for(routeChanges)(
    "blocks callback admission when %s changes while the owner is awaited",
    async (change, context) => {
      const fixture = createReaderFixture(context);
      try {
        const input = routeInput(change);
        const operation = vi.fn<(reader: SubagentRequesterSessionReader) => number>(() => 42);
        const pending = fixture.startRequesterRead(input.key, input.agentId, operation);
        await waitForReaderBoundary(
          fixture,
          fixture.acquisition.promise,
          pending,
          "configured owner acquisition",
        );
        expect(operation).not.toHaveBeenCalled();
        changeRoute(fixture, change);
        fixture.admit.resolve();
        await expect(pending).rejects.toBeInstanceOf(SourceOwnerChangedError);
        expect(operation).not.toHaveBeenCalled();
        expect(fixture.durableRead).not.toHaveBeenCalled();
        expect(fixture.released).toHaveBeenCalledTimes(1);
        expect(fixture.isHeld()).toBe(false);
        expectNoSyncRead(fixture);
      } finally {
        await fixture.finish();
      }
    },
  );

  it.for(routeChanges)(
    "withholds row use when %s changes while the row is awaited",
    async (change, context) => {
      const fixture = createReaderFixture(context);
      try {
        const input = routeInput(change);
        const consume = vi.fn<(requester: Requester) => void>();
        const pending = fixture.startRequesterRead(input.key, input.agentId, async (reader) => {
          const snapshot = await reader.read();
          snapshot.assertCurrent();
          consume(snapshot.requester);
        });
        fixture.admit.resolve();
        await waitForReaderBoundary(
          fixture,
          fixture.firstRead.promise,
          pending,
          "initial read entry",
        );
        changeRoute(fixture, change);
        fixture.firstRow.resolve(initialRow);
        await expect(pending).rejects.toBeInstanceOf(SourceOwnerChangedError);
        expect(consume).not.toHaveBeenCalled();
        expect(fixture.acquired).toHaveBeenCalledTimes(1);
        expect(fixture.durableRead).toHaveBeenCalledTimes(1);
        expect(fixture.released).toHaveBeenCalledTimes(1);
        expectNoSyncRead(fixture);
      } finally {
        await fixture.finish();
      }
    },
  );

  it("uses the positively supplied native incognito reader synchronously for the initial row", async (context) => {
    const fixture = createReaderFixture(context, { native: true });
    try {
      fixture.admit.resolve();
      const result = await fixture.startRequesterRead(nativeKey, "logical", (reader) => {
        expect(reader.kind).toBe("incognito");
        const initialSnapshot = reader.read();
        if (initialSnapshot instanceof Promise) {
          throw new Error("Native initial metadata must retain the synchronous owner path");
        }
        initialSnapshot.assertCurrent();
        const initial = initialSnapshot.requester;
        expect(initial).toStrictEqual({
          cfg: fixture.cfg,
          canonicalKey: nativeKey,
          agentId: "logical",
          storePath,
          entry: fixture.nativeRow,
        });
        return initial.entry;
      });
      expect(result).toBe(fixture.nativeRow);
      expect(fixture.acquired).toHaveBeenCalledExactlyOnceWith(fixture.cfg, {
        agentId: "logical",
        sessionKey: nativeKey,
        storePath,
        env: { ...process.env },
      });
      expect(fixture.nativeRead).toHaveBeenCalledTimes(1);
      expect(fixture.durableRead).not.toHaveBeenCalled();
      expect(fixture.released).toHaveBeenCalledTimes(1);
      expectNoSyncRead(fixture);
    } finally {
      await fixture.finish();
    }
  });

  it("does not switch a failed native initial read to a durable or legacy reader", async (context) => {
    const fixture = createReaderFixture(context, { native: true });
    try {
      const failure = new Error("native owner unavailable");
      fixture.nativeRead.mockImplementation(() => {
        throw failure;
      });
      fixture.admit.resolve();
      await expect(
        fixture.startRequesterRead(nativeKey, "logical", (reader) => reader.read()),
      ).rejects.toBe(failure);
      expect(fixture.acquired).toHaveBeenCalledTimes(1);
      expect(fixture.nativeRead).toHaveBeenCalledTimes(1);
      expect(fixture.durableRead).not.toHaveBeenCalled();
      expect(fixture.released).toHaveBeenCalledTimes(1);
      expectNoSyncRead(fixture);
    } finally {
      await fixture.finish();
    }
  });

  it("propagates a failed durable read and releases the callback scope without reacquisition", async (context) => {
    const fixture = createReaderFixture(context);
    try {
      const failure = new Error("retained row read failed");
      const consume = vi.fn<(requester: Requester) => void>();
      const pending = fixture.startRequesterRead("main", "logical", async (reader) => {
        const snapshot = await reader.read();
        snapshot.assertCurrent();
        consume(snapshot.requester);
      });
      fixture.admit.resolve();
      await waitForReaderBoundary(
        fixture,
        fixture.firstRead.promise,
        pending,
        "initial read entry",
      );
      fixture.firstRow.reject(failure);
      await expect(pending).rejects.toBe(failure);
      expect(consume).not.toHaveBeenCalled();
      expect(fixture.acquired).toHaveBeenCalledTimes(1);
      expect(fixture.durableRead).toHaveBeenCalledTimes(1);
      expect(fixture.released).toHaveBeenCalledTimes(1);
      expectNoSyncRead(fixture);
    } finally {
      await fixture.finish();
    }

    // Actual-adapter control, in the same source case: invalidate only after the
    // backend and adapter promise have resolved, before this consumer accepts it.
    const acceptanceFixture = createReaderFixture(context);
    try {
      const staleFailure = new Error("snapshot invalidated before consumer acceptance");
      const consume = vi.fn<(requester: Requester) => void>();
      const pending = acceptanceFixture.startRequesterRead("main", "logical", async (reader) => {
        const snapshot = await Promise.resolve(reader.read()).then((received) => {
          acceptanceFixture.invalidateFirstSnapshot(staleFailure);
          return received;
        });
        // Lifetime is still current. Only the adapter's forwarded per-read guard
        // can reject this actual returned snapshot in the consuming frame.
        expect(() => reader.assertCurrent()).not.toThrow();
        snapshot.assertCurrent();
        consume(snapshot.requester);
      });
      acceptanceFixture.admit.resolve();
      await waitForReaderBoundary(
        acceptanceFixture,
        acceptanceFixture.firstRead.promise,
        pending,
        "acceptance-control read entry",
      );
      acceptanceFixture.firstRow.resolve(initialRow);
      await expect(pending).rejects.toBe(staleFailure);
      expect(consume).not.toHaveBeenCalled();
      expect(acceptanceFixture.acquired).toHaveBeenCalledTimes(1);
      expect(acceptanceFixture.durableRead).toHaveBeenCalledTimes(1);
      expect(acceptanceFixture.released).toHaveBeenCalledTimes(1);
      expectNoSyncRead(acceptanceFixture);
    } finally {
      await acceptanceFixture.finish();
    }
  });

  function createActivityFixture({ onTestFinished }: Pick<TestContext, "onTestFinished">) {
    const cfg = createFixtureConfig();
    const acquired =
      vi.fn<(cfg: Parameters<WithConfigured>[0], scope: Parameters<WithConfigured>[1]) => void>();
    const unexpectedSyncRead = () => {
      throw new Error("prepared requester must not reload synchronous entry state");
    };
    const loadRequesterSessionEntry =
      vi.fn<SubagentAnnounceDeliveryDeps["loadRequesterSessionEntry"]>(unexpectedSyncRead);
    const loadSessionEntry =
      vi.fn<SubagentAnnounceDeliveryDeps["loadSessionEntry"]>(unexpectedSyncRead);
    const getRuntimeConfig = vi.fn<SubagentAnnounceDeliveryDeps["getRuntimeConfig"]>(() => cfg);
    const withConfiguredSessionEntryReader: WithConfigured = (capturedConfig, scope) => {
      acquired(capturedConfig, scope);
      throw new Error("Prepared activity must not acquire a configured reader");
    };
    onTestFinished(() => setSubagentAnnounceDeliveryDepsForTest());
    setSubagentAnnounceDeliveryDepsForTest({
      getRuntimeConfig,
      loadRequesterSessionEntry,
      loadSessionEntry,
      withConfiguredSessionEntryReader,
    });
    return { cfg, acquired, loadRequesterSessionEntry, loadSessionEntry, getRuntimeConfig };
  }

  const activityModes: readonly ("scoped-live" | "stored-live" | "unscoped" | "empty")[] = [
    "scoped-live",
    "stored-live",
    "unscoped",
    "empty",
  ];
  it.for(activityModes)(
    "derives prepared activity from the supplied row and live projection: %s",
    (mode, context) => {
      const fixture = createActivityFixture(context);
      const key = mode === "unscoped" ? "global" : canonicalKey;
      const prepared: Requester = {
        cfg: fixture.cfg,
        canonicalKey: key,
        agentId: "logical",
        storePath,
        entry: mode === "empty" ? undefined : initialRow,
      };
      const handle = createEmbeddedRunHandle();
      const registeredId =
        mode === "stored-live" ? initialRow.sessionId : "live-projected-requester";
      const registeredKey = mode === "stored-live" ? "agent:logical:other-route" : key;
      if (mode !== "empty") {
        setActiveEmbeddedRun(registeredId, handle, registeredKey);
      }
      try {
        expect(getSubagentRequesterSessionActivity(key, "logical", prepared)).toStrictEqual({
          sessionId: mode === "scoped-live" ? registeredId : prepared.entry?.sessionId,
          isActive: mode === "scoped-live" || mode === "stored-live",
        });
        expect(fixture.getRuntimeConfig).not.toHaveBeenCalled();
        expect(fixture.acquired).not.toHaveBeenCalled();
        expectNoSyncRead(fixture);
      } finally {
        if (mode !== "empty") {
          clearActiveEmbeddedRun(registeredId, handle, registeredKey);
        }
      }
      expect(getSubagentRequesterSessionActivity(key, "logical", prepared)).toStrictEqual({
        sessionId: prepared.entry?.sessionId,
        isActive: false,
      });
      expectNoSyncRead(fixture);
    },
  );
});
