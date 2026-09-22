import { expectDefined } from "@openclaw/normalization-core";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { expect, it, vi } from "vitest";
import { getActiveSecretsRuntimeSnapshotState } from "../secrets/runtime-state.js";
import { createDeferredCore } from "../shared/deferred.js";
import { isPidAlive } from "../shared/pid-alive.js";
import {
  assertNoOpenClawAgentDatabaseLeasesReadOnly,
  OpenClawAgentDatabaseLeaseActiveError,
} from "../state/openclaw-agent-db-lease.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../state/openclaw-agent-db-resources.js";
import {
  listOpenIncognitoAgentDatabases,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";

it.each(["stop", "restart"] as const)(
  "releases agent leases for Doctor after the final Gateway %s while its process stays alive",
  async (mode) => {
    const fixture = await createGatewayMetadataCloseFixture(`gateway-agent-leases-${mode}`);
    const ownerPid = process.pid;
    try {
      const first = await fixture.start(await fixture.reservePort());
      const siblingPort = await fixture.reservePort();
      const sibling = await fixture.start(siblingPort);
      const options = { agentId: "main", env: fixture.state.env };
      const agent = openOpenClawAgentDatabase(options);
      const incognito = openOpenClawAgentDatabase({
        ...options,
        path: resolveIncognitoOpenClawAgentSqlitePath(options),
      });
      const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
      const inspectForDoctor = () =>
        assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: fixture.state.env });
      expect(inspectForDoctor).toThrow(OpenClawAgentDatabaseLeaseActiveError);
      const closeOptions = {
        reason: mode === "restart" ? "gateway restarting" : "gateway stopping",
        restartExpectedMs: mode === "restart" ? 1_500 : null,
      };

      await first.close(closeOptions);
      expect(agent.db.isOpen).toBe(true);
      expect(incognito.db.isOpen).toBe(true);
      expect(inspectForDoctor).toThrow(OpenClawAgentDatabaseLeaseActiveError);
      const response = await fetch(`http://127.0.0.1:${siblingPort}/healthz`);
      await response.body?.cancel();
      expect(response.ok).toBe(true);

      await sibling.close(closeOptions);
      expect(process.pid).toBe(ownerPid);
      expect(isPidAlive(ownerPid)).toBe(true);
      expect(inspectForDoctor).not.toThrow();
      expect(agent.db.isOpen).toBe(false);
      expect(shared.isOpen).toBe(false);
      expect(incognito.db.isOpen).toBe(false);
      expect(listOpenIncognitoAgentDatabases()).not.toContainEqual({
        agentId: "main",
        storePath: incognito.path,
      });
    } finally {
      await fixture.cleanup();
    }
  },
);

it("joins admitted agent database resources before releasing their lease and shared state", async () => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-agent-resource-close");
  const entered = createDeferredCore();
  const release = createDeferredCore();
  let closing: Promise<void> | undefined;
  let unregister: (() => void) | undefined;
  try {
    const server = await fixture.start(await fixture.reservePort());
    const agent = openOpenClawAgentDatabase({ agentId: "main", env: fixture.state.env });
    const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
    unregister = registerOpenClawAgentDatabaseAsyncResource({
      agentId: "main",
      path: agent.path,
      revoke() {},
      async close() {
        entered.resolve();
        await release.promise;
      },
    });
    closing = server.close({ reason: "gateway restarting", restartExpectedMs: 1_500 });
    await Promise.race([
      entered.promise,
      closing.then(() => {
        throw new Error("Gateway acknowledged closure before its agent resource joined");
      }),
    ]);
    expect(agent.db.isOpen).toBe(true);
    expect(shared.isOpen).toBe(true);
    expect(() => assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: fixture.state.env })).toThrow(
      OpenClawAgentDatabaseLeaseActiveError,
    );
    release.resolve();
    await closing;
    expect(agent.db.isOpen).toBe(false);
    expect(shared.isOpen).toBe(false);
    expect(() =>
      assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: fixture.state.env }),
    ).not.toThrow();
  } finally {
    release.resolve();
    await Promise.allSettled([closing]);
    unregister?.();
    await fixture.cleanup();
  }
});

