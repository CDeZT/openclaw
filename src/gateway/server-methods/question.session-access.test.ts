import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { addSessionMember } from "../../config/sessions/session-sharing-store.js";
import { releaseAgentRunDelegatedAuthority } from "../../infra/agent-run-registry.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createGatewayBroadcaster } from "../server-broadcast.js";
import { GatewayClientRegistry } from "../server/client-registry.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { canReceiveSessionEvent } from "../session-sharing.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import {
  adminRequestClient,
  broadcast,
  callQuestionRpc,
  installQuestionTestHooks,
  manager,
  requesterAuthority,
  requestParams,
  secretRequestParams,
} from "./question.test-support.js";
import type { GatewayClient } from "./types.js";

installQuestionTestHooks();

async function fixture(state: OpenClawTestState, options?: { foreign?: boolean }) {
  const owner = roleClient("view", "question-owner");
  const viewer = roleClient("write", "question-viewer");
  const cfg = rolePolicyConfig(["guest"]);
  cfg.gateway!.roles!.definitions.view!.scopes.push("operator.questions");
  cfg.gateway!.roles!.definitions.write!.sessions.others = "view";
  cfg.gateway!.roles!.definitions.write!.scopes.push("operator.questions");
  await state.writeConfig(cfg);
  setRuntimeConfigSnapshot(cfg);
  owner.connect.scopes = ["operator.sessions.write"];
  viewer.connect.scopes = ["operator.sessions.read", "operator.sessions.write"];
  const producer: GatewayClient = {
    ...owner,
    internal: {
      ...owner.internal,
      agentRuntimeIdentity: adminRequestClient.internal!.agentRuntimeIdentity,
    },
  };
  const entry = {
    sessionId: "question-session",
    lifecycleRevision: "question-generation",
    updatedAt: 1,
    visibility: "shared" as const,
    createdActor: {
      type: "human" as const,
      source: "profile" as const,
      id: (options?.foreign ? viewer : owner).authenticatedUserProfile!.profileId,
    },
  };
  const write = (delta: Partial<typeof entry> = {}) =>
    upsertSessionEntryCore(
      { agentId: "main", sessionKey: requestParams.sessionKey },
      { ...entry, ...delta },
    );
  await write();
  expect(
    loadSessionEntry({ agentId: "main", sessionKey: requestParams.sessionKey })?.createdActor,
  ).toEqual(entry.createdActor);
  const call = (
    method: string,
    params: Record<string, unknown>,
    client = owner,
    current?: () => boolean,
  ) =>
    callQuestionRpc(method, params, {
      client,
      cfg,
      throughRouter: true,
      hasCurrentClientAuthority: current,
    });
  const request = (id = "ordinary-question", client = producer) =>
    call("question.request", { ...requestParams, id, timeoutMs: 10_000 }, client);
  return { owner, viewer, producer, cfg, entry, write, call, request };
}

it("binds a narrow producer to its trusted session and lets its browser answer after label changes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const f = await fixture(state);
    expect(
      await f.call(
        "question.request",
        {
          ...requestParams,
          id: "trusted-route",
          agentId: "other",
          sessionKey: "agent:other:foreign",
          runId: "forged",
        },
        f.producer,
      ),
    ).toMatchObject([true, { id: "trusted-route" }, undefined]);
    expect(manager.get("trusted-route")).toMatchObject({
      agentId: "main",
      sessionKey: requestParams.sessionKey,
      runId: requestParams.runId,
    });
    const waiting = f.call("question.waitAnswer", { id: "trusted-route" });
    const settled = Promise.allSettled([waiting]);
    try {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: requestParams.sessionKey },
        {
          ...f.entry,
          updatedAt: 2,
          label: "Renamed while answering",
          markedUnreadAt: 2,
        },
      );
      const answers = { answers: { destination: ["Home"] } };
      expect(await f.call("question.resolve", { id: "trusted-route", answers })).toEqual([
        true,
        { status: "answered", answers },
        undefined,
      ]);
      // Completion retires requester liveness, not the ordinary question's retained read facts.
      releaseAgentRunDelegatedAuthority(requesterAuthority);
      expect(await waiting).toEqual([true, { status: "answered", answers }, undefined]);
      expect(await f.call("question.get", { id: "trusted-route" })).toMatchObject([
        true,
        { question: { status: "answered", answers } },
        undefined,
      ]);
    } finally {
      manager.close();
      await settled;
    }
  });
});

