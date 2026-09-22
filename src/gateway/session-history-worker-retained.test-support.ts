import type { Worker } from "node:worker_threads";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, vi, type TestContext } from "vitest";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { patchSessionEntryTarget } from "../config/sessions/session-accessor.sqlite-entry.js";
import { withConfiguredSessionEntryReader } from "../config/sessions/session-entry-configured-worker-read.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createNativeAbortVerification,
  expectControlledNativeAbort,
  reachNativeAbortBoundary,
  validateNativeChildOutcomes,
  type NativeAbortObservation,
  type NativeOperationSettlement,
} from "../test-utils/native-abort-verification.test-support.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";

type HistoryFixtureBindings = {
  observed: { workers: Worker[]; dispatch?: (message: unknown) => void; restoration?: unknown };
  seed: (
    state: OpenClawTestState,
    agentId: string,
    sessionId: string,
    signal?: AbortSignal,
  ) => Promise<{ path: string }>;
  setFinish: (finish: () => Promise<void>) => void;
  reset: () => Promise<void>;
};
type RetainedHistoryControl = NativeAbortObservation & {
  onRowRequest?: (key: string) => void;
  onInitialWorker?: (worker: Worker) => void;
  onLateRead?: () => void;
  onMarkerPatch?: () => void;
  onJoinStarted?: () => void;
  onChildSettlements?: (outcomes: {
    readerA: NativeOperationSettlement;
    readerB: NativeOperationSettlement | undefined;
    patch: NativeOperationSettlement | undefined;
  }) => void;
};

export async function awaitRetainedReaderBoundary(
  entered: Promise<void>,
  pending: Promise<unknown>,
  signal: AbortSignal,
): Promise<void> {
  await racePromiseWithAbortSignal(
    Promise.race([
      entered,
      pending.then(() => {
        throw new Error("Retained reader ended before its held boundary");
      }),
    ]),
    signal,
  );
  signal.throwIfAborted();
}

