import { expect, it } from "vitest";
import { createGatewaySnapshotFence } from "./gateway-snapshot-fence.js";
import { createDeferred } from "./promise.js";

it("accepts an authoritative initial snapshot without requiring a past event", async ({
  signal,
}) => {
  const fence = createGatewaySnapshotFence();
  let reads = 0;
  await expect(
    fence.waitForSnapshot({
      signal,
      read: async () => {
        reads += 1;
        return { committed: true };
      },
      ready: (snapshot) => snapshot.committed,
    }),
  ).resolves.toEqual({ committed: true });
  expect(reads).toBe(1);
});

it("serializes reads and revalidates an apparently complete snapshot invalidated in flight", async ({
  signal,
}) => {
  const fence = createGatewaySnapshotFence();
  const firstRead = createDeferred<{ committed: boolean }>();
  const secondEntered = createDeferred();
  const secondRead = createDeferred<{ committed: boolean }>();
  let reads = 0;
  let active = 0;
  let maximumActive = 0;
  const pending = fence.waitForSnapshot({
    signal,
    read: async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        if (++reads === 1) {
          return await firstRead.promise;
        }
        secondEntered.resolve();
        return await secondRead.promise;
      } finally {
        active -= 1;
      }
    },
    ready: (snapshot) => snapshot.committed,
  });
  const outcome = pending.catch((error: unknown) => error);
  let settled = false;
  void outcome.then(() => {
    settled = true;
  });
  const abort = () => {
    firstRead.resolve({ committed: false });
    secondRead.resolve({ committed: false });
    secondEntered.resolve();
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) {
    abort();
  }
  try {
    expect(reads).toBe(1);
    fence.onEvent({ type: "event", event: "task", payload: { action: "upserted" } });
    fence.onEvent({ type: "event", event: "sessions.changed" });
    expect(reads).toBe(1);
    firstRead.resolve({ committed: true });
    await secondEntered.promise;
    expect(settled).toBe(false);
    expect(reads).toBe(2);
    expect(maximumActive).toBe(1);
    secondRead.resolve({ committed: true });
    await expect(pending).resolves.toEqual({ committed: true });
  } finally {
    signal.removeEventListener("abort", abort);
    fence.close(new Error("test finished"));
    firstRead.resolve({ committed: false });
    secondRead.resolve({ committed: false });
    await outcome;
  }
});

it("does not confuse a terminal event with a committed snapshot and wakes without a provider", async ({
  signal,
}) => {
  const fence = createGatewaySnapshotFence();
  const initialRead = createDeferred();
  let committed = false;
  let reads = 0;
  const pending = fence.waitForSnapshot({
    signal,
    read: async () => {
      reads += 1;
      return { committed };
    },
    ready: (snapshot) => {
      initialRead.resolve();
      return snapshot.committed;
    },
  });
  const outcome = pending.catch((error: unknown) => error);
  try {
    await initialRead.promise;
    // Irrelevant traffic cannot be used as a heartbeat/timer polling substitute.
    fence.onEvent({ type: "event", event: "tick" });
    expect(reads).toBe(1);
    committed = true;
    fence.onEvent({ type: "event", event: "session.message" });
    await expect(pending).resolves.toEqual({ committed: true });
    expect(reads).toBe(2);
  } finally {
    fence.close(new Error("test finished"));
    await outcome;
  }
});

it("retires a sleeping generation and propagates snapshot errors without retry", async ({
  signal,
}) => {
  const retired = createGatewaySnapshotFence();
  const readEntered = createDeferred();
  let reads = 0;
  const pending = retired.waitForSnapshot({
    signal,
    read: async () => {
      reads += 1;
      return false;
    },
    ready: (snapshot) => {
      readEntered.resolve();
      return snapshot;
    },
  });
  const failure = new Error("client generation closed");
  const rejected = expect(pending).rejects.toBe(failure);
  await readEntered.promise;
  retired.close(failure);
  retired.onEvent({ type: "event", event: "task" });
  await rejected;
  expect(reads).toBe(1);

  const current = createGatewaySnapshotFence();
  const readFailure = new Error("authoritative snapshot unavailable");
  await expect(
    current.waitForSnapshot({
      signal,
      read: async () => {
        throw readFailure;
      },
      ready: () => true,
    }),
  ).rejects.toBe(readFailure);
});

it("joins an in-flight read on cancellation without accepting its late success", async ({
  signal,
}) => {
  const fence = createGatewaySnapshotFence();
  const controller = new AbortController();
  const held = createDeferred<boolean>();
  let reads = 0;
  const pending = fence.waitForSnapshot({
    signal: AbortSignal.any([signal, controller.signal]),
    read: () => {
      reads += 1;
      return held.promise;
    },
    ready: (snapshot) => snapshot,
  });
  const reason = new Error("phase cancelled during snapshot");
  const rejected = expect(pending).rejects.toBe(reason);
  controller.abort(reason);
  fence.onEvent({ type: "event", event: "task" });
  held.resolve(true);
  await rejected;
  expect(reads).toBe(1);
});
