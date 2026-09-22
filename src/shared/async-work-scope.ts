import { AsyncResource } from "node:async_hooks";
import { resolveGlobalSingleton } from "./global-singleton.js";

// Scheduler entry points need one process-stable context root across lazy chunks.
const detachedAsyncContext = resolveGlobalSingleton(
  Symbol.for("openclaw.detachedAsyncContext"),
  () => new AsyncResource("openclaw.detached-async-context"),
);

/** Runs work under a context-free async root rather than its caller's request context. */
export function runInDetachedAsyncContext<T>(run: () => T): T {
  return detachedAsyncContext.runInAsyncScope(run);
}
