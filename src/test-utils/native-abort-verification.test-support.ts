import fs from "node:fs";
import { expect, vi, type TestContext } from "vitest";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { OpenClawTestState } from "./openclaw-test-state.js";

export type NativeAbortObservation = {
  onState?: (state: OpenClawTestState) => void;
  onFinish?: (finish: () => Promise<void>) => void;
  onOperationsJoined?: () => void;
};

export type NativeOperationSettlement =
  | { status: "fulfilled"; value: unknown }
  | { status: "rejected"; reason: unknown };

type NativeChildExpectation = {
  label: string;
  outcome: NativeOperationSettlement | undefined;
} & ({ expected: "not-admitted" | "fulfilled" } | { expected: "controlled-abort"; reason: Error });

function isControlledNativeAbort(error: unknown, reason: Error): boolean {
  return (
    error === reason ||
    (error instanceof Error && error.name === "AbortError" && error.cause === reason)
  );
}

/** Validate every joined child; an enclosing cancellation cannot erase its failure. */
export function validateNativeChildOutcomes(children: readonly NativeChildExpectation[]): void {
  const failures: unknown[] = [];
  for (const child of children) {
    const outcome = child.outcome;
    if (!outcome) {
      if (child.expected !== "not-admitted") {
        failures.push(new Error(`${child.label} was not admitted`));
      }
      continue;
    }
    if (child.expected === "not-admitted") {
      failures.push(new Error(`${child.label} was unexpectedly admitted`));
    }
    if (outcome.status === "rejected") {
      if (
        child.expected !== "controlled-abort" ||
        !isControlledNativeAbort(outcome.reason, child.reason)
      ) {
        failures.push(outcome.reason);
      }
    } else if (child.expected === "controlled-abort") {
      failures.push(new Error(`${child.label} fulfilled instead of rejecting controlled abort`));
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "Unexpected outcomes from joined native operations");
  }
}

export async function expectControlledNativeAbort(
  operation: Promise<unknown>,
  reason: Error,
): Promise<void> {
  await operation.then(
    () => {
      throw new Error("Controlled native cancellation unexpectedly fulfilled");
    },
    (error: unknown) => {
      expect(isControlledNativeAbort(error, reason)).toBe(true);
    },
  );
}

export async function reachNativeAbortBoundary(
  boundary: Promise<void>,
  operation: Promise<unknown>,
  signal: AbortSignal,
): Promise<void> {
  await racePromiseWithAbortSignal(
    Promise.race([
      boundary,
      operation.then(() => {
        throw new Error("Native fixture ended before its proof boundary");
      }),
    ]),
    signal,
  );
  signal.throwIfAborted();
}

/** Typed local verifier only: creates no native fixture or replacement lifecycle owner. */
export function createNativeAbortVerification(outer: TestContext) {
  outer.signal.throwIfAborted();
  const reason = new Error("controlled native fixture cancellation");
  const controller = new AbortController();
  const cleaned = createDeferredCore();
  const returnCleanup = createDeferredCore();
  const events: string[] = [];
  let root: string | undefined;
  let joined = false;
  let finish: (() => Promise<void>) | undefined;
  let restoreCleanup = () => {};
  const abortOuter = () => {
    controller.abort(outer.signal.reason);
    returnCleanup.resolve();
  };
  outer.signal.addEventListener("abort", abortOuter, { once: true });
  if (outer.signal.aborted) {
    abortOuter();
  }
  const context: Pick<TestContext, "signal" | "onTestFinished"> = {
    signal: controller.signal,
    onTestFinished: (hook, timeout) => {
      outer.onTestFinished(async (finishedContext) => {
        await expectControlledNativeAbort(
          Promise.resolve().then(() => hook(finishedContext)),
          reason,
        );
      }, timeout);
    },
  };
  const observation: NativeAbortObservation = {
    onState: (state) => {
      root = state.root;
      const cleanup = state.cleanup.bind(state);
      const spy = vi.spyOn(state, "cleanup").mockImplementation(async () => {
        // Even a failed join assertion must still run the real native/root cleanup.
        try {
          expect(joined).toBe(true);
        } finally {
          events.push("cleanup-entered");
          await cleanup();
          expect(fs.existsSync(state.root)).toBe(false);
          events.push("root-removed");
          cleaned.resolve();
          // This hold belongs to the outer verifier, not the cancelled inner fixture.
          await returnCleanup.promise;
          events.push("cleanup-returned");
        }
      });
      restoreCleanup = () => spy.mockRestore();
    },
    onFinish: (value) => {
      finish = value;
    },
    onOperationsJoined: () => {
      joined = true;
      events.push("operations-joined");
    },
  };
  return {
    context,
    observation,
    reason,
    events,
    cleaned: cleaned.promise,
    abort: () => controller.abort(reason),
    releaseCleanup: () => returnCleanup.resolve(),
    finish: async () => {
      if (!finish) {
        throw new Error("Native fixture did not register its finish hook");
      }
      await expectControlledNativeAbort(finish(), reason);
      events.push("finish-returned");
    },
    assertRootRemoved: () => {
      expect(root).toBeDefined();
      if (!root) {
        throw new Error("Native fixture did not acquire state");
      }
      expect(fs.existsSync(root)).toBe(false);
    },
    dispose: async (operation: Promise<unknown>) => {
      returnCleanup.resolve();
      try {
        // Main-path assertions and registered finish hooks retain unexpected failures.
        await Promise.allSettled([operation]);
      } finally {
        restoreCleanup();
        outer.signal.removeEventListener("abort", abortOuter);
      }
    },
  };
}
