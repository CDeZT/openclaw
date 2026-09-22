import { beforeEach, describe, expect, it, vi } from "vitest";
import { disableCronJobsBoundToSessions } from "../../cron/job-session-bindings.js";
import { ensureSessionGroupRegistered } from "../session-groups.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { publishSessionPatchEffects } from "./sessions-patch-effects.js";
import type { GatewayRequestContext } from "./types.js";

vi.mock("../../cron/job-session-bindings.js", () => ({ disableCronJobsBoundToSessions: vi.fn() }));
vi.mock("../session-groups.js", () => ({ ensureSessionGroupRegistered: vi.fn() }));
vi.mock("../session-patch-hooks.js", () => ({ triggerSessionPatchHook: vi.fn() }));
vi.mock("./session-change-event.js", () => ({ emitSessionsChanged: vi.fn() }));
vi.mock("./sessions-patch-model-selection.js", () => ({
  persistSessionPatchModelSelection: vi.fn(),
}));
vi.mock("./sessions-shared.js", () => ({ sessionLog: { warn: vi.fn(), info: vi.fn() } }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(disableCronJobsBoundToSessions).mockResolvedValue(new Map());
});

describe("committed category patch effects", () => {
  function params(): Parameters<typeof publishSessionPatchEffects>[0] {
    return {
      cfg: {},
      context: { cron: {} } as GatewayRequestContext,
      callerScopes: [],
      callerCanManageCron: true,
      catalogChanged: false,
      targets: [
        {
          accessChanged: false,
          entry: { sessionId: "saved", updatedAt: 1, category: "Travel", archivedAt: 1 },
          target: {
            canonicalKey: "agent:main:travel",
            targetAgentId: "main",
            fullPatch: { key: "agent:main:travel", category: "Travel", archived: true },
          },
        },
      ],
    };
  }

  it.each([true, false])(
    "publishes only the accumulated catalog outcome inserted=%s",
    async (inserted) => {
      const patch = { ...params(), catalogChanged: inserted };
      // Multiple committed targets still produce one GLOBAL catalog invalidation.
      patch.targets.push({
        ...patch.targets[0]!,
        target: {
          canonicalKey: "agent:work:travel",
          targetAgentId: "work",
          requestedAgentId: "work",
          fullPatch: { key: "agent:work:travel", category: "Travel" },
        },
      });
      await publishSessionPatchEffects(patch);
      expect(ensureSessionGroupRegistered).not.toHaveBeenCalled();
      const groups = vi
        .mocked(emitSessionsChanged)
        .mock.calls.filter(([, event]) => event.reason === "groups");
      expect(groups).toEqual(
        inserted ? [[patch.context, { reason: "groups" }, { catalogOnly: true }]] : [],
      );
      expect(disableCronJobsBoundToSessions).toHaveBeenCalledOnce();
    },
  );

  it("does not invent registration or an event when no target committed", async () => {
    await publishSessionPatchEffects({ ...params(), targets: [] });
    expect(ensureSessionGroupRegistered).not.toHaveBeenCalled();
    expect(emitSessionsChanged).not.toHaveBeenCalled();
  });
});
