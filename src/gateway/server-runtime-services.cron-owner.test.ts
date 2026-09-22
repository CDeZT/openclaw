import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import { startGatewayCronWithLogging } from "./server-runtime-services.js";

describe("gateway cron runtime ownership", () => {
  it("owns startup and reconciliation after its requester returns", async () => {
    const order: string[] = [];
    const callerContext = new AsyncLocalStorage<string>();
    const observedContexts: Array<string | undefined> = [];
    const cronState = {
      cron: {
        start: vi.fn(async () => {
          await Promise.resolve();
          observedContexts.push(callerContext.getStore());
          order.push("start");
        }),
      },
    } as never;
    const afterStart = vi.fn(async () => {
      observedContexts.push(callerContext.getStore());
      order.push("after-start");
    });
    const complete = vi.fn(async () => {
      observedContexts.push(callerContext.getStore());
      order.push("hook");
    });
    const arm = vi.fn(() => ({ complete }));
    const cronReconciliation = { arm } as never;
    const config = { cron: { enabled: true } } as never;
    const logCron = { error: vi.fn() };

    callerContext.run("startup requester", () =>
      startGatewayCronWithLogging({
        cronState,
        cronReconciliation,
        reason: "startup",
        config,
        afterStart,
        logCron,
      }),
    );

    await vi.waitFor(() => expect(order).toEqual(["start", "after-start", "hook"]), {
      interval: 1,
    });
    expect(observedContexts).toEqual([undefined, undefined, undefined]);
    expect(arm).toHaveBeenCalledWith({
      reason: "startup",
      config,
      cronState,
    });
    expect(logCron.error).not.toHaveBeenCalled();
  });
});
