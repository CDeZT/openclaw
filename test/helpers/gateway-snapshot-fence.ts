import type { GatewayClientOptions } from "../../src/gateway/client.js";
import { createDeferred } from "./promise.js";

/** One client generation's invalidations; none of these events is a completion receipt. */
export function createGatewaySnapshotFence() {
  const lifetime = new AbortController();
  const waiters = new Set<() => void>();
  let revision = 0;
  const onEvent: NonNullable<GatewayClientOptions["onEvent"]> = ({ event }) => {
    if (
      lifetime.signal.aborted ||
      (event !== "task" && event !== "sessions.changed" && event !== "session.message")
    ) {
      return;
    }
    revision += 1;
    for (const wake of [...waiters]) {
      wake();
    }
  };
  const waitForChange = async (observed: number, signal: AbortSignal) => {
    signal.throwIfAborted();
    const changed = createDeferred();
    const wake = () => changed.resolve();
    const abort = () => changed.reject(signal.reason);
    waiters.add(wake);
    signal.addEventListener("abort", abort, { once: true });
    try {
      // A publication between the read and registration must not leave this waiter asleep.
      if (revision !== observed) {
        wake();
      }
      signal.throwIfAborted();
      await changed.promise;
    } finally {
      waiters.delete(wake);
      signal.removeEventListener("abort", abort);
    }
  };
  return {
    signal: lifetime.signal,
    onEvent,
    close(reason: unknown) {
      lifetime.abort(reason);
    },
    async waitForSnapshot<T>(params: {
      signal: AbortSignal;
      /** The caller owns cancellation/bounds for its reads; this waiter joins each read. */
      read: () => Promise<T>;
      ready: (snapshot: T) => boolean;
    }): Promise<T> {
      const signal = AbortSignal.any([lifetime.signal, params.signal]);
      while (true) {
        signal.throwIfAborted();
        const observed = revision;
        const snapshot = await params.read();
        signal.throwIfAborted();
        // Reads are serialized. Even an apparently complete older snapshot must yield
        // to the publication that arrived while its cross-owner reads were in flight.
        if (revision !== observed) {
          continue;
        }
        if (params.ready(snapshot)) {
          return snapshot;
        }
        await waitForChange(observed, signal);
      }
    },
  };
}