it.each(["shared", "draft"] as const)(
  "fans out cross-agent questions with current %s visibility and no global event grant",
  async (visibility) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const f = await fixture(state);
      const peer = (client: GatewayClient, connId: string) => {
        const send = vi.fn();
        const socket = { readyState: 1, bufferedAmount: 0, send, close: vi.fn() };
        const ws: GatewayWsClient = {
          ...client,
          connId,
          usesSharedGatewayAuth: false,
          socket: socket as unknown as GatewayWsClient["socket"],
        };
        return { ws, send };
      };
      const owner = peer(f.owner, "question-owner");
      const viewer = peer(f.viewer, "question-viewer");
      const broad = peer(
        { ...f.owner, connect: { ...f.owner.connect, scopes: ["operator.questions"] } },
        "broad-questions",
      );
      const broadcaster = createGatewayBroadcaster({
        clients: new GatewayClientRegistry([owner.ws, viewer.ws, broad.ws]),
        canReceiveSessionEvent: (client, sessionKeys, agentId, event, payload) =>
          canReceiveSessionEvent({ cfg: f.cfg, client, sessionKeys, agentId, event, payload }),
      });
      broadcast.mockImplementation(broadcaster.broadcast);
      expect((await f.request())[0]).toBe(true);
      expect(owner.send).toHaveBeenCalledOnce();
      expect(viewer.send).toHaveBeenCalledOnce();
      expect(broad.send).toHaveBeenCalledOnce();
      const requested = broadcast.mock.calls.find(([event]) => event === "question.requested")!;
      const get = vi.spyOn(manager, "get");
      try {
        broadcaster.broadcast(requested[0], requested[1], requested[2]);
        expect(get).not.toHaveBeenCalled();
      } finally {
        get.mockRestore();
      }
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: requestParams.sessionKey },
        { ...f.entry, visibility },
      );
      owner.send.mockClear();
      viewer.send.mockClear();
      broad.send.mockClear();
      manager.resolve("ordinary-question", { answers: { destination: ["Own answer"] } });
      expect(owner.send).toHaveBeenCalledOnce();
      expect(viewer.send).toHaveBeenCalledTimes(visibility === "shared" ? 1 : 0);
      expect(broad.send).toHaveBeenCalledOnce();
      const resolved = broadcast.mock.calls.find(([event]) => event === "question.resolved")!;
      manager.reset();
      manager.request({ ...requestParams, id: "ordinary-question" });
      owner.send.mockClear();
      broad.send.mockClear();
      broadcaster.broadcast(resolved[0], resolved[1], resolved[2]);
      expect(owner.send).not.toHaveBeenCalled();
      expect(broad.send).toHaveBeenCalledOnce();
      for (const event of [
        "question.requested",
        "question.resolved",
        "exec.approval.requested",
        "config.changed",
      ]) {
        owner.send.mockClear();
        viewer.send.mockClear();
        broadcaster.broadcast(event, { id: "unbound" });
        expect(owner.send).not.toHaveBeenCalled();
        expect(viewer.send).not.toHaveBeenCalled();
      }
      broadcaster.broadcast("chat.metadata.changed", {});
      for (const recipient of [owner, viewer]) {
        expect(recipient.send).toHaveBeenCalledOnce();
        expect(JSON.parse(recipient.send.mock.calls[0]![0])).toMatchObject({
          event: "chat.metadata.changed",
          payload: {},
        });
      }
    });
  },
);

it.each(["answered", "cancelled", "expired"] as const)(
  "keeps secret requested and %s events off narrow fanout",
  async (status) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const f = await fixture(state);
      const send = vi.fn();
      const socket = { readyState: 1, bufferedAmount: 0, send, close: vi.fn() };
      const client: GatewayWsClient = {
        ...f.owner,
        connId: "narrow-secret",
        usesSharedGatewayAuth: false,
        socket: socket as unknown as GatewayWsClient["socket"],
      };
      const broadcaster = createGatewayBroadcaster({
        clients: new GatewayClientRegistry([client]),
      });
      broadcast.mockImplementation(broadcaster.broadcast);
      expect(
        (
          await f.call(
            "question.request",
            { ...secretRequestParams, id: "secret-event" },
            adminRequestClient,
          )
        )[0],
      ).toBe(true);
      if (status === "answered") {
        expect(
          (
            await f.call(
              "question.resolve",
              { id: "secret-event", answers: { answers: { secret_value: ["synthetic-value"] } } },
              adminRequestClient,
            )
          )[0],
        ).toBe(true);
      }
      if (status === "cancelled") {
        manager.cancel("secret-event");
      }
      if (status === "expired") {
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(broadcast.mock.calls.map(([event]) => event)).toEqual([
        "question.requested",
        "question.resolved",
      ]);
      expect(send).not.toHaveBeenCalled();
    });
  },
);

