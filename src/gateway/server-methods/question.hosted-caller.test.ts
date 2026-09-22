import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import { createAskUserTool } from "../../agents/tools/ask-user-tool.js";
import { resetPendingAskUserQuestionsForTest } from "../../agents/tools/ask-user-tool.test-support.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { bindGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-identity-token.js";
import { createGatewayMethodRegistry } from "../methods/registry.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { QuestionManager } from "../question-manager.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { createQuestionHandlers } from "./question.js";
import { createSecretStoreWriteService } from "./secrets.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "./types.js";

afterEach(() => {
  resetPendingAskUserQuestionsForTest();
});

const sessionKey = "agent:main:hosted-question";
const toolArgs = {
  questions: [
    {
      id: "destination",
      header: "Destination",
      question: "Where next?",
      options: [{ label: "Home" }, { label: "Elsewhere" }],
    },
  ],
};

async function withHostedQuestion(
  run: (fixture: {
    ask: () => Promise<Awaited<ReturnType<ReturnType<typeof createAskUserTool>["execute"]>>>;
    waiting: Promise<void>;
    manager: QuestionManager;
    answer: (id: string) => Promise<Parameters<RespondFn>>;
    read: (id: string) => Promise<Parameters<RespondFn>>;
    request: ReturnType<typeof vi.fn<(options: GatewayRequestHandlerOptions) => Promise<void>>>;
    revoke: () => void;
    closeParent: () => void;
  }) => Promise<void>,
  foreign = false,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = rolePolicyConfig();
    cfg.gateway!.roles!.definitions.view!.scopes = ["operator.sessions.write"];
    cfg.session = { store: state.path("sessions.json") };
    cfg.agents = { defaults: { workspace: state.workspaceDir }, entries: { main: {} } };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const browser = roleClient("view", "hosted-question-owner");
    browser.connect.scopes = ["operator.sessions.write"];
    const profileId = expectDefined(browser.authenticatedUserProfile, "original person").profileId;
    const scope = { agentId: "main", sessionKey, storePath: cfg.session.store };
    await upsertSessionEntryCore(scope, {
      sessionId: "hosted-question-session",
      lifecycleRevision: "hosted-question-generation",
      updatedAt: 1,
      visibility: "shared",
      createdActor: { type: "human", source: "profile", id: foreign ? "other-person" : profileId },
    });
    expect(loadSessionEntry(scope)?.createdActor?.id).toBe(foreign ? "other-person" : profileId);
    const manager = new QuestionManager();
    const waiting = createDeferredCore();
    const context = createDirectChatContext({
      getRuntimeConfig: () => cfg,
      questionManager: manager,
      validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    });
    context.resolveGatewayContext = () => context;
    const source = new AbortController();
    const captured = expectDefined(
      captureGatewayOperatorRunAuthority({
        client: browser,
        context,
        sourceAuthority: {
          signal: source.signal,
          assertCurrent: () => source.signal.throwIfAborted(),
        },
      }),
      "original operator source",
    );
    const parent = prepareSystemAgentRunAdmission(
      cfg,
      "hosted-question-run",
      "main",
      "question-test",
      undefined,
      captured.authority,
    );
    const admitted = await parent.admit("embedded");
    bindGatewayContextResolver(admitted, () => context);
    const caller = expectDefined(
      createAdmittedGatewayToolCallerIdentity({
        admittedRunContext: admitted,
        agentId: "main",
        sessionKey,
      }),
      "hosted caller",
    );
    const handlers = createQuestionHandlers(
      manager,
      createSecretStoreWriteService({ reloadSecrets: async () => ({ warningCount: 0 }) }),
    );
    const request = vi.fn(async (options: GatewayRequestHandlerOptions) => {
      expect(options.client?.internal?.syntheticClient).toBe(true);
      expect(options.client?.connect.scopes).toEqual(["operator.sessions.write"]);
      expect(readGatewayRequestMutationAuthority(options).sessionScope).toBe(
        "operator.sessions.write",
      );
      expect(options.client?.internal?.operatorRoleActor).toEqual({ kind: "operator", profileId });
      expect(options.client?.internal?.operatorRunAuthority?.source).toBe(
        captured.authority.source,
      );
      const identity = expectDefined(
        options.client?.internal?.agentRuntimeIdentity,
        "trusted runtime producer",
      );
      expect(identity).toMatchObject({
        agentId: "main",
        sessionKey,
        operationalRunInstance: admitted.operationalRunInstance,
      });
      expect(context.validateAgentRuntimeApprovalAuthority?.(identity)).toBe(true);
      await expectDefined(handlers["question.request"], "question producer")(options);
    });
    const registry = createGatewayMethodRegistry(
      Object.entries(handlers).map(([name, handler]) => ({
        name,
        scope: "operator.questions" as const,
        owner: { kind: "core" as const, area: "questions" },
        handler:
          name === "question.request"
            ? request
            : async (options: GatewayRequestHandlerOptions) => {
                if (name === "question.waitAnswer") {
                  expect(options.client?.connect.scopes).toEqual(["operator.sessions.read"]);
                  expect(readGatewayRequestMutationAuthority(options).sessionScope).toBe(
                    "operator.sessions.read",
                  );
                  waiting.resolve();
                }
                await handler(options);
              },
      })),
    );
    context.getGatewayMethodRegistry = () => registry;
    const browserRequest = async (method: string, params: Record<string, unknown>) => {
      const respond = vi.fn<RespondFn>();
      await handleGatewayRequest({
        req: { type: "req", id: "browser-question", method, params },
        client: browser,
        context,
        respond,
        isWebchatConnect: () => false,
        methodRegistry: registry,
      });
      return expectDefined(respond.mock.calls[0], "browser question response");
    };
    try {
      await run({
        ask: () =>
          withGatewayToolCallerIdentity(caller, async () => {
            const tool = createAskUserTool({
              agentId: "main",
              sessionKey,
              runId: admitted.operationalRunInstance.runId,
            });
            return await tool.execute("hosted-question-call", toolArgs);
          }),
        waiting: waiting.promise,
        manager,
        request,
        answer: (id) =>
          browserRequest("question.resolve", {
            id,
            answers: { answers: { destination: ["Home"] } },
          }),
        read: (id) => browserRequest("question.get", { id }),
        revoke: () => source.abort(new Error("original question source revoked")),
        closeParent: () => {
          parent.close();
          captured.release();
        },
      });
    } finally {
      manager.close();
      parent.close();
      captured.release();
    }
  });
}

