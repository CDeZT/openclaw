// Real-provider proof of parent-owned continuation after cold Gateway replacement.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import type { TaskSummary } from "../packages/gateway-protocol/src/schema/tasks.js";
import { inspectManagedProcessGroup } from "../scripts/lib/managed-child-process.mts";
import { isLiveTestEnabled, logLiveProgress } from "../src/agents/live-test-helpers.js";
import { createExternalGates } from "../src/agents/subagents/announce/subagent-external-gate.test-support.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryChangesToSqlite,
} from "../src/agents/subagents/registry/subagent-registry.store.sqlite.js";
import type { OpenClawConfig } from "../src/config/config.js";
import { resolveSessionStorePathCore } from "../src/config/sessions.js";
import {
  loadExactSessionEntry,
  loadTranscriptEvents,
  patchSessionEntryCore,
} from "../src/config/sessions/session-accessor.js";
import type { GatewayClient } from "../src/gateway/client.js";
import type { SessionsListResult } from "../src/gateway/session-utils.types.js";
import { redactSecrets } from "../src/logging/redact.js";
import { extractAssistantPhaseText } from "../src/shared/chat-message-content.js";
import { cleanupSessionStateForTest } from "../src/test-utils/session-state-cleanup.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../src/utils/message-channel.js";
import { acquireGatewayTestClient } from "./helpers/gateway-client.js";
import { createGatewaySnapshotFence } from "./helpers/gateway-snapshot-fence.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";
import { runQaGatewayTestFixture } from "./helpers/qa-gateway-test-lifetime.js";

const WAIT_MS = 180_000;

async function withLivePhase<T>(
  signal: AbortSignal,
  timeoutMs: number,
  label: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = new AbortController();
  const active = AbortSignal.any([signal, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(new Error(`${label} timeout`)), timeoutMs);
  try {
    active.throwIfAborted();
    const result = await run(active);
    active.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timer);
    // A failed sibling must release every registered provider/gate waiter too.
    deadline.abort(new Error(`${label} settled`));
  }
}

async function observeOpenAiResponses() {
  const requests: string[] = [];
  const pending = new Set<Promise<void>>();
  const lifetime = new AbortController();
  const arrivals = new Set<(body: string, index: number) => void>();
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    const controller = new AbortController();
    response.on("close", () => controller.abort());
    const operation = (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.from(chunk));
        }
        const body = Buffer.concat(chunks).toString("utf8");
        requests.push(body);
        for (const arrival of [...arrivals]) {
          arrival(body, requests.length - 1);
        }
        const upstream = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            authorization: request.headers.authorization ?? "",
            "content-type": "application/json",
          },
          body,
          signal: controller.signal,
        });
        response.writeHead(upstream.status, {
          "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
        });
        if (upstream.body) {
          const reader = upstream.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            response.write(value);
          }
        }
        response.end();
      } catch (error) {
        if (!controller.signal.aborted) {
          response.destroy(error instanceof Error ? error : new Error(String(error)));
        }
      }
    })();
    pending.add(operation);
    void operation.then(() => pending.delete(operation));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("OpenAI observation listener has no TCP address");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    waitForRequest(params: {
      sourceSessionKey: string;
      sourceTool: "sessions_send" | "subagent_settle";
      startAt: number;
      signal: AbortSignal;
    }): Promise<ReturnType<typeof interSessionRequests>[number]> {
      const signal = AbortSignal.any([params.signal, lifetime.signal]);
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          arrivals.delete(arrival);
          signal.removeEventListener("abort", abort);
        };
        const abort = () => {
          cleanup();
          reject(signal.reason);
        };
        const arrival = (body: string, index: number) => {
          if (index < params.startAt) {
            return;
          }
          try {
            const matched = interSessionRequests(
              [body],
              params.sourceSessionKey,
              params.sourceTool,
              0,
            )[0];
            if (matched) {
              cleanup();
              resolve({ index, request: matched.request });
            }
          } catch (error) {
            cleanup();
            reject(error);
          }
        };
        arrivals.add(arrival);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          abort();
          return;
        }
        // Startup can dispatch before the fixture reconnects. Scan retained bodies once;
        // subsequent matches come from their owning HTTP handler, not a timer.
        for (
          let index = params.startAt;
          index < requests.length && arrivals.has(arrival);
          index++
        ) {
          arrival(requests[index]!, index);
        }
      });
    },
    async close() {
      lifetime.abort(new Error("OpenAI observation listener closed"));
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeAllConnections();
      await Promise.all([closed, ...pending]);
    },
  };
}

function fetchCommand(url: string): string {
  const script = `const r = await fetch(${JSON.stringify(url)}); const text = await r.text(); if (!r.ok) throw new Error(text); console.log(text);`;
  return [process.execPath, "--input-type=module", "-e", script]
    .map((value) => `'${value.replaceAll("'", "'\\''")}'`)
    .join(" ");
}

