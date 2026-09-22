import fs from "node:fs";
import path from "node:path";
import { expect, vi, type TestContext } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { prepareAgentDeleteDatabases } from "../../agents/agent-delete-databases.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  beginAgentDeletionJournal,
  removeAgentDeletionJournal,
} from "../../state/agent-deletion-journal.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import {
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  createNativeAbortVerification,
  expectControlledNativeAbort,
  reachNativeAbortBoundary,
  validateNativeChildOutcomes,
  type NativeAbortObservation,
  type NativeOperationSettlement,
} from "../../test-utils/native-abort-verification.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveSessionStorePathCore } from "./paths.js";
import { replaceSessionEntrySync } from "./session-accessor.js";
import { readExactSessionEntryFromSourceReadOnly } from "./session-accessor.sqlite-exact-read.js";
import { withConfiguredSessionEntryReader } from "./session-entry-configured-worker-read.js";

type IncognitoAbortObservation = NativeAbortObservation & {
  beforeDrainEntry?: () => Promise<void>;
  onDrainEntry?: () => void;
  afterGateRelease?: () => Promise<void>;
  onJournalRollback?: () => void;
  onFreshOwner?: () => void;
  onDeletionJoined?: () => void;
  onReaderSettlement?: (outcome: NativeOperationSettlement) => void;
  onNativeHandles?: (snapshot: () => { durableOpen: boolean; nativeOpen: boolean }) => void;
};