export async function proveRetainedHistoryWorker(
  { signal, onTestFinished }: Pick<TestContext, "signal" | "onTestFinished">,
  fixtureBindings: HistoryFixtureBindings,
  control?: RetainedHistoryControl,
): Promise<void> {
  const { seed, observed } = fixtureBindings;
  signal.throwIfAborted();
  const entered = createDeferredCore();
  const dispatch = createDeferredCore();
  const releaseHeldFences = () => {
    entered.resolve();
    dispatch.resolve();
  };
  let fixture: Promise<void> | undefined;
  const finish = async () => {
    releaseHeldFences();
    try {
      await fixture;
    } finally {
      signal.removeEventListener("abort", releaseHeldFences);
    }
  };
  signal.addEventListener("abort", releaseHeldFences, { once: true });
  onTestFinished(finish);
  fixtureBindings.setFinish(finish);
  control?.onFinish?.(finish);
  if (signal.aborted) {
    releaseHeldFences();
  }
  fixture = withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    signal.throwIfAborted();
    control?.onState?.(state);
    const a = await seed(state, "main", "retained-requester-a", signal);
    signal.throwIfAborted();
    await seed(state, "other", "retained-requester-b", signal);
    signal.throwIfAborted();
    const scopeA = {
      agentId: "main",
      sessionKey: "agent:main:retained-requester-a",
      env: state.env,
      storePath: resolveSessionStorePathCore(undefined, { agentId: "main", env: state.env }),
    };
    const scopeB = {
      agentId: "other",
      sessionKey: "agent:other:retained-requester-b",
      env: state.env,
      storePath: resolveSessionStorePathCore(undefined, { agentId: "other", env: state.env }),
    };
    const rowRequests: string[] = [];
    observed.dispatch = (message) => {
      if (signal.aborted) {
        return;
      }
      const input = asOptionalRecord(asOptionalRecord(message)?.input);
      const key = asOptionalRecord(input?.scope)?.sessionKey;
      if (input?.kind === "session-row-entry" && typeof key === "string") {
        rowRequests.push(key);
        control?.onRowRequest?.(key);
      }
    };
    let firstWorker: Worker | undefined;
    const pendingA = withConfiguredSessionEntryReader({}, scopeA, async (retainedA) => {
      signal.throwIfAborted();
      const initial = await retainedA.readEntry();
      signal.throwIfAborted();
      initial.assertCurrent();
      expect(initial.entry?.sessionId).toBe("retained-requester-a");
      firstWorker = observed.workers.at(-1);
      expect(firstWorker?.threadId).toBeGreaterThanOrEqual(0);
      if (firstWorker) {
        control?.onInitialWorker?.(firstWorker);
      }
      entered.resolve();
      await racePromiseWithAbortSignal(dispatch.promise, signal);
      signal.throwIfAborted();
      retainedA.assertCurrent();
      control?.onLateRead?.();
      const latest = await retainedA.readEntry();
      signal.throwIfAborted();
      latest.assertCurrent();
      expect(latest.entry?.sessionId).toBe("retained-requester-a");
      expect(latest.entry?.restartRecoveryDeliverySourceRunId).toBe("same-source-late-receipt");
      expect(retainedA.readSource.path).toBe(a.path);
      expect(observed.workers.at(-1)).not.toBe(firstWorker);
      return latest.entry;
    });
    let pendingB: Promise<unknown> | undefined;
    let patching: ReturnType<typeof patchSessionEntryTarget> | undefined;
    try {
      await awaitRetainedReaderBoundary(entered.promise, pendingA, signal);
      pendingB = withConfiguredSessionEntryReader({}, scopeB, async (retainedB) => {
        signal.throwIfAborted();
        const read = await retainedB.readEntry();
        signal.throwIfAborted();
        read.assertCurrent();
        expect(read.entry?.sessionId).toBe("retained-requester-b");
        expect(observed.workers.at(-1)).toBe(firstWorker);
      });
      await racePromiseWithAbortSignal(pendingB, signal);
      signal.throwIfAborted();
      // B's real discovery cleanup has awaited exit of the shared read transport.
      expect(firstWorker?.threadId).toBe(-1);
      control?.onMarkerPatch?.();
      patching = patchSessionEntryTarget(
        {
          agentId: scopeA.agentId,
          storePath: scopeA.storePath,
          target: { canonicalKey: scopeA.sessionKey, storeKeys: [scopeA.sessionKey] },
        },
        () => {
          signal.throwIfAborted();
          return { restartRecoveryDeliverySourceRunId: "same-source-late-receipt" };
        },
        { skipMaintenance: true, assertCommitAllowed: () => signal.throwIfAborted() },
      );
      await racePromiseWithAbortSignal(patching, signal);
      signal.throwIfAborted();
      dispatch.resolve();
      await racePromiseWithAbortSignal(
        expect(pendingA).resolves.toMatchObject({
          sessionId: "retained-requester-a",
          restartRecoveryDeliverySourceRunId: "same-source-late-receipt",
        }),
        signal,
      );
      signal.throwIfAborted();
      expect(rowRequests).toEqual([scopeA.sessionKey, scopeB.sessionKey, scopeA.sessionKey]);
    } finally {
      releaseHeldFences();
      // The try observes primary outcomes; cancellation still joins every admitted child.
      control?.onJoinStarted?.();
      const [readerA, readerB, patch] = await Promise.allSettled([pendingA, pendingB, patching]);
      try {
        control?.onChildSettlements?.({
          readerA,
          readerB: pendingB ? readerB : undefined,
          patch: patching ? patch : undefined,
        });
      } finally {
        // Settlement is not success. Still mark the join and restore observations on failure.
        control?.onOperationsJoined?.();
        observed.dispatch = undefined;
      }
    }
  });
  try {
    await fixture;
  } finally {
    await finish();
  }
}