it.each(["pending", "answered"] as const)(
  "retains physical store identity while %s",
  async (status) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const f = await fixture(state);
      expect((await f.request())[0]).toBe(true);
      if (status === "answered") {
        manager.resolve("ordinary-question", { answers: { destination: ["Original"] } });
      }
      const replacement = state.statePath("replacement", "catalog.sqlite");
      await upsertSessionEntryCore(
        { agentId: "main", storePath: replacement, sessionKey: requestParams.sessionKey },
        f.entry,
      );
      f.cfg.session = { ...f.cfg.session, store: replacement };
      await state.writeConfig(f.cfg);
      setRuntimeConfigSnapshot(f.cfg);
      for (const method of ["question.get", "question.waitAnswer"]) {
        expect(await f.call(method, { id: "ordinary-question" })).toMatchObject([
          false,
          undefined,
          { details: { reason: "QUESTION_NOT_FOUND" } },
        ]);
      }
      expect(manager.get("ordinary-question")?.status).toBe(status);
    });
  },
);

it("preserves cross-agent shared VIEW while narrow answer and cancel require the creator", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const f = await fixture(state);
    expect((await f.request())[0]).toBe(true);
    addSessionMember(
      { agentId: "main", sessionKey: requestParams.sessionKey },
      {
        identityId: f.viewer.authenticatedUserProfile!.profileId,
        addedBy: f.owner.authenticatedUserProfile!.profileId,
        expectedSessionId: f.entry.sessionId,
      },
    );
    expect((await f.call("question.get", { id: "ordinary-question" }, f.viewer))[0]).toBe(true);
    expect(await f.call("question.list", {}, f.viewer)).toMatchObject([
      true,
      { questions: [{ id: "ordinary-question" }] },
      undefined,
    ]);
    const waiting = f.call("question.waitAnswer", { id: "ordinary-question" }, f.viewer);
    const settled = Promise.allSettled([waiting]);
    try {
      for (const params of [
        { cancel: true },
        { answers: { answers: { destination: ["Home"] } } },
      ]) {
        expect(
          await f.call("question.resolve", { id: "ordinary-question", ...params }, f.viewer),
        ).toMatchObject([false, undefined, { details: { reason: "QUESTION_NOT_FOUND" } }]);
        expect(manager.get("ordinary-question")?.status).toBe("pending");
      }
      const answers = { answers: { destination: ["Home"] } };
      expect((await f.call("question.resolve", { id: "ordinary-question", answers }))[0]).toBe(
        true,
      );
      expect(await waiting).toEqual([true, { status: "answered", answers }, undefined]);
    } finally {
      if (manager.get("ordinary-question")?.status === "pending") {
        manager.cancel("ordinary-question");
      }
      await settled;
    }
    // The independent questions grant keeps the existing member-based answer contract.
    expect((await f.request("member-question"))[0]).toBe(true);
    f.viewer.connect.scopes!.push("operator.questions");
    expect(
      await f.call("question.resolve", { id: "member-question", cancel: true }, f.viewer),
    ).toEqual([true, { status: "cancelled" }, undefined]);
  });
});