/** Same native/journal fixture, extracted only to keep the owning test below its line cap. */
export async function proveNativeIncognitoGuardRetirement(
  ending: "native-close" | "deletion",
  { signal, onTestFinished }: Pick<TestContext, "signal" | "onTestFinished">,
  control?: IncognitoAbortObservation,
): Promise<void> {
  signal.throwIfAborted();
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const releaseHeldFences = () => {
    entered.resolve();
    release.resolve();
  };
  let fixture: Promise<void> | undefined;
  const finish = async () => {
    releaseHeldFences();
    try {
      // Called only outside the fixture: never join a parent from its own child.
      await fixture;
    } finally {
      signal.removeEventListener("abort", releaseHeldFences);
    }
  };
  signal.addEventListener("abort", releaseHeldFences, { once: true });
  onTestFinished(finish);
  control?.onFinish?.(finish);
  if (signal.aborted) {
    releaseHeldFences();
  }
  fixture = withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    signal.throwIfAborted();
    control?.onState?.(state);
    const agentId = "worker";
    const sessionKey = "agent:worker:dashboard:incognito-guarded";
    const storePath = resolveSessionStorePathCore(undefined, { agentId, env: state.env });
    const nativePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId, env: state.env });
    const cfg = { agents: { entries: { worker: {}, kept: {} } } };
    const shared = openOpenClawStateDatabase({ env: state.env });
    replaceSessionEntrySync(
      { agentId, sessionKey, env: state.env },
      {
        sessionId: "incognito-guarded",
        updatedAt: 1,
        incognito: true,
      },
    );
    const native = openOpenClawAgentDatabase({ agentId, env: state.env, path: nativePath });
    expect(fs.existsSync(shared.path)).toBe(true);
    const pending = withConfiguredSessionEntryReader(
      cfg,
      {
        agentId,
        sessionKey,
        storePath,
        env: state.env,
      },
      async (retained) => {
        signal.throwIfAborted();
        if (retained.kind !== "incognito") {
          throw new Error("Expected the process-held native owner");
        }
        // Admission and the actual native row read precede the hot-guard measurement.
        const read = retained.readEntry();
        read.assertCurrent();
        expect(read.entry?.sessionId).toBe("incognito-guarded");
        const expectGuardsWithoutDurableSql = (revoked: boolean) => {
          const statements = trackSqliteStatementExecutions(
            shared.db,
            ["durable"],
            () => "durable",
          );
          const exec = vi.spyOn(shared.db, "exec");
          try {
            for (let index = 0; index < 8; index++) {
              if (revoked) {
                expect(() => retained.assertCurrent()).toThrow(
                  /revoked|changed|no longer current|unavailable/,
                );
                expect(() => read.assertCurrent()).toThrow(
                  /revoked|changed|no longer current|unavailable/,
                );
              } else {
                retained.assertCurrent();
                read.assertCurrent();
              }
            }
            expect(statements.counts.durable).toBe(0);
            expect(exec).not.toHaveBeenCalled();
          } finally {
            statements.restore();
            exec.mockRestore();
          }
        };
        expectGuardsWithoutDurableSql(false);
        expect(native.db.isOpen).toBe(true);
        if (ending === "deletion") {
          const durable = openOpenClawAgentDatabase({ agentId, env: state.env });
          control?.onNativeHandles?.(() => ({
            durableOpen: durable.db.isOpen,
            nativeOpen: native.db.isOpen,
          }));
          let revocations = 0;
          let closes = 0;
          let settled = false;
          let preparing: ReturnType<typeof prepareAgentDeleteDatabases> | undefined;
          const unregister = registerOpenClawAgentDatabaseAsyncResource({
            agentId,
            path: durable.path,
            revoke: () => {
              revocations++;
            },
            close: async () => {
              closes++;
              if (control?.beforeDrainEntry) {
                await control.beforeDrainEntry();
              }
              entered.resolve();
              control?.onDrainEntry?.();
              await release.promise;
              if (control?.afterGateRelease) {
                await control.afterGateRelease();
              }
            },
          });
          try {
            beginAgentDeletionJournal(
              {
                agentId,
                operationId: "delete-incognito-guarded",
                agentDir: path.dirname(durable.path),
                workspaceDir: state.statePath("workspace-worker"),
                sessionsDir: state.sessionsDir(agentId),
                deleteFiles: true,
              },
              { env: state.env },
            );
            preparing = prepareAgentDeleteDatabases(cfg, agentId, path.dirname(durable.path), {
              env: state.env,
            });
            void preparing.then(
              () => {
                settled = true;
              },
              () => {
                settled = true;
              },
            );
            await racePromiseWithAbortSignal(
              Promise.race([
                entered.promise,
                preparing.then(() => {
                  throw new Error("Deletion ended before its durable drain");
                }),
              ]),
              signal,
            );
            signal.throwIfAborted();
            // The real resource owner is still draining, not a post-cleanup observation.
            expect(settled).toBe(false);
            expect(revocations).toBe(1);
            expect(closes).toBe(1);
            expect(durable.db.isOpen).toBe(true);
            expectGuardsWithoutDurableSql(true);
            expect(native.db.isOpen).toBe(false);
            expect(() => retained.readEntry()).toThrow(
              /revoked|changed|no longer current|unavailable/,
            );
            expect(() =>
              readExactSessionEntryFromSourceReadOnly({
                readSource: { agentId, path: nativePath },
                sessionKey,
                env: state.env,
              }),
            ).toThrow("is deleted");
            expect(() =>
              openOpenClawAgentDatabase({ agentId, env: state.env, path: nativePath }),
            ).toThrow("is deleted");
            let freshEntered = false;
            await expect(
              withConfiguredSessionEntryReader(
                cfg,
                {
                  agentId,
                  sessionKey,
                  storePath,
                  env: state.env,
                },
                () => {
                  signal.throwIfAborted();
                  freshEntered = true;
                },
              ),
            ).rejects.toThrow("is deleted");
            signal.throwIfAborted();
            expect(freshEntered).toBe(false);

            // Roll back the actual journal while the same durable close remains held.
            control?.onJournalRollback?.();
            expect(
              removeAgentDeletionJournal(agentId, "delete-incognito-guarded", {
                env: state.env,
              }),
            ).toBe(true);
            expectGuardsWithoutDurableSql(true);
            control?.onFreshOwner?.();
            const replacement = openOpenClawAgentDatabase({
              agentId,
              env: state.env,
              path: nativePath,
            });
            expect(replacement).not.toBe(native);
            expect(replacement.db.isOpen).toBe(true);
            await withConfiguredSessionEntryReader(
              cfg,
              {
                agentId,
                sessionKey,
                storePath,
                env: state.env,
              },
              (fresh) => {
                signal.throwIfAborted();
                if (fresh.kind !== "incognito") {
                  throw new Error("Expected the new native owner");
                }
                const missing = fresh.readEntry();
                missing.assertCurrent();
                expect(missing.entry).toBeUndefined();
              },
            );
            signal.throwIfAborted();
            expectGuardsWithoutDurableSql(true);
            expect(() => retained.readEntry()).toThrow(
              /revoked|changed|no longer current|unavailable/,
            );
            expect(settled).toBe(false);
            expect(durable.db.isOpen).toBe(true);
            release.resolve();
            const plan = await racePromiseWithAbortSignal(preparing, signal);
            signal.throwIfAborted();
            expect(settled).toBe(true);
            expect(durable.db.isOpen).toBe(false);
            expect(plan.registrationPaths).not.toContain(nativePath);
            expect(plan.fileGroups.flat()).not.toContain(nativePath);
          } finally {
            release.resolve();
            // Preparation is joined before unregister/close; none accepts test cancellation.
            const [preparation] = await Promise.allSettled([preparing]);
            let registration: NativeOperationSettlement;
            try {
              unregister();
              registration = { status: "fulfilled", value: undefined };
            } catch (reason) {
              registration = { status: "rejected", reason };
            }
            const [nativeClose] = await Promise.allSettled([
              closeOpenClawAgentDatabaseByPathAsync(nativePath, agentId),
            ]);
            try {
              validateNativeChildOutcomes([
                {
                  label: "deletion preparation",
                  outcome: preparing ? preparation : undefined,
                  expected: preparing ? "fulfilled" : "not-admitted",
                },
                {
                  label: "deletion resource unregister",
                  outcome: registration,
                  expected: "fulfilled",
                },
                { label: "native close", outcome: nativeClose, expected: "fulfilled" },
              ]);
            } finally {
              control?.onDeletionJoined?.();
            }
          }
        } else {
          await closeOpenClawAgentDatabaseByPathAsync(nativePath, agentId);
        }
        signal.throwIfAborted();
        expect(native.db.isOpen).toBe(false);
        expect(() => retained.assertCurrent()).toThrow(
          /revoked|changed|no longer current|unavailable/,
        );
        expect(() => read.assertCurrent()).toThrow(/revoked|changed|no longer current|unavailable/);
        expect(fs.existsSync(nativePath)).toBe(false);
      },
    );
    try {
      await racePromiseWithAbortSignal(
        expect(pending).rejects.toThrow(/revoked|changed|no longer current|unavailable/),
        signal,
      );
      signal.throwIfAborted();
    } finally {
      releaseHeldFences();
      // This child cannot outlive withOpenClawTestState's native/temp-state teardown.
      const [reader] = await Promise.allSettled([pending]);
      try {
        control?.onReaderSettlement?.(reader);
      } finally {
        // Full state cleanup must still run when a child outcome is rejected by the verifier.
        control?.onOperationsJoined?.();
      }
    }
  });
  try {
    await fixture;
  } finally {
    await finish();
  }
}