function interSessionRequests(
  requests: readonly string[],
  sourceSessionKey: string,
  sourceTool: "sessions_send" | "subagent_settle",
  startAt: number,
) {
  return requests.slice(startAt).flatMap((body, index) => {
    const request = asOptionalRecord(JSON.parse(body));
    if (
      !request ||
      !Array.isArray(request.input) ||
      !Array.isArray(request.tools) ||
      !request.tools.some((tool) => asOptionalRecord(tool)?.name === "exec")
    ) {
      return [];
    }
    // Earlier provenance can survive in retained history. Select the current input,
    // not an old follow-up carried into an unrelated provider request.
    const message = request.input.map(asOptionalRecord).findLast((item) => item?.role === "user");
    const matches =
      message &&
      Array.isArray(message.content) &&
      message.content.some((block) => {
        const text = asOptionalRecord(block)?.text;
        return (
          typeof text === "string" &&
          text.includes(`sourceSession=${sourceSessionKey} `) &&
          text.includes(`sourceTool=${sourceTool} `)
        );
      });
    return matches ? [{ index: startAt + index, request }] : [];
  });
}

it.skipIf(!isLiveTestEnabled() || process.platform === "win32")(
  "preserves tool results through parent follow-ups across two cold restarts and refuses stale replay",
  { timeout: 900_000, retry: 0 },
  async (context) => {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("Subagent restart live proof requires OPENAI_API_KEY");
    }
    const modelRef = process.env.OPENCLAW_LIVE_SUBAGENT_E2E_MODEL?.trim() || "openai/gpt-5.6-sol";
    expect(modelRef.startsWith("openai/")).toBe(true);
    const model = modelRef.slice("openai/".length);
    let ownedInstance: OpenClawTestInstance | undefined;
    let client: GatewayClient | undefined;
    let changes: ReturnType<typeof createGatewaySnapshotFence> | undefined;
    let provider: Awaited<ReturnType<typeof observeOpenAiResponses>> | undefined;
    let secondRecoveryRequest: ReturnType<typeof interSessionRequests>[number] | undefined;
    let gates: Awaited<ReturnType<typeof createExternalGates>> | undefined;
    const parents = new Set<string>();
    let fixtureStateBound = false;
    const artifactDir = path.resolve(
      process.env.OPENCLAW_LIVE_SUBAGENT_EVIDENCE_DIR || ".artifacts/qa-e2e",
      `subagent-cold-restart-${randomUUID()}`,
    );
    const evidence: Record<string, unknown> = { model: modelRef };
    await runQaGatewayTestFixture(
      context,
      async (lifetime) => {
        await mkdir(artifactDir, { recursive: true });
        lifetime.signal.throwIfAborted();
        const instance = await createOpenClawTestInstance({
          name: "subagent-cold-restart-live",
          env: {
            OPENAI_API_KEY: apiKey,
            OPENAI_BASE_URL: undefined,
            OPENAI_API_BASE: undefined,
            OPENCLAW_SKIP_PROVIDERS: undefined,
            OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          },
          startTimeoutMs: 120_000,
          stopTimeoutMs: 10_000,
          signal: lifetime.signal,
          verifyCleanup: lifetime.verifyCleanup,
        });
        // Capture a successful acquisition before checking a cancellation at handoff.
        ownedInstance = instance;
        lifetime.signal.throwIfAborted();
        provider = await observeOpenAiResponses();
        lifetime.signal.throwIfAborted();
        gates = await createExternalGates();
        lifetime.signal.throwIfAborted();
        const cfg: OpenClawConfig = {
          secrets: { providers: { default: { source: "env" } } },
          models: {
            mode: "replace",
            providers: {
              openai: {
                api: "openai-responses",
                baseUrl: provider.baseUrl,
                apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
                models: [
                  {
                    id: model,
                    name: model,
                    reasoning: true,
                    input: ["text"],
                    contextWindow: 128_000,
                    maxTokens: 8_192,
                    // The recorder forwards to OpenAI, which accepts the strict tool field.
                    compat: { supportsStrictMode: true },
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  },
                ],
              },
            },
          },
          plugins: { enabled: false },
          agents: {
            defaults: {
              workspace: instance.state.workspaceDir,
              model: { primary: modelRef },
              models: { [modelRef]: { agentRuntime: { id: "openclaw" } } },
              thinkingDefault: "low",
              heartbeat: { every: "0m" },
              skipBootstrap: true,
              skills: [],
              timeoutSeconds: 600,
              subagents: { allowAgents: ["*"], runTimeoutSeconds: 600, announceTimeoutMs: 180_000 },
            },
            entries: { main: { default: true } },
          },
          tools: {
            allow: [
              "sessions_spawn",
              "sessions_yield",
              "sessions_history",
              "sessions_send",
              "exec",
              "process",
            ],
            exec: { mode: "full", host: "gateway" },
            codeMode: { enabled: false },
          },
          gateway: {
            mode: "local",
            bind: "loopback",
            port: instance.port,
            auth: { mode: "token", token: instance.gatewayToken },
            controlUi: { enabled: false },
          },
        };
        await instance.state.writeConfig(cfg);
        lifetime.signal.throwIfAborted();
        instance.state.applyEnv();
        fixtureStateBound = true;
        const storePath = resolveSessionStorePathCore(undefined, {
          agentId: "main",
          env: instance.env,
        });
        const connect = async () => {
          lifetime.signal.throwIfAborted();
          changes?.close(new Error("Subagent restart client generation replaced"));
          const current = createGatewaySnapshotFence();
          changes = current;
          const signal = AbortSignal.any([lifetime.signal, current.signal]);
          let helloSeen = false;
          let connected: GatewayClient | undefined;
          try {
            connected = await acquireGatewayTestClient(
              {
                url: instance.url,
                token: instance.gatewayToken,
                deviceIdentity: null,
                clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
                mode: GATEWAY_CLIENT_MODES.BACKEND,
                scopes: ["operator.admin", "operator.read", "operator.write"],
                requestTimeoutMs: WAIT_MS,
                onEvent: current.onEvent,
                onGap: ({ expected, received }) =>
                  current.close(new Error(`Subagent restart event gap: ${expected}/${received}`)),
                onHelloOk: () => {
                  if (helloSeen) {
                    current.close(new Error("Unexpected reconnect in a subagent restart phase"));
                  }
                  helloSeen = true;
                },
                onReconnectPaused: () =>
                  current.close(new Error("Subagent restart client reconnect paused")),
              },
              {
                timeoutMs: 60_000,
                timeoutMessage: "Subagent restart Gateway connect timeout",
                closeMessage: "Subagent restart Gateway closed during connect",
                signal,
                verifyCleanup: lifetime.verifyCleanup,
                onClose: (code, reason) =>
                  current.close(new Error(`Subagent restart Gateway closed (${code}): ${reason}`)),
              },
            );
            signal.throwIfAborted();
            return connected;
          } catch (error) {
            current.close(error);
            if (connected) {
              const owned = connected;
              await lifetime.verifyCleanup(() => owned.stopAndWait());
            }
            throw error;
          }
        };
        const subscribed = new WeakSet<ReturnType<typeof createGatewaySnapshotFence>>();
        const phase = <T>(
          timeoutMs: number,
          label: string,
          run: (scope: {
            client: GatewayClient;
            changes: ReturnType<typeof createGatewaySnapshotFence>;
            signal: AbortSignal;
          }) => Promise<T>,
        ) => {
          const ownedClient = client;
          const ownedChanges = changes;
          if (!ownedClient || !ownedChanges) {
            throw new Error("Subagent restart phase has no connected owner");
          }
          return withLivePhase(
            AbortSignal.any([lifetime.signal, ownedChanges.signal]),
            timeoutMs,
            label,
            async (signal) => {
              if (!subscribed.has(ownedChanges)) {
                // Subscription belongs to this phase's existing deadline. Its initial
                // snapshot below also covers recovery completed before subscription.
                await ownedClient.request("sessions.subscribe", { agentId: "main" }, { signal });
                signal.throwIfAborted();
                subscribed.add(ownedChanges);
              }
              return run({ client: ownedClient, changes: ownedChanges, signal });
            },
          );
        };
        const killOwnedGateway = async () => {
          lifetime.signal.throwIfAborted();
          changes?.close(new Error("Owned subagent restart client deliberately stopped"));
          await client?.stopAndWait();
          client = undefined;
          lifetime.signal.throwIfAborted();
          const processOwner = instance.child;
          if (!processOwner?.pid) {
            throw new Error("Owned subagent Gateway process is unavailable");
          }
          process.kill(-processOwner.pid, "SIGKILL");
          // Join the existing admitted death/stdio cleanup; cancellation only blocks later work.
          await vi.waitFor(
            () =>
              expect(
                inspectManagedProcessGroup(processOwner, { errorPolicy: "indeterminate" }),
              ).toBe("dead"),
            { timeout: 10_000 },
          );
          await instance.stopGateway();
          lifetime.signal.throwIfAborted();
          return processOwner.pid;
        };
        const childFor = (parent: string) =>
          [...loadSubagentRegistryFromSqlite().values()].find(
            (run) => run.requesterSessionKey === parent,
          );
        const history = async (
          sessionKey: string,
          ownedClient = client!,
          signal: AbortSignal = lifetime.signal,
        ) => {
          const result = await ownedClient.request<{
            messages: Array<{ role: string; content?: unknown }>;
          }>("chat.history", { sessionKey }, { signal });
          return result.messages
            .filter((message) => message.role === "assistant")
            .map((message) => extractAssistantPhaseText(message)?.trim());
        };
        const expectSessionDone = async (
          sessionKey: string,
          ownedClient = client!,
          signal: AbortSignal = lifetime.signal,
        ) => {
          const { sessions } = await ownedClient.request<SessionsListResult>(
            "sessions.list",
            { agentId: "main" },
            { signal },
          );
          expect(sessions.find((session) => session.key === sessionKey)).toMatchObject({
            status: "done",
            hasActiveRun: false,
          });
        };
        const start = (sessionKey: string, message: string) => {
          lifetime.signal.throwIfAborted();
          parents.add(sessionKey);
          return client!.request(
            "agent",
            {
              sessionKey,
              message,
              idempotencyKey: randomUUID(),
              deliver: false,
              timeout: 600,
            },
            { signal: lifetime.signal },
          );
        };

        const parentKey = `agent:main:restart-parent-${randomUUID()}`;
        const first = gates.create();
        const second = gates.create();
        const firstMarker = `First command completed successfully. Receipt: ${randomUUID()}`;
        const secondMarker = `Second command completed successfully. Receipt: ${randomUUID()}`;
        const finalMarker = `RECOVERY_PARENT_${randomUUID()}`;
        // Never send either receipt back to the child: its own retained tool outputs
        // must supply the successful stdout on the next provider request.
        const continuationMessage = [
          `CONTINUE_RETAINED_WORK_${randomUUID()}`,
          "Continue the original two-command task from your own retained transcript.",
          "The previous Gateway process and its commands have stopped. Ignore old process handles.",
          "Rerun only a command that lacks successful stdout; never repeat a successful command.",
          "Return the original exact two-line result after both commands succeed.",
        ].join("\n");
        const childTask = [
          "Complete exactly two HTTP commands in order. Use only exec and process; do not write files or spawn.",
          `First command: ${fetchCommand(first.url)}`,
          `Second command: ${fetchCommand(second.url)}`,
          "Use yieldMs 1000 and timeoutSeconds 300. Poll a pending process until it finishes. Never repeat a command that already returned successful stdout.",
          "Only poll when exec explicitly returns a running process session ID. Completed stdout is the command result, not a process handle.",
          "Gateway restarts may interrupt a pending command. After recovery, ignore old process handles and rerun only the interrupted command. Preserve all earlier successful stdout from your transcript.",
          "After both commands succeed, reply with exactly the first command's stdout on the first line and the second command's stdout on the second line. No other content.",
        ].join("\n");
        await instance.startGateway();
        client = await connect();
        evidence.phase = "initial-checkpoint";
        logLiveProgress("subagent restart: dispatching parent; waiting for child HTTP checkpoint");
        await start(
          parentKey,
          [
            `Call sessions_spawn exactly once with ${JSON.stringify({ taskName: "restart_worker", task: childTask, cleanup: "keep", context: "isolated" })}.`,
            "Immediately call sessions_yield after acceptance. Never spawn another child.",
            "If the child reports interruption, or your own turn is interrupted while waiting for its follow-up, continue the same retained child session from the accepted spawn receipt.",
            "For each interruption, first call sessions_history exactly once for that child with includeTools=true and limit=100. Inspect the saved results before continuing.",
            `Then call sessions_send exactly once to that same child with mode="followup", timeoutSeconds=${WAIT_MS / 1_000}, and message=${JSON.stringify(continuationMessage)}. Do not add watch or use mode="resume": the interrupted task is terminal, not paused.`,
            "Wait inside sessions_send for the actual result. Do not yield again for the original settled batch, poll, repeat a send in the same turn, or execute either HTTP command yourself.",
            "The fixture confirms that the old Gateway and its commands are dead before each replacement starts. Only commands without successful stdout may be retried.",
            `Your only final reply, after both commands succeed, must be ${finalMarker} followed by the child's exact two-line result.`,
          ].join("\n"),
        );
        const initial = await phase(
          WAIT_MS,
          "Initial child checkpoint",
          async ({ changes: ownedChanges, signal }) => {
            const readInitialChild = async () => {
              signal.throwIfAborted();
              const child = childFor(parentKey);
              if (child?.execution.status === "terminal") {
                throw new Error(
                  `Child ended before the initial HTTP checkpoint: ${JSON.stringify(child.execution.outcome)}`,
                );
              }
              return child;
            };
            await Promise.all([
              ownedChanges.waitForSnapshot({
                signal,
                read: readInitialChild,
                ready: (child) => child?.requesterSettleWake?.requesterYieldBatch === true,
              }),
              first.waitForWaiting(signal),
            ]);
            // The HTTP and durable yield edges can arrive in either order. Recheck
            // their original conjunction instead of treating either arrival as success.
            const child = await readInitialChild();
            expect(first.snapshot().waiting).toBeGreaterThan(0);
            expect(child?.requesterSettleWake?.requesterYieldBatch).toBe(true);
            return child!;
          },
        );
        const tasksBefore = await client.request<{ tasks: TaskSummary[] }>(
          "tasks.list",
          { sessionKey: parentKey, limit: 100 },
          { signal: lifetime.signal },
        );
        const originalTask = tasksBefore.tasks.find(
          (task) => task.runtime === "subagent" && task.childSessionKey === initial.childSessionKey,
        )!;
        expect(originalTask?.id).toBeTruthy();
        const childScope = { agentId: "main", storePath, sessionKey: initial.childSessionKey };
        const initialChildSessionId = loadExactSessionEntry(childScope)!.entry.sessionId;
        const initialPid = await killOwnedGateway();
        const providerBeforeFirstRestart = provider.requests.length;
        lifetime.signal.throwIfAborted();
        first.release(firstMarker);
        evidence.phase = "first-recovery-checkpoint";
        logLiveProgress("subagent restart: initial child interrupted; starting recovery 1");
        await instance.startGateway();
        client = await connect();
        const continued = await phase(
          WAIT_MS,
          "First restart checkpoint",
          async ({ client: ownedClient, changes: ownedChanges, signal }) => {
            const [notice, followup] = await Promise.all([
              provider!.waitForRequest({
                sourceSessionKey: initial.childSessionKey,
                sourceTool: "subagent_settle",
                startAt: providerBeforeFirstRestart,
                signal,
              }),
              provider!.waitForRequest({
                sourceSessionKey: parentKey,
                sourceTool: "sessions_send",
                startAt: providerBeforeFirstRestart,
                signal,
              }),
              second.waitForWaiting(signal),
            ]);
            const snapshot = await ownedChanges.waitForSnapshot({
              signal,
              read: async () => {
                const { tasks } = await ownedClient.request<{ tasks: TaskSummary[] }>(
                  "tasks.list",
                  { sessionKey: parentKey, limit: 100 },
                  { signal },
                );
                const child = loadExactSessionEntry(childScope)?.entry;
                const transcript = child
                  ? await loadTranscriptEvents({ ...childScope, sessionId: child.sessionId })
                  : [];
                signal.throwIfAborted();
                return {
                  interrupted: childFor(parentKey),
                  child,
                  transcript,
                  parent: loadExactSessionEntry({
                    agentId: "main",
                    storePath,
                    sessionKey: parentKey,
                  })?.entry,
                  tasks,
                };
              },
              ready: ({ interrupted, child, parent, tasks, transcript }) =>
                interrupted?.execution.status === "terminal" &&
                child?.status === "running" &&
                Boolean(child.lifecycleRunId) &&
                parent?.status === "running" &&
                parent.endedAt === undefined &&
                JSON.stringify(transcript).includes(firstMarker) &&
                tasks.some((task) => task.id === originalTask.id && task.status === "failed") &&
                tasks.some(
                  (task) => task.runId === child.lifecycleRunId && task.status === "running",
                ),
            });
            const { interrupted, tasks, transcript } = snapshot;
            const child = snapshot.child!;
            const parent = snapshot.parent!;
            expect(second.snapshot().waiting).toBeGreaterThan(0);
            expect(interrupted).toMatchObject({
              runId: initial.runId,
              execution: {
                status: "terminal",
                outcome: { status: "error", error: expect.stringContaining("Gateway restart") },
              },
            });
            expect(interrupted?.execution.restartRecovery).toBeUndefined();
            expect(notice).toBeDefined();
            expect(JSON.stringify(notice!.request.input)).toContain(
              "Subagent execution was interrupted by a Gateway restart.",
            );
            expect(followup).toBeDefined();
            expect(followup!.index).toBeGreaterThan(notice!.index);
            expect(child.sessionId).toBe(initialChildSessionId);
            expect(child.status).toBe("running");
            expect(child.lifecycleRunId).toBeTruthy();
            expect(child.lifecycleRunId).not.toBe(initial.runId);
            expect(JSON.stringify(transcript)).toContain(firstMarker);
            // The second kill interrupts real parent tool work, not an idle parent
            // whose process-local sessions_send reply observer would be lost.
            expect(parent.status).toBe("running");
            expect(parent.endedAt).toBeUndefined();
            expect(tasks.find((task) => task.id === originalTask.id)).toMatchObject({
              status: "failed",
              runId: originalTask.runId,
            });
            expect(tasks.find((task) => task.runId === child.lifecycleRunId)).toMatchObject({
              runtime: "cli",
              status: "running",
              childSessionKey: initial.childSessionKey,
              ownerKey: parentKey,
            });
            return {
              runId: child.lifecycleRunId!,
              noticeIndex: notice.index,
              followupIndex: followup.index,
            };
          },
        );
        const firstRequests = first.snapshot().requests;
        expect(firstRequests).toBe(2);
        const recoveredPid = await killOwnedGateway();
        const providerBeforeSecondRestart = provider.requests.length;
        evidence.providerBeforeSecondRestart = providerBeforeSecondRestart;
        lifetime.signal.throwIfAborted();
        second.release(secondMarker);
        evidence.phase = "second-recovery-final";
        logLiveProgress("subagent restart: recovered receipt persisted; starting recovery 2");
        await instance.startGateway();
        client = await connect();
        secondRecoveryRequest = await phase(WAIT_MS, "Second restart request", ({ signal }) =>
          provider!.waitForRequest({
            sourceSessionKey: parentKey,
            sourceTool: "sessions_send",
            startAt: providerBeforeSecondRestart,
            signal,
          }),
        );
        evidence.secondRecoveryRequestIndex = secondRecoveryRequest.index;
        expect(secondRecoveryRequest.request.input).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "function_call_output",
              output: expect.stringContaining(firstMarker),
            }),
          ]),
        );
        const expectedFinal = `${finalMarker}\n${firstMarker}\n${secondMarker}`;
        await phase(
          WAIT_MS,
          "Final durable convergence",
          async ({ client: ownedClient, changes: ownedChanges, signal }) => {
            const snapshot = await ownedChanges.waitForSnapshot({
              signal,
              read: async () => {
                const messages = await history(parentKey, ownedClient, signal);
                const { sessions } = await ownedClient.request<SessionsListResult>(
                  "sessions.list",
                  { agentId: "main" },
                  { signal },
                );
                const { tasks } = await ownedClient.request<{ tasks: TaskSummary[] }>(
                  "tasks.list",
                  { sessionKey: parentKey, limit: 100 },
                  { signal },
                );
                return {
                  messages,
                  sessions,
                  tasks,
                  registry: childFor(parentKey),
                  child: loadExactSessionEntry(childScope)?.entry,
                };
              },
              // Events only invalidate the initial authoritative snapshots. Native CLI
              // tasks retain their producer owner through lifecycle end and publish
              // completed only after command cleanup. Keep the broad isolated event
              // union for the recovered parent's late task publication too; none of
              // these events replaces the durable-state or inactivity assertions.
              ready: ({ messages, sessions, tasks, registry, child }) =>
                messages.includes(expectedFinal) &&
                [parentKey, initial.childSessionKey].every((key) => {
                  const session = sessions.find((candidate) => candidate.key === key);
                  return session?.status === "done" && session.hasActiveRun === false;
                }) &&
                registry?.execution.status === "terminal" &&
                registry.delivery?.status === "delivered" &&
                Boolean(child?.lastRunId) &&
                tasks.some((task) => task.id === originalTask.id && task.status === "failed") &&
                tasks.some(
                  (task) => task.runId === child?.lastRunId && task.status === "completed",
                ),
            });
            const { tasks } = snapshot;
            const child = snapshot.child!;
            expect(snapshot.messages).toContain(expectedFinal);
            for (const key of [parentKey, initial.childSessionKey]) {
              expect(snapshot.sessions.find((session) => session.key === key)).toMatchObject({
                status: "done",
                hasActiveRun: false,
              });
            }
            // A successful follow-up must not rewrite the failed original task.
            // Its retired registry owner must not overwrite the newer child turn.
            expect(snapshot.registry).toMatchObject({
              runId: initial.runId,
              execution: {
                status: "terminal",
                outcome: { status: "error", error: expect.stringContaining("Gateway restart") },
              },
              delivery: { status: "delivered" },
            });
            expect(tasks.find((task) => task.id === originalTask.id)).toMatchObject({
              status: "failed",
              runId: originalTask.runId,
            });
            expect(child.sessionId).toBe(initialChildSessionId);
            expect(child.lastRunId).toBeTruthy();
            expect(child.lastRunId).not.toBe(initial.runId);
            expect(child.lastRunId).not.toBe(continued.runId);
            expect(tasks.find((task) => task.runId === child.lastRunId)).toMatchObject({
              runtime: "cli",
              status: "completed",
              childSessionKey: initial.childSessionKey,
              ownerKey: parentKey,
            });
          },
        );
        const completed = loadExactSessionEntry(childScope)!.entry;
        const parentScope = { agentId: "main", storePath, sessionKey: parentKey };
        const parentEntry = loadExactSessionEntry(parentScope)!.entry;
        const parentEvents = await loadTranscriptEvents({
          ...parentScope,
          sessionId: parentEntry.sessionId,
        });
        const parentCalls = parentEvents.flatMap((event) => {
          const message = asOptionalRecord(asOptionalRecord(event)?.message);
          return message?.role === "assistant" && Array.isArray(message.content)
            ? message.content.flatMap((block) => {
                const call = asOptionalRecord(block);
                return call?.type === "toolCall" ? [call] : [];
              })
            : [];
        });
        const inspectedHistory = parentEvents.flatMap((event) => {
          const message = asOptionalRecord(asOptionalRecord(event)?.message);
          return message?.role === "toolResult" && message.toolName === "sessions_history"
            ? [message]
            : [];
        });
        expect(inspectedHistory).toHaveLength(2);
        expect(JSON.stringify(inspectedHistory[1])).toContain(firstMarker);
        expect(parentCalls.map((call) => call.name)).toEqual([
          "sessions_spawn",
          "sessions_yield",
          "sessions_history",
          "sessions_send",
          "sessions_history",
          "sessions_send",
        ]);
        for (const call of parentCalls.filter(
          (candidateParentCall) => candidateParentCall.name === "sessions_send",
        )) {
          expect(call.arguments).toMatchObject({
            sessionKey: initial.childSessionKey,
            mode: "followup",
            timeoutSeconds: WAIT_MS / 1_000,
            message: continuationMessage,
          });
          expect(asOptionalRecord(call.arguments)?.watch).not.toBe(true);
        }
        for (const call of parentCalls.filter(
          (candidateParentCall) => candidateParentCall.name === "sessions_history",
        )) {
          expect(call.arguments).toMatchObject({
            sessionKey: initial.childSessionKey,
            includeTools: true,
            limit: 100,
          });
        }
        expect((await history(parentKey)).filter((text) => text === expectedFinal)).toHaveLength(1);
        expect(first.snapshot().requests).toBe(firstRequests);
        expect(second.snapshot().requests).toBe(2);
        Object.assign(evidence, {
          initialPid,
          recoveredPid,
          finalPid: instance.child?.pid,
          taskId: originalTask.id,
          taskRunId: originalTask.runId,
          executionRunIds: [initial.runId, continued.runId, completed.lastRunId],
          initialTaskStatus: "failed",
          initialChildSessionId,
          parentInterruptionRequestIndex: continued.noticeIndex,
          firstFollowupRequestIndex: continued.followupIndex,
          parentFollowupCount: 2,
          retiredRegistryOwnerPreserved: true,
          recoveredMarkerReachedProvider: true,
          successfulFirstCommandRepeated: false,
          parentFinalCount: 1,
        });

        const staleParent = `agent:main:stale-parent-${randomUUID()}`;
        const staleGate = gates.create();
        const staleParentFinal = `STALE_CHILD_SPAWNED_${randomUUID()}`;
        evidence.phase = "stale-child-checkpoint";
        await start(
          staleParent,
          [
            `Call sessions_spawn exactly once with ${JSON.stringify({ taskName: "stale_worker", task: `Run ${fetchCommand(staleGate.url)} with exec, timeoutSeconds 300, then use process to wait and reply with stdout. Do not spawn or write files.`, cleanup: "keep", context: "isolated", expectsCompletionMessage: false })}.`,
            `After acceptance reply exactly ${staleParentFinal}. Do not yield or wait; this child sends no completion notification.`,
          ].join("\n"),
        );
        await phase(
          WAIT_MS,
          "Stale child checkpoint",
          async ({ client: ownedClient, changes: ownedChanges, signal }) => {
            const [snapshot] = await Promise.all([
              ownedChanges.waitForSnapshot({
                signal,
                read: async () => {
                  const messages = await history(staleParent, ownedClient, signal);
                  const { sessions } = await ownedClient.request<SessionsListResult>(
                    "sessions.list",
                    { agentId: "main" },
                    { signal },
                  );
                  return {
                    messages,
                    session: sessions.find((session) => session.key === staleParent),
                  };
                },
                ready: ({ messages, session }) =>
                  messages.includes(staleParentFinal) &&
                  session?.status === "done" &&
                  session.hasActiveRun === false,
              }),
              staleGate.waitForWaiting(signal),
            ]);
            expect(staleGate.snapshot().waiting).toBeGreaterThan(0);
            expect(snapshot.messages).toContain(staleParentFinal);
            await expectSessionDone(staleParent, ownedClient, signal);
          },
        );
        const stale = childFor(staleParent)!;
        expect(stale.expectsCompletionMessage).toBe(false);
        const staleTasks = await client.request<{ tasks: TaskSummary[] }>(
          "tasks.list",
          { sessionKey: staleParent, limit: 100 },
          { signal: lifetime.signal },
        );
        const staleTask = staleTasks.tasks.find((task) => task.runId === stale.runId)!;
        expect(staleTask?.id).toBeTruthy();
        await killOwnedGateway();
        lifetime.signal.throwIfAborted();
        const runs = loadSubagentRegistryFromSqlite();
        const owned = runs.get(stale.runId)!;
        const staleAt = Date.now() - 3 * 24 * 60 * 60_000;
        owned.createdAt = staleAt;
        owned.sessionStartedAt = staleAt;
        owned.execution.startedAt = staleAt;
        expect(owned.execution.status).toBe("running");
        expect(owned.execution.interruptedAt).toBeUndefined();
        saveSubagentRegistryChangesToSqlite(runs, [owned.runId]);
        const scope = { agentId: "main", storePath, sessionKey: owned.childSessionKey };
        const childEntry = loadExactSessionEntry(scope)!.entry;
        expect(childEntry.lifecycleRunId).toBe(owned.runId);
        await patchSessionEntryCore(
          scope,
          (current) => ({
            ...current,
            updatedAt: staleAt,
            startedAt: staleAt,
            abortedLastRun: false,
          }),
          {
            assertCommitAllowed: () => {
              lifetime.signal.throwIfAborted();
              expect(instance.child).toBeUndefined();
            },
            replaceEntry: true,
          },
        );
        expect(loadExactSessionEntry(scope)!.entry.updatedAt).toBe(staleAt);
        await cleanupSessionStateForTest({ stateDir: instance.stateDir });
        const providerBeforeStaleRestart = provider.requests.length;
        const staleGateRequests = staleGate.snapshot().requests;
        evidence.providerBeforeStaleRestart = providerBeforeStaleRestart;
        lifetime.signal.throwIfAborted();
        staleGate.release("STALE_GATE_RELEASED");
        evidence.phase = "stale-child-restart";
        logLiveProgress("subagent restart: stopped fixture aged three days; verifying no replay");
        await instance.startGateway();
        client = await connect();
        await phase(
          30_000,
          "Stale restart settlement",
          async ({ client: ownedClient, changes: ownedChanges, signal }) => {
            const snapshot = await ownedChanges.waitForSnapshot({
              signal,
              read: async () => {
                const { task } = await ownedClient.request<{ task: TaskSummary }>(
                  "tasks.get",
                  { taskId: staleTask.id },
                  { signal },
                );
                return {
                  task,
                  registry: childFor(staleParent),
                  child: loadExactSessionEntry(scope)?.entry,
                };
              },
              ready: ({ task, registry, child }) =>
                registry?.execution.status === "terminal" &&
                task.status === "failed" &&
                child?.status === "failed",
            });
            const { task } = snapshot;
            expect(snapshot.registry).toMatchObject({
              runId: owned.runId,
              execution: {
                status: "terminal",
                outcome: { status: "error", error: expect.stringContaining("Gateway restart") },
              },
            });
            expect(task).toMatchObject({
              id: staleTask.id,
              runId: owned.runId,
              status: "failed",
              error: expect.stringContaining("Gateway restart"),
            });
            expect(snapshot.child).toMatchObject({
              sessionId: childEntry.sessionId,
              status: "failed",
            });
          },
        );
        expect(childFor(staleParent)?.runId).toBe(owned.runId);
        // No other work remains in this isolated Gateway. Count every dispatch,
        // not only the removed automatic-recovery provenance marker.
        const staleProviderDispatches = provider.requests.length - providerBeforeStaleRestart;
        expect(staleProviderDispatches).toBe(0);
        expect(staleGate.snapshot().requests).toBe(staleGateRequests);
        lifetime.signal.throwIfAborted();
        Object.assign(evidence, {
          phase: "passed",
          staleRunId: owned.runId,
          staleAt,
          staleProviderDispatches,
        });
        logLiveProgress(`subagent cold restart proof passed; evidence=${artifactDir}`);
      },
      () => changes?.close(new Error("Subagent restart fixture cleanup")),
      () =>
        writeFile(
          path.join(artifactDir, "provider.json"),
          JSON.stringify(
            redactSecrets({
              requestCount: provider?.requests.length ?? 0,
              secondRecoveryRequest,
              requests: provider?.requests.slice(-16).map((body) => JSON.parse(body)) ?? [],
            }),
            null,
            2,
          ),
        ),
      async () => {
        const instance = ownedInstance;
        if (!fixtureStateBound || !instance) {
          return;
        }
        const runs = [...loadSubagentRegistryFromSqlite().values()].filter((run) =>
          parents.has(run.requesterSessionKey),
        );
        const sessionKeys = new Set([
          ...parents,
          ...runs.flatMap((run) =>
            [run.childSessionKey, run.execution.transcriptTarget?.sessionKey].filter(
              (key): key is string => Boolean(key),
            ),
          ),
        ]);
        const storePath = resolveSessionStorePathCore(undefined, {
          agentId: "main",
          env: instance.env,
        });
        const sessions = await Promise.all(
          [...sessionKeys].map(async (sessionKey) => {
            const scope = { agentId: "main", storePath, sessionKey };
            const entry = loadExactSessionEntry(scope)?.entry;
            return {
              sessionKey,
              entry,
              transcript: entry
                ? await loadTranscriptEvents({ ...scope, sessionId: entry.sessionId })
                : [],
            };
          }),
        );
        await writeFile(
          path.join(artifactDir, "state.json"),
          JSON.stringify(redactSecrets({ runs, sessions, gates: gates?.snapshot() }), null, 2),
        );
      },
      () =>
        writeFile(
          path.join(artifactDir, "gateway.log"),
          redactSecrets(ownedInstance?.logs() ?? ""),
        ),
      () => writeFile(path.join(artifactDir, "proof.json"), JSON.stringify(evidence, null, 2)),
      () => gates?.close(),
      () => client?.stopAndWait(),
      () => ownedInstance?.cleanup(),
      () => provider?.close(),
    );
  },
);