export async function proveRetainedHistoryAbort(
  phase: "before-entry" | "worker-cleanup",
  outer: TestContext,
  fixtureBindings: HistoryFixtureBindings,
): Promise<void> {
  const proof = createNativeAbortVerification(outer);
  const arrival = createDeferredCore();
  const releaseNative = createDeferredCore();
  const cleanupHeld = createDeferredCore();
  const joinStarted = createDeferredCore();
  const requests: string[] = [];
  let markerPatches = 0;
  let lateReads = 0;
  const native: { worker?: Worker } = {};
  let restoreTerminate = () => {};
  const release = () => releaseNative.resolve();
  outer.signal.addEventListener("abort", release, { once: true });
  if (outer.signal.aborted) {
    release();
  }
  const operation = proveRetainedHistoryWorker(
    proof.context,
    {
      ...fixtureBindings,
      setFinish: (finish) => {
        fixtureBindings.setFinish(() => expectControlledNativeAbort(finish(), proof.reason));
      },
    },
    {
      ...proof.observation,
      onRowRequest: (key) => {
        requests.push(key);
        if (phase === "before-entry" && requests.length === 1) {
          arrival.resolve();
          // Actual initial row dispatch, before the retained reader's entry notification.
          proof.abort();
        }
      },
      onInitialWorker: (worker) => {
        if (phase !== "worker-cleanup") {
          return;
        }
        native.worker = worker;
        const terminate = worker.terminate.bind(worker);
        const spy = vi.spyOn(worker, "terminate").mockImplementation(async () => {
          cleanupHeld.resolve();
          await releaseNative.promise;
          return await terminate();
        });
        restoreTerminate = () => spy.mockRestore();
      },
      onMarkerPatch: () => {
        markerPatches++;
      },
      onLateRead: () => {
        lateReads++;
      },
      onJoinStarted: () => joinStarted.resolve(),
      onChildSettlements: ({ readerA, readerB, patch }) => {
        validateNativeChildOutcomes([
          {
            label: "reader A",
            outcome: readerA,
            expected: "controlled-abort",
            reason: proof.reason,
          },
          {
            label: "reader B",
            outcome: readerB,
            expected: phase === "worker-cleanup" ? "fulfilled" : "not-admitted",
          },
          { label: "marker patch", outcome: patch, expected: "not-admitted" },
        ]);
      },
    },
  );
  let resetting: Promise<void> | undefined;
  let resetReturned = false;
  let finishing: Promise<void> | undefined;
  let finishReturned = false;
  try {
    await reachNativeAbortBoundary(
      phase === "before-entry" ? arrival.promise : cleanupHeld.promise,
      operation,
      outer.signal,
    );
    if (phase === "worker-cleanup") {
      expect(native.worker?.threadId).toBeGreaterThanOrEqual(0);
      proof.abort();
    }
    expect(outer.signal.aborted).toBe(false);
    finishing = proof.finish().then(() => {
      finishReturned = true;
    });
    resetting = fixtureBindings.reset().then(() => {
      resetReturned = true;
    });
    const joinedFinishes = Promise.all([finishing, resetting]);
    const fullCleanupBoundary = Promise.race([
      proof.cleaned,
      joinedFinishes.then(() => {
        throw new Error("Finish/reset completed before full fixture cleanup was released");
      }),
    ]);
    if (phase === "worker-cleanup") {
      await reachNativeAbortBoundary(joinStarted.promise, operation, outer.signal);
      expect(native.worker?.threadId).toBeGreaterThanOrEqual(0);
      expect(finishReturned).toBe(false);
      expect(resetReturned).toBe(false);
      expect(proof.events).toEqual([]);
    }
    releaseNative.resolve();
    await reachNativeAbortBoundary(fullCleanupBoundary, operation, outer.signal);
    expect(finishReturned).toBe(false);
    expect(resetReturned).toBe(false);
    expect(fixtureBindings.observed.workers.length).toBeGreaterThan(0);
    for (const worker of fixtureBindings.observed.workers) {
      expect(worker.threadId).toBe(-1);
    }
    expect(markerPatches).toBe(0);
    expect(lateReads).toBe(0);
    expect(requests).toEqual(
      phase === "before-entry"
        ? ["agent:main:retained-requester-a"]
        : ["agent:main:retained-requester-a", "agent:other:retained-requester-b"],
    );
    expect(proof.events).toEqual(["operations-joined", "cleanup-entered", "root-removed"]);
    proof.releaseCleanup();
    await expectControlledNativeAbort(operation, proof.reason);
    await joinedFinishes;
    expect(finishReturned).toBe(true);
    expect(resetReturned).toBe(true);
    expect(fixtureBindings.observed.workers).toHaveLength(0);
    expect(fixtureBindings.observed.dispatch).toBeUndefined();
    expect(fixtureBindings.observed.restoration).toBeUndefined();
    proof.assertRootRemoved();
    expect(proof.events).toContain("cleanup-returned");
    const settledRequests = [...requests];
    await proof.finish();
    await fixtureBindings.reset();
    expect(requests).toEqual(settledRequests);
    expect(markerPatches).toBe(0);
    expect(lateReads).toBe(0);
    expect(fixtureBindings.observed.workers).toHaveLength(0);
    expect(fixtureBindings.observed.dispatch).toBeUndefined();
    expect(proof.events.filter((event) => event === "cleanup-returned")).toHaveLength(1);
    proof.assertRootRemoved();
    expect(outer.signal.aborted).toBe(false);
  } finally {
    proof.abort();
    releaseNative.resolve();
    proof.releaseCleanup();
    try {
      await Promise.allSettled([operation, finishing, resetting]);
    } finally {
      restoreTerminate();
      outer.signal.removeEventListener("abort", release);
      await proof.dispose(operation);
    }
  }
}
