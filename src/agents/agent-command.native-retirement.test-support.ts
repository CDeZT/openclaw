import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type {
  compactionTestRuntime,
  compactionTestState,
  findCompactionSessionEntry,
  makeCompactionResult,
  requireCompactionStorePath,
} from "./agent-command.compaction.test-support.js";
import type { waitForSessionMaintenance } from "./session-maintenance/coordinator.js";

type NativeRetirementFixture = {
  signal: AbortSignal;
  state: Pick<typeof compactionTestState, "cfg" | "runAgentAttemptMock">;
  replaceSessionEntry: typeof compactionTestRuntime.replaceSessionEntry;
  requireStorePath: typeof requireCompactionStorePath;
  makeResult: typeof makeCompactionResult;
  findStoredSessionEntry: typeof findCompactionSessionEntry;
  waitForSessionMaintenance: typeof waitForSessionMaintenance;
};

/** Uses the caller's suite-owned command fixture; does not register another suite or hooks. */
export async function proveNativeFollowupTaskRetirement({
  signal,
  state,
  replaceSessionEntry,
  requireStorePath,
  makeResult,
  findStoredSessionEntry,
  waitForSessionMaintenance,
}: NativeRetirementFixture): Promise<void> {
  const [
    { dispatchAgentRunFromGateway },
    { registerSessionFollowupTask },
    { createTrackedDispatch },
    { createEmptyPluginRegistry },
    { markPluginRegistryActive, markPluginRegistryRetired },
    { withPluginRuntimeRegistryScope },
    { withTaskRegistryTempDir },
    { configureTaskRegistryRuntime, getTaskRegistryObservers, getTaskRegistryStore },
    { prepareTaskRegistryRead },
    { captureOpenClawStateWorkerContext },
    { getAgentRunContext },
    { getAgentEventLifecycleGeneration, onAgentEvent },
    { getTaskRunOwner },
  ] = await Promise.all([
    import("../gateway/agent-turn/agent-run-dispatch.js"),
    import("../gateway/agent-turn/agent-run-task-tracking.js"),
    import("../gateway/agent-turn/agent-run-dispatch.test-support.js"),
    import("../plugins/registry-empty.js"),
    import("../plugins/registry-lifecycle.js"),
    import("../plugins/runtime/gateway-request-scope.js"),
    import("../tasks/task-registry.test-support.js"),
    import("../tasks/task-registry.store.js"),
    import("../tasks/task-registry-read.js"),
    import("../state/openclaw-state-worker-context.js"),
    import("../infra/agent-run-registry.js"),
    import("../infra/agent-events.js"),
    import("../tasks/task-run-owner.js"),
  ]);
  await withTaskRegistryTempDir(
    async () => {
      const registry = createEmptyPluginRegistry();
      markPluginRegistryActive(registry);
      try {
        await withPluginRuntimeRegistryScope(registry, async () => {
          const { runId, context, entry, task } = createTrackedDispatch();
          const parentKey = "agent:main:native-retirement-parent";
          const sessionKey = "agent:main:subagent:native-retirement-child";
          const sessionId = "retained-native-retirement-child";
          entry.sessionKey = sessionKey;
          entry.sessionId = sessionId;
          entry.lifecycleGeneration = getAgentEventLifecycleGeneration();
          const assertCurrent = () => {
            signal.throwIfAborted();
            entry.controller.signal.throwIfAborted();
            if (context.chatAbortControllers.get(runId) !== entry) {
              throw new Error("Native retirement test lost its admitted run");
            }
          };
          await replaceSessionEntry(
            { sessionKey, storePath: requireStorePath() },
            { sessionId, spawnedBy: parentKey, updatedAt: Date.now() },
          );
          const followup = await registerSessionFollowupTask({
            followup: { kind: "session_followup", requesterSessionKey: parentKey },
            runId,
            sessionKey,
            task: task.task,
            requesterOrigin: undefined,
            assertCurrent,
          });
          expect(followup.kind).toBe("receipt");
          const cleanupEntered = createDeferred();
          const releaseCleanup = createDeferred();
          const lifecycleEnded = createDeferred();
          const published = createDeferred<{
            taskId: string;
            runId?: string;
            cleanupFinished: boolean;
            contextPresent: boolean;
          }>();
          let cleanupFinished = false;
          let completedPublications = 0;
          const previousObservers = getTaskRegistryObservers();
          const stopLifecycle = onAgentEvent((event) => {
            if (
              event.runId === runId &&
              event.stream === "lifecycle" &&
              event.data.phase === "end"
            ) {
              lifecycleEnded.resolve();
            }
          });
          configureTaskRegistryRuntime({
            observers: {
              onEvent(event) {
                if (
                  event.kind === "upserted" &&
                  event.task.taskId === followup.task.taskId &&
                  event.task.status === "succeeded"
                ) {
                  completedPublications += 1;
                  published.resolve({
                    taskId: event.task.taskId,
                    runId: event.task.runId,
                    cleanupFinished,
                    contextPresent: getAgentRunContext(runId) !== undefined,
                  });
                }
              },
            },
          });
          // Reuse the existing attempt seam, not a replacement command or terminalizer.
          // Real post-run code emits lifecycle end and awaits this adopted cleanup owner.
          state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
            await params.opts.onExecutionStarted?.();
            expectDefined(params.deferredLifecycle, "native deferred lifecycle").adopt({
              beginRetryWait: () => undefined,
              discard: () => releaseCleanup.resolve(),
              complete: async () => {
                cleanupEntered.resolve();
                await releaseCleanup.promise;
                cleanupFinished = true;
              },
            });
            return makeResult({ sessionId, text: "native follow-up result", runner: "embedded" });
          });
          const abort = () => {
            entry.controller.abort(signal.reason);
            releaseCleanup.resolve();
          };
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) {
            abort();
          }
          let execution: ReturnType<typeof dispatchAgentRunFromGateway> | undefined;
          try {
            assertCurrent();
            const emitFinal = vi.fn();
            execution = dispatchAgentRunFromGateway({
              admittedRunEntry: entry,
              assertCurrent,
              assertSettlementCurrent: assertCurrent,
              ingressOpts: {
                message: task.task,
                runId,
                sessionKey,
                sessionId,
                lifecycleGeneration: entry.lifecycleGeneration,
                inputProvenance: {
                  kind: "inter_session",
                  sourceSessionKey: parentKey,
                  sourceTool: "sessions_send",
                },
                abortSignal: entry.controller.signal,
                allowModelOverride: false,
              },
              runId,
              dedupeKeys: [`agent:${runId}`],
              abortController: entry.controller,
              cleanupAbortController: () => {
                if (context.chatAbortControllers.get(runId) === entry) {
                  context.chatAbortControllers.delete(runId);
                }
              },
              io: { emitAcceptance: vi.fn(), emitFinal },
              context,
              taskTrackingMode: followup,
              commandRuntimeContext: { config: state.cfg ?? {} },
            });
            void execution.catch(() => {});
            await Promise.race([
              Promise.all([lifecycleEnded.promise, cleanupEntered.promise]),
              execution.then(() => {
                throw new Error("Dispatch returned before the native cleanup hold");
              }),
            ]);
            signal.throwIfAborted();
            expect(getTaskRunOwner(followup.task)).toBeDefined();
            expect(getAgentRunContext(runId)).toMatchObject({
              sessionKey,
              sessionId,
              projectSessionActive: true,
            });
            expect(cleanupFinished).toBe(false);
            // Join the accepted real lifecycle-ingestion prefix before checking absence.
            // This fails if lifecycle end is allowed to terminalize the registered owner.
            expect(await prepareTaskRegistryRead()).toBeDefined();
            const store = getTaskRegistryStore();
            const worker = captureOpenClawStateWorkerContext();
            const held = await store.loadMutationSnapshotAsync(worker, {
              taskId: followup.task.taskId,
            });
            expect(held.tasks.get(followup.task.taskId)).toMatchObject({
              runId,
              runtime: "cli",
              status: "running",
              childSessionKey: sessionKey,
              ownerKey: parentKey,
            });
            expect(held.tasks.get(followup.task.taskId)?.endedAt).toBeUndefined();
            expect(completedPublications).toBe(0);
            expect(emitFinal).not.toHaveBeenCalled();
            releaseCleanup.resolve();
            const publication = await Promise.race([
              published.promise,
              execution.then(() => {
                throw new Error("Dispatch finished without its terminal task publication");
              }),
            ]);
            expect(publication).toEqual({
              taskId: followup.task.taskId,
              runId,
              cleanupFinished: true,
              contextPresent: false,
            });
            await execution;
            const terminal = await store.loadMutationSnapshotAsync(worker, {
              taskId: followup.task.taskId,
            });
            expect(terminal.tasks.get(followup.task.taskId)).toMatchObject({
              runId,
              runtime: "cli",
              status: "succeeded",
              childSessionKey: sessionKey,
              ownerKey: parentKey,
            });
            expect(findStoredSessionEntry(sessionKey)?.sessionId).toBe(sessionId);
            expect(getTaskRunOwner(followup.task)).toBeUndefined();
            expect(emitFinal).toHaveBeenCalledOnce();
          } finally {
            signal.removeEventListener("abort", abort);
            releaseCleanup.resolve();
            try {
              await execution;
            } finally {
              stopLifecycle();
              configureTaskRegistryRuntime({ observers: previousObservers });
              await waitForSessionMaintenance(sessionKey);
            }
          }
        });
      } finally {
        markPluginRegistryRetired(registry);
      }
    },
    { durableStore: true },
  );
}