it.each([
  "missing identity",
  "closed claim",
  "foreign",
  "absent",
  "incognito",
  "secret",
  "disallowed agent",
] as const)("refuses narrow question creation with %s before creating a record", async (kind) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const f = await fixture(state, { foreign: kind === "foreign" });
    let client = f.producer;
    if (kind === "missing identity") {
      client = f.owner;
    }
    if (kind === "closed claim") {
      releaseAgentRunDelegatedAuthority(requesterAuthority);
    }
    if (kind === "disallowed agent") {
      f.cfg.gateway!.roles!.definitions.view!.agents = ["guest"];
      await state.writeConfig(f.cfg);
      setRuntimeConfigSnapshot(f.cfg);
    }
    if (kind === "absent") {
      client = {
        ...client,
        internal: {
          ...client.internal,
          agentRuntimeIdentity: {
            ...client.internal!.agentRuntimeIdentity!,
            sessionKey: "agent:main:missing",
          },
        },
      };
    }
    if (kind === "incognito") {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: requestParams.sessionKey },
        { ...f.entry, incognito: true },
      );
    }
    const response = await f.call(
      "question.request",
      {
        ...(kind === "secret" ? secretRequestParams : requestParams),
        id: "refused-question",
      },
      client,
    );
    expect(response[0]).toBe(false);
    expect(response[1]).toBeUndefined();
    expect(manager.get("refused-question")).toBeNull();
  });
});

it.each(["pending", "answered", "cancelled", "expired"] as const)(
  "hides secret question metadata and answers from narrow readers while %s",
  async (status) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const f = await fixture(state);
      const response = await f.call(
        "question.request",
        { ...secretRequestParams, id: "secret-question" },
        adminRequestClient,
      );
      expect(response[0]).toBe(true);
      if (status === "answered") {
        expect(
          (
            await f.call(
              "question.resolve",
              {
                id: "secret-question",
                answers: { answers: { secret_value: ["synthetic-test-value"] } },
              },
              adminRequestClient,
            )
          )[0],
        ).toBe(true);
      }
      if (status === "cancelled") {
        manager.cancel("secret-question");
      }
      if (status === "expired") {
        await vi.advanceTimersByTimeAsync(100);
      }
      for (const method of ["question.get", "question.waitAnswer"]) {
        expect(await f.call(method, { id: "secret-question" })).toMatchObject([
          false,
          undefined,
          { details: { reason: "QUESTION_NOT_FOUND" } },
        ]);
      }
      expect(await f.call("question.list", {})).toEqual([true, { questions: [] }, undefined]);
      expect(manager.get("secret-question")?.status).toBe(status);
      expect((await f.call("question.get", { id: "secret-question" }, adminRequestClient))[0]).toBe(
        true,
      );
    });
  },
);

it.each(["generation", "session", "visibility", "profile", "source", "reused id"] as const)(
  "does not publish a held answer after %s changes",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const f = await fixture(state);
      expect((await f.request())[0]).toBe(true);
      const entered = createDeferredCore();
      const wait = manager.waitAnswer.bind(manager);
      const spy = vi.spyOn(manager, "waitAnswer").mockImplementation((...args) => {
        const result = wait(...args);
        entered.resolve();
        return result;
      });
      let current = true;
      const waiting = f.call(
        "question.waitAnswer",
        { id: "ordinary-question" },
        f.viewer,
        () => current,
      );
      const settled = Promise.allSettled([waiting]);
      try {
        await Promise.race([entered.promise, waiting]);
        expect(spy).toHaveBeenCalledOnce();
        if (change === "generation") {
          await f.write({ lifecycleRevision: "replacement" });
        }
        if (change === "session") {
          await f.write({ sessionId: "replacement" });
        }
        if (change === "visibility") {
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey: requestParams.sessionKey },
            { ...f.entry, visibility: "draft" },
          );
        }
        if (change === "profile") {
          f.viewer.authenticatedUserProfile = f.owner.authenticatedUserProfile;
        }
        if (change === "source") {
          current = false;
        }
        if (change === "reused id") {
          manager.reset();
          manager.request({ ...requestParams, id: "ordinary-question" });
        } else {
          manager.resolve("ordinary-question", { answers: { destination: ["Committed answer"] } });
        }
        const outcome = (await settled)[0];
        if (change === "source") {
          expect(outcome).toMatchObject({
            status: "rejected",
            reason: { message: "Gateway requester authority changed" },
          });
        } else {
          expect(outcome).toMatchObject({
            status: "fulfilled",
            value: [false, undefined, { details: { reason: "QUESTION_NOT_FOUND" } }],
          });
        }
        expect(manager.get("ordinary-question")?.status).toBe(
          change === "reused id" ? "pending" : "answered",
        );
      } finally {
        manager.close();
        await settled;
        spy.mockRestore();
      }
    });
  },
);
