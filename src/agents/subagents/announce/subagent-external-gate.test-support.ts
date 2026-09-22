import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";

export async function createExternalGates() {
  type Gate = {
    requests: number;
    pending: Set<ServerResponse>;
    arrivals: Set<(error?: unknown) => void>;
    result?: { code: number; body: string };
  };
  const lifetime = new AbortController();
  const gates = new Map<string, Gate>();
  const server = createServer((request, response) => {
    const gate = gates.get(request.url ?? "");
    if (request.method !== "GET" || !gate) {
      response.writeHead(404).end();
      return;
    }
    gate.requests += 1;
    if (gate.result) {
      response.writeHead(gate.result.code).end(gate.result.body);
      return;
    }
    gate.pending.add(response);
    response.on("close", () => gate.pending.delete(response));
    // Arrival means a held response exists, not merely that a released route was called.
    for (const arrival of [...gate.arrivals]) {
      arrival();
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    server.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("external gate did not receive a TCP port");
  }
  return {
    snapshot: () =>
      [...gates.values()].map((gate) => ({
        requests: gate.requests,
        waiting: gate.pending.size,
        released: Boolean(gate.result),
        responseCode: gate.result?.code,
      })),
    create() {
      const route = `/${randomUUID()}`;
      const gate: Gate = { requests: 0, pending: new Set(), arrivals: new Set() };
      gates.set(route, gate);
      return {
        url: `http://127.0.0.1:${address.port}${route}`,
        snapshot: () => ({
          requests: gate.requests,
          waiting: gate.pending.size,
          released: Boolean(gate.result),
        }),
        waitForWaiting(signal: AbortSignal): Promise<void> {
          const active = AbortSignal.any([signal, lifetime.signal]);
          return new Promise<void>((resolve, reject) => {
            const finish = (error?: unknown) => {
              gate.arrivals.delete(finish);
              active.removeEventListener("abort", abort);
              if (error !== undefined) {
                reject(error);
              } else {
                resolve();
              }
            };
            const abort = () => finish(active.reason);
            gate.arrivals.add(finish);
            active.addEventListener("abort", abort, { once: true });
            if (active.aborted) {
              abort();
            } else if (gate.result) {
              finish(new Error("external gate was released before the waiting checkpoint"));
            } else if (gate.pending.size > 0) {
              finish();
            }
          });
        },
        release(body: string, code = 200) {
          if (gate.result) {
            throw new Error("external gate was already released");
          }
          gate.result = { code, body };
          for (const arrival of [...gate.arrivals]) {
            arrival(new Error("external gate was released before the waiting checkpoint"));
          }
          for (const response of gate.pending) {
            response.writeHead(code).end(body);
          }
        },
      };
    },
    async close() {
      lifetime.abort(new Error("external gates closed"));
      for (const gate of gates.values()) {
        for (const response of gate.pending) {
          response.writeHead(503).end("fixture shutting down");
        }
      }
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeAllConnections();
      await closed;
    },
  };
}