it("runs hosted ask_user through the real router with its original narrow operator grant", async () => {
  await withHostedQuestion(async (fixture) => {
    const result = fixture.ask();
    const settled = Promise.allSettled([result]);
    try {
      await Promise.race([
        fixture.waiting,
        result.then(() => {
          throw new Error("ask_user settled before its waiter");
        }),
      ]);
      expect(fixture.request).toHaveBeenCalledOnce();
      const record = expectDefined(fixture.manager.list()[0], "accepted question");
      expect(record).toMatchObject({
        agentId: "main",
        sessionKey,
        runId: "hosted-question-run",
        status: "pending",
      });
      expect(await fixture.answer(record.id)).toMatchObject([
        true,
        { status: "answered", answers: { answers: { destination: ["Home"] } } },
        undefined,
      ]);
      expect((await result).details).toMatchObject({
        status: "answered",
        answers: { answers: { destination: ["Home"] } },
      });
      fixture.closeParent();
      expect(await fixture.read(record.id)).toMatchObject([
        true,
        { question: { status: "answered" } },
        undefined,
      ]);
      fixture.revoke();
      expect(await fixture.read(record.id)).toMatchObject([
        false,
        undefined,
        { details: { reason: "QUESTION_NOT_FOUND" } },
      ]);
      expect(fixture.manager.get(record.id)?.status).toBe("answered");
    } finally {
      fixture.manager.close();
      await settled;
    }
  });
});

it("does not create a hosted question on another person's shared session", async () => {
  await withHostedQuestion(async (fixture) => {
    await expect(fixture.ask()).rejects.toThrow("session is shared for this connection");
    expect(fixture.request).toHaveBeenCalledOnce();
    expect(fixture.manager.list()).toEqual([]);
  }, true);
});

it("does not register another hosted question after the original operator source closes", async () => {
  await withHostedQuestion(async (fixture) => {
    fixture.revoke();
    await expect(fixture.ask()).rejects.toThrow("operator execution authority is no longer active");
    expect(fixture.request).not.toHaveBeenCalled();
    expect(fixture.manager.list()).toEqual([]);
  });
});