it("rejects Gateway closure when an agent handle cannot close and retains its lease", async () => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-agent-close-failure");
  let restoreClose: (() => void) | undefined;
  try {
    const server = await fixture.start(await fixture.reservePort());
    const agent = openOpenClawAgentDatabase({ agentId: "main", env: fixture.state.env });
    const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
    const failure = new Error("native agent database close failed");
    const blockedClose = vi.spyOn(agent.db, "close").mockImplementation(() => {
      throw failure;
    });
    restoreClose = () => blockedClose.mockRestore();

    const outcome = await server
      .close({ reason: "gateway restarting", restartExpectedMs: 1_500 })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(collectNestedErrorCandidates(outcome)).toContain(failure);
    expect(agent.db.isOpen).toBe(true);
    expect(shared.isOpen).toBe(true);
    expect(getActiveSecretsRuntimeSnapshotState()).not.toBeNull();
    expect(() => assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: fixture.state.env })).toThrow(
      OpenClawAgentDatabaseLeaseActiveError,
    );
  } finally {
    restoreClose?.();
    await fixture.cleanup();
  }
});

it.each(["fulfilled", "rejected"] as const)(
  "joins %s question publication before closing Gateway databases and leases",
  async (outcome) => {
    const fixture = await createGatewayMetadataCloseFixture(`gateway-question-close-${outcome}`);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let closing: Promise<void> | undefined;
    let restoreDrain: (() => void) | undefined;
    try {
      const port = await fixture.reservePort();
      const server = await fixture.start(port);
      const manager = expectDefined(fixture.kernels.get(port)?.questionManager, "question owner");
      const agent = openOpenClawAgentDatabase({ agentId: "main", env: fixture.state.env });
      const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
      const onResolved = vi.fn(async () => {
        await release.promise;
        if (outcome === "rejected") {
          throw new Error("Question publication fixture failure");
        }
      });
      const record = manager.request({
        questions: [
          {
            questionId: "choice",
            header: "Choice",
            question: "Choose a response",
            options: [],
            isOther: true,
          },
        ],
        timeoutMs: 60_000,
        onResolved,
      });
      const observation = expectDefined(manager.observe(record.id), "question observation");
      const answers = { answers: { choice: ["Committed"] } };
      expect(manager.resolve(record.id, answers)).toEqual({ status: "answered", answers });
      expect(onResolved).toHaveBeenCalledOnce();
      const drain = manager.drain.bind(manager);
      const observedDrain = vi.spyOn(manager, "drain").mockImplementation(() => {
        entered.resolve();
        return drain();
      });
      restoreDrain = () => observedDrain.mockRestore();
      let closed = false;
      closing = server
        .close({ reason: "gateway restarting", restartExpectedMs: 1_500 })
        .then(() => {
          closed = true;
        });
      await Promise.race([
        entered.promise,
        closing.then(() => {
          throw new Error("Gateway closed before joining question publication");
        }),
      ]);
      expect(observedDrain).toHaveBeenCalledOnce();
      expect(() => manager.request({ questions: record.questions, timeoutMs: 100 })).toThrow(
        "Question manager is closed",
      );
      expect(closed).toBe(false);
      expect(agent.db.isOpen).toBe(true);
      expect(shared.isOpen).toBe(true);
      expect(() => assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: fixture.state.env })).toThrow(
        OpenClawAgentDatabaseLeaseActiveError,
      );
      release.resolve();
      await closing;
      expect(closed).toBe(true);
      expect(observation.record).toMatchObject({ status: "answered", answers });
      expect(agent.db.isOpen).toBe(false);
      expect(shared.isOpen).toBe(false);
      expect(() =>
        assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: fixture.state.env }),
      ).not.toThrow();
    } finally {
      release.resolve();
      await Promise.allSettled([closing]);
      restoreDrain?.();
      await fixture.cleanup();
    }
  },
);
