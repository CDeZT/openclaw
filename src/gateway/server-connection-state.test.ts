import { describe, expect, it, onTestFinished, vi } from "vitest";
import { WebSocket } from "ws";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { createSessionRowProjection } from "./session-row-projection.js";

type ConnectionIdReads = { count: number };

function makeClient(
  connId: string,
  reads: ConnectionIdReads,
  sendOrder?: string[],
): {
  client: GatewayWsClient;
  socket: { readyState: number };
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn(() => sendOrder?.push(connId));
  const socket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    close: vi.fn(),
    send,
  };
  const client = {
    socket: socket as unknown as GatewayWsClient["socket"],
    connect: {
      role: "operator",
      scopes: ["operator.read"],
    } as GatewayWsClient["connect"],
    usesSharedGatewayAuth: false,
  } as GatewayWsClient;
  Object.defineProperty(client, "connId", {
    enumerable: true,
    get: () => {
      reads.count += 1;
      return connId;
    },
  });
  return { client, socket, send };
}

describe("gateway connection state", () => {
  it("uses committed policy for projected and plain session events through tentative activation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const reader = ensureProfileForEmail("event-policy-reader@example.test");
      const other = ensureProfileForEmail("event-policy-other@example.test");
      const config = (others: "none" | "view"): OpenClawConfig => ({
        agents: { entries: { main: {} } },
        gateway: {
          roles: {
            default: "reader",
            definitions: {
              reader: {
                sessions: { others },
                agents: ["main"],
                scopes: ["operator.sessions.read"],
              },
            },
          },
        },
      });
      const restricted = config("none");
      const relaxed = config("view");
      let runtimeConfig = restricted;
      let committedConfig = restricted;
      setRuntimeConfigSnapshot(runtimeConfig);
      const ownKey = "agent:main:policy-own";
      const foreignKey = "agent:main:policy-foreign";
      for (const [sessionKey, profileId] of [
        [ownKey, reader.id],
        [foreignKey, other.id],
      ] as const) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: sessionKey,
            updatedAt: 1,
            visibility: "shared",
            createdActor: { type: "human", source: "profile", id: profileId },
          },
        );
      }
      const state = createGatewayConnectionState({
        bootId: "committed-event-policy",
        cfg: restricted,
        getRuntimeConfig: () => runtimeConfig,
      });
      try {
        const projection = await createSessionRowProjection({
          cfg: runtimeConfig,
          getConfig: () => runtimeConfig,
          getPolicyConfig: () => committedConfig,
        });
        const detach = state.attachSessionRowProjection(projection);
        try {
          const peer = makeClient("policy-reader", { count: 0 });
          peer.client.connect.scopes = ["operator.sessions.read"];
          peer.client.connect.client = {
            id: "openclaw-control-ui",
            version: "test",
            platform: "web",
            mode: "webchat",
          };
          peer.client.authenticatedUserProfile = {
            profileId: reader.id,
            displayName: "Reader",
            avatarRevision: "test",
            hasAvatar: false,
            updatedAt: reader.updatedAt,
          };
          prepareGatewayRecipientProfile(peer.client);
          state.clients.add(peer.client);
          const publish = (stage: string, visibleKeys: string[]) => {
            peer.send.mockClear();
            for (const sessionKey of [ownKey, foreignKey]) {
              const scope = { sessionKeys: [sessionKey], agentId: "main" };
              state.broadcast("sessions.changed", { sessionKey, reason: "metadata" }, scope);
              state.broadcast(
                "chat",
                {
                  sessionKey,
                  runId: "policy-run",
                  seq: 1,
                  state: "delta",
                  message: { role: "assistant", content: [{ type: "text", text: sessionKey }] },
                },
                scope,
              );
            }
            const frames = peer.send.mock.calls.map(([frame]): unknown => {
              if (typeof frame !== "string") {
                throw new Error("expected a serialized Gateway event");
              }
              return JSON.parse(frame);
            });
            expect.soft(frames, stage).toEqual(
              visibleKeys.flatMap((sessionKey) => [
                expect.objectContaining({
                  event: "sessions.changed",
                  payload: expect.objectContaining({
                    sessionKey,
                    session: expect.objectContaining({ key: sessionKey }),
                  }),
                }),
                expect.objectContaining({
                  event: "chat",
                  payload: expect.objectContaining({
                    sessionKey,
                    message: { role: "assistant", content: [{ type: "text", text: sessionKey }] },
                  }),
                }),
              ]),
            );
          };
          await projection.ensureMaterialized();
          publish("serving policy", [ownKey]);
          runtimeConfig = relaxed;
          setRuntimeConfigSnapshot(runtimeConfig);
          await projection.ensureMaterialized();
          publish("tentative relaxation", [ownKey]);
          runtimeConfig = restricted;
          setRuntimeConfigSnapshot(runtimeConfig);
          await projection.ensureMaterialized();
          publish("rollback", [ownKey]);
          runtimeConfig = relaxed;
          setRuntimeConfigSnapshot(runtimeConfig);
          await projection.ensureMaterialized();
          committedConfig = relaxed;
          publish("committed relaxation without a projection mark", [ownKey, foreignKey]);
        } finally {
          detach();
          projection.dispose();
        }
      } finally {
        state.mentionInbox.dispose();
      }
    });
  });

  it("advertises online people only through live operator connections", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const state = createGatewayConnectionState({
        bootId: "online-recipients",
        cfg: { agents: { entries: { main: {} } } },
      });
      onTestFinished(() => state.mentionInbox.dispose());
      const reads = { count: 0 };
      const requester = makeClient("requester", reads);
      const recipient = makeClient("recipient", reads);
      for (const [name, peer] of [
        ["requester", requester],
        ["recipient", recipient],
      ] as const) {
        peer.client.connect.client = {
          id: "openclaw-control-ui",
          version: "test",
          platform: "web",
          mode: "webchat",
        };
        peer.client.authenticatedUserProfile = {
          profileId: ensureProfileForEmail(`${name}@example.test`).id,
          displayName: name,
          avatarRevision: "test",
          hasAvatar: false,
          updatedAt: 1,
        };
        state.clients.add(peer.client);
      }
      const recipientOnline = async () => {
        let online: boolean | undefined;
        await state.mentionInbox.mentionable(
          requester.client,
          { agentId: "main", visibility: "shared" },
          (result) => {
            if (!result.ok) {
              throw new Error(result.error.message);
            }
            online = result.value.users.find(
              (user) => user.profileId === recipient.client.authenticatedUserProfile?.profileId,
            )?.online;
          },
        );
        return online;
      };

      expect(await recipientOnline()).toBe(true);
      recipient.socket.readyState = WebSocket.CLOSING;
      expect(await recipientOnline()).toBe(false);
      recipient.socket.readyState = WebSocket.OPEN;
      recipient.client.connect.role = "node";
      expect(await recipientOnline()).toBe(false);
      recipient.client.connect.role = "operator";
      recipient.client.invalidated = true;
      expect(await recipientOnline()).toBe(false);
    });
  });

  it("bounds targeted delivery and connection lookups to the requested connection", () => {
    const state = createGatewayConnectionState({
      bootId: "targeted-delivery",
      cfg: {} as OpenClawConfig,
    });
    onTestFinished(() => state.mentionInbox.dispose());
    const reads = { count: 0 };
    for (let index = 0; index < 256; index += 1) {
      state.clients.add(makeClient(`other-${index}`, reads).client);
    }
    const target = makeClient("target", reads);
    state.clients.add(target.client);
    reads.count = 0;

    state.broadcastToConnIds("tick", { ts: 1 }, new Set(["target"]));

    expect(target.send).toHaveBeenCalledTimes(1);
    expect(state.getBufferedAmount("target")).toBe(0);
    expect(reads.count).toBe(0);

    target.socket.readyState = WebSocket.CLOSING;
    state.broadcastToConnIds("tick", { ts: 2 }, new Set(["target"]));

    expect(target.send).toHaveBeenCalledTimes(1);

    reads.count = 0;
    expect(state.getBufferedAmount("target")).toBeUndefined();
    expect(state.isConnectionActive("target")).toBe(true);
    expect(reads.count).toBe(0);

    const firstRequest = state.clients.retainRequest(target.client);
    const secondRequest = state.clients.retainRequest(target.client);
    state.clients.delete(target.client);
    expect(
      [...state.clients.authorityClients].filter((client) => client === target.client),
    ).toHaveLength(1);
    firstRequest();
    firstRequest();
    expect([...state.clients.authorityClients]).toContain(target.client);
    reads.count = 0;
    state.broadcastToConnIds("tick", { ts: 3 }, new Set(["target"]));

    expect(target.send).toHaveBeenCalledTimes(1);
    expect(state.getBufferedAmount("target")).toBeUndefined();
    expect(state.isConnectionActive("target")).toBe(false);
    expect(reads.count).toBe(0);

    secondRequest();
    expect([...state.clients.authorityClients]).not.toContain(target.client);
    state.clients.add(target.client);
    state.clients.clear();
    reads.count = 0;

    expect(state.getBufferedAmount("target")).toBeUndefined();
    expect(state.isConnectionActive("target")).toBe(false);
    expect(reads.count).toBe(0);
  });

  it("preserves connection insertion order for targeted fanout", () => {
    const state = createGatewayConnectionState({
      bootId: "ordered-delivery",
      cfg: {} as OpenClawConfig,
    });
    onTestFinished(() => state.mentionInbox.dispose());
    const reads = { count: 0 };
    const sendOrder: string[] = [];
    state.clients.add(makeClient("first", reads, sendOrder).client);
    state.clients.add(makeClient("unrelated", reads, sendOrder).client);
    state.clients.add(makeClient("last", reads, sendOrder).client);

    state.broadcastToConnIds("tick", { ts: 1 }, new Set(["last", "first"]));

    expect(sendOrder).toEqual(["first", "last"]);
  });
});
