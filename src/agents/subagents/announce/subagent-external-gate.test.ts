import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { runQaGatewayFixture } from "../../../../test/helpers/qa-gateway-cleanup.js";
import { createExternalGates } from "./subagent-external-gate.test-support.js";

it("keeps hidden concurrent results unavailable until the external owner releases them", async () => {
  const gates = await createExternalGates();
  const first = gates.create();
  const second = gates.create();
  const firstResult = randomUUID();
  const secondResult = randomUUID();
  const settled: string[] = [];
  const requests = [first, second].map(async (gate, index) => {
    const response = await fetch(gate.url, { signal: AbortSignal.timeout(10_000) });
    const text = await response.text();
    settled.push(String(index));
    return { code: response.status, text };
  });
  // Own rejection immediately, including a failure before the release assertion.
  const joined = Promise.allSettled(requests);
  await runQaGatewayFixture(
    async () => {
      await vi.waitFor(() => {
        expect(first.snapshot().waiting).toBe(1);
        expect(second.snapshot().waiting).toBe(1);
      });
      const attempt = await fetch(first.url, {
        method: "POST",
        body: "release",
        signal: AbortSignal.timeout(10_000),
      });
      await attempt.arrayBuffer();
      expect(attempt.status, "the worker cannot release the gate over HTTP").toBe(404);
      expect(settled, "neither held request has produced a result").toEqual([]);
      first.release(firstResult);
      expect(await requests[0]).toEqual({ code: 200, text: firstResult });
      expect(second.snapshot()).toEqual({ requests: 1, waiting: 1, released: false });
      expect(settled, "releasing one worker cannot release its sibling").toEqual(["0"]);
      second.release(secondResult, 503);
      expect(await requests[1]).toEqual({ code: 503, text: secondResult });
      expect(await joined).toHaveLength(2);
    },
    () => gates.close(),
    () => joined,
  );
});

it("fences held HTTP arrival and settles waiters on release, abort, and owner close", async ({
  signal,
}) => {
  const gates = await createExternalGates();
  const requests = new AbortController();
  let request: Promise<string> | undefined;
  let ownerClosed = false;
  const close = async () => {
    if (!ownerClosed) {
      ownerClosed = true;
      await gates.close();
    }
  };
  try {
    const gate = gates.create();
    const arrived = gate.waitForWaiting(signal);
    request = fetch(gate.url, {
      signal: AbortSignal.any([signal, requests.signal]),
    }).then((response) => response.text());
    // The response must remain held after the owning handler signals arrival.
    await Promise.race([
      arrived,
      request.then(() => {
        throw new Error("gate response completed before release");
      }),
    ]);
    expect(gate.snapshot()).toEqual({ requests: 1, waiting: 1, released: false });
    // Registration after the handler ran must observe existing held state immediately.
    await gate.waitForWaiting(signal);
    gate.release("owned receipt");
    await expect(request).resolves.toBe("owned receipt");
    await expect(gate.waitForWaiting(signal)).rejects.toThrow("released before");

    const unused = gates.create();
    const cancelled = new AbortController();
    const reason = new Error("arrival cancelled");
    const cancellation = expect(unused.waitForWaiting(cancelled.signal)).rejects.toBe(reason);
    cancelled.abort(reason);
    await cancellation;
    const released = expect(unused.waitForWaiting(signal)).rejects.toThrow("released before");
    unused.release("no request");
    await released;

    const closed = expect(gates.create().waitForWaiting(signal)).rejects.toThrow(
      "external gates closed",
    );
    await close();
    await closed;
  } finally {
    requests.abort();
    await close();
    await request?.catch(() => {});
  }
});