export async function proveNativeDeletionAbort(
  phase: "before-drain-entry" | "held-drain",
  outer: TestContext,
): Promise<void> {
  const proof = createNativeAbortVerification(outer);
  const arrival = createDeferredCore();
  const releaseNative = createDeferredCore();
  const gateReleased = createDeferredCore();
  let deletionJoined = false;
  let rollbacks = 0;
  let freshOwners = 0;
  const native: { snapshot?: () => { durableOpen: boolean; nativeOpen: boolean } } = {};
  const release = () => releaseNative.resolve();
  outer.signal.addEventListener("abort", release, { once: true });
  if (outer.signal.aborted) {
    release();
  }
  const operation = proveNativeIncognitoGuardRetirement("deletion", proof.context, {
    ...proof.observation,
    onReaderSettlement: (outcome) => {
      validateNativeChildOutcomes([
        { label: "incognito reader", outcome, expected: "controlled-abort", reason: proof.reason },
      ]);
    },
    beforeDrainEntry:
      phase === "before-drain-entry"
        ? async () => {
            arrival.resolve();
            await releaseNative.promise;
          }
        : undefined,
    onDrainEntry: () => {
      if (phase === "held-drain") {
        arrival.resolve();
      }
    },
    afterGateRelease: async () => {
      gateReleased.resolve();
      await releaseNative.promise;
    },
    onJournalRollback: () => {
      rollbacks++;
    },
    onFreshOwner: () => {
      freshOwners++;
    },
    onDeletionJoined: () => {
      deletionJoined = true;
    },
    onNativeHandles: (snapshot) => {
      native.snapshot = snapshot;
    },
  });
  let finishing: Promise<void> | undefined;
  let finishReturned = false;
  try {
    await reachNativeAbortBoundary(arrival.promise, operation, outer.signal);
    const handles = native.snapshot;
    if (!handles) {
      throw new Error("Deletion did not acquire its real native handles");
    }
    expect(handles()).toEqual({ durableOpen: true, nativeOpen: false });
    proof.abort();
    expect(outer.signal.aborted).toBe(false);
    finishing = proof.finish().then(() => {
      finishReturned = true;
    });
    const fullCleanupBoundary = Promise.race([
      proof.cleaned,
      finishing.then(() => {
        throw new Error("Finish bypassed held fixture cleanup");
      }),
    ]);
    if (phase === "held-drain") {
      await reachNativeAbortBoundary(gateReleased.promise, operation, outer.signal);
      expect(deletionJoined).toBe(false);
      expect(finishReturned).toBe(false);
      expect(handles().durableOpen).toBe(true);
    }
    releaseNative.resolve();
    await reachNativeAbortBoundary(fullCleanupBoundary, operation, outer.signal);
    await reachNativeAbortBoundary(gateReleased.promise, operation, outer.signal);
    expect(deletionJoined).toBe(true);
    expect(handles()).toEqual({ durableOpen: false, nativeOpen: false });
    expect(finishReturned).toBe(false);
    expect(rollbacks).toBe(0);
    expect(freshOwners).toBe(0);
    expect(proof.events).toEqual(["operations-joined", "cleanup-entered", "root-removed"]);
    proof.releaseCleanup();
    await expectControlledNativeAbort(operation, proof.reason);
    await finishing;
    expect(finishReturned).toBe(true);
    proof.assertRootRemoved();
    expect(proof.events).toEqual([
      "operations-joined",
      "cleanup-entered",
      "root-removed",
      "cleanup-returned",
      "finish-returned",
    ]);
    await proof.finish();
    expect(rollbacks).toBe(0);
    expect(freshOwners).toBe(0);
    expect(proof.events.filter((event) => event === "cleanup-returned")).toHaveLength(1);
    proof.assertRootRemoved();
    expect(outer.signal.aborted).toBe(false);
  } finally {
    proof.abort();
    releaseNative.resolve();
    proof.releaseCleanup();
    try {
      await Promise.allSettled([operation, finishing]);
    } finally {
      outer.signal.removeEventListener("abort", release);
      await proof.dispose(operation);
    }
  }
}
