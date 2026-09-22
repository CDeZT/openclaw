// Question gateway methods create, inspect, wait for, and resolve transient prompts.
import {
  ErrorCodes,
  errorShape,
  type Question,
  type QuestionRecord,
  type QuestionRequestParams,
  validateQuestionGetParams,
  validateQuestionListParams,
  validateQuestionRequestParams,
  validateQuestionResolveParams,
  validateQuestionWaitAnswerParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { registerActiveEmbeddedRunHumanInputWait } from "../../agents/embedded-agent-runner/run-state.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  handleQuestionChannelRequested,
  handleQuestionChannelResolved,
} from "../../infra/question-channel-runtime.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import {
  listSecretStoreEntries,
  SecretStoreValidationError,
} from "../../secrets/store/secret-store.js";
import {
  authorizeGatewaySessionCreation,
  hasOperatorBoundary,
  resolveGatewayOperatorRoleActor,
} from "../operator-role-policy.js";
import {
  QuestionManager,
  QuestionManagerError,
  QuestionManagerErrorCodes,
  type QuestionObservation,
} from "../question-manager.js";
import {
  captureQuestionSessionAccess,
  canAccessSessionQuestion,
  type QuestionSessionAccess,
} from "../question-session-access.js";
import { questionShapeError } from "../question-validation.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import {
  authorizeSessionSharing,
  authorizeSessionSharingTarget,
  createSessionListEntryFilter,
  isGatewayAdmin,
  resolveSessionSharingTarget,
} from "../session-sharing.js";
import { resolveStoredSessionKeyForAgentStore } from "../session-store-key.js";
import type { SecretStoreWriteService } from "./secrets.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type {
  GatewayClient,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
  RespondFn,
} from "./types.js";
import { assertValidParams } from "./validation.js";

const DEFAULT_QUESTION_TIMEOUT_MS = 15 * 60 * 1_000;

class QuestionRequestValidationError extends Error {}

function managerError(error: unknown, respond: RespondFn): boolean {
  if (!(error instanceof QuestionManagerError)) {
    return false;
  }
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, error.message, { details: { reason: error.code } }),
  );
  return true;
}

function questionNotFound(id: string) {
  return errorShape(ErrorCodes.INVALID_REQUEST, `question '${id}' was not found`, {
    details: { reason: QuestionManagerErrorCodes.NOT_FOUND },
  });
}

function authorizeQuestionRecord(params: {
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  question: QuestionRecord;
  access: "read" | "mutate";
}): ReturnType<typeof errorShape> | null {
  if (
    isGatewayAdmin(params.client) ||
    !hasOperatorBoundary(params.client, params.cfg) ||
    !params.question.sessionKey
  ) {
    return null;
  }
  const target = resolveSessionSharingTarget({
    cfg: params.cfg,
    sessionKey: params.question.sessionKey,
    agentId: params.question.agentId,
  });
  const canSeeSession =
    target &&
    (createSessionListEntryFilter({ cfg: params.cfg, client: params.client })?.(
      target.canonicalKey,
      target.entry,
    ) ??
      true);
  if (!target || !canSeeSession) {
    return questionNotFound(params.question.id);
  }
  return params.access === "mutate"
    ? authorizeSessionSharingTarget({ cfg: params.cfg, client: params.client, target })
    : null;
}

function prepareQuestionAuthorization(
  options: GatewayRequestHandlerOptions,
  observation: QuestionObservation | null,
  id: string,
  access: "read" | "mutate",
) {
  const authority = readGatewayRequestMutationAuthority(options);
  const actor = resolveGatewayOperatorRoleActor(options.client);
  return () => {
    if (!observation?.isCurrent()) {
      return questionNotFound(id);
    }
    if (authority.sessionScope) {
      authority.assertCurrent();
      const current = resolveGatewayOperatorRoleActor(options.client);
      if (
        actor?.kind !== "operator" ||
        current?.kind !== "operator" ||
        current.profileId !== actor.profileId ||
        !canAccessSessionQuestion(observation, options.client, access)
      ) {
        return questionNotFound(id);
      }
      return null;
    }
    return authorizeQuestionRecord({
      cfg: options.context.getRuntimeConfig(),
      client: options.client,
      question: observation.record,
      access,
    });
  };
}

function questionBroadcastOptions(observation: QuestionObservation | null) {
  return observation?.ordinary && observation.sessionAccess
    ? {
        canReadQuestion: (client: GatewayClient) =>
          canAccessSessionQuestion(observation, client, "read"),
      }
    : undefined;
}

function normalizeQuestions(params: QuestionRequestParams): Question[] {
  const error = questionShapeError(params.questions, {
    allowPlainSecretQuestions: false,
    validateUrls: true,
  });
  if (error) {
    throw new QuestionRequestValidationError(error);
  }
  return params.questions.map((question) => {
    const binding = question.secretStore;
    if (binding) {
      const existing = listSecretStoreEntries({ scope: { kind: "team" } }).find(
        (entry) => entry.name === binding.name,
      );
      return {
        ...question,
        // Save the policy shown for consent, never inherit unseen hosts at submission.
        secretStore: {
          ...binding,
          allowedHosts: binding.allowedHosts ?? existing?.allowedHosts ?? [],
        },
        ...(existing
          ? {
              secretStoreExisting: {
                updatedAtMs: existing.updatedAtMs,
                ...(existing.updatedBy ? { updatedBy: existing.updatedBy } : {}),
              },
            }
          : {}),
      };
    }
    return question;
  });
}

/** Creates the lazily loaded question RPC surface for one Gateway lifetime. */
export function createQuestionHandlers(
  manager: QuestionManager,
  storeWriteService: SecretStoreWriteService,
): GatewayRequestHandlers {
  return {
    "question.request": (options) => {
      const { params, respond, context, client } = options;
      if (!assertValidParams(params, validateQuestionRequestParams, "question.request", respond)) {
        return;
      }
      let request = params as QuestionRequestParams;
      const storeBound = request.questions.some((question) => question.secretStore);
      const authority = readGatewayRequestMutationAuthority(options);
      const narrow = authority.sessionScope === "operator.sessions.write";
      let sessionAccess: QuestionSessionAccess | undefined;
      let accepted = false;
      // Store-bound questions end in a secret-store write on resolve. Without
      // this gate any operator.questions client could mint and self-answer one,
      // bypassing the operator.admin requirement on secrets.store.set.
      if (storeBound && !isGatewayAdmin(client)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "secret store questions require an operator.admin client",
          ),
        );
        return;
      }
      const identity = client?.internal?.agentRuntimeIdentity;
      const validateAuthority = context.validateAgentRuntimeApprovalAuthority;
      if ((storeBound || narrow) && (!identity || !validateAuthority)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            storeBound
              ? "secret store questions require trusted agent runtime authority"
              : "question creation requires trusted agent runtime authority",
          ),
        );
        return;
      }
      // Capture the admitted identity privately, not the caller's correlation fields.
      // Revalidate this exact claim even if another execution reuses its runId.
      const requester = identity ? structuredClone(identity) : undefined;
      const isRequesterActive =
        requester && validateAuthority
          ? () => {
              try {
                return validateAuthority(requester);
              } catch {
                return false;
              }
            }
          : undefined;
      if (
        narrow &&
        (storeBound ||
          request.questions.some((question) => question.isSecret) ||
          isRequesterActive?.() !== true)
      ) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "Session-scoped questions require an ordinary question and a live agent requester.",
          ),
        );
        return;
      }
      if (requester) {
        request = {
          ...request,
          agentId: requester.agentId,
          sessionKey: requester.sessionKey,
          runId: requester.operationalRunInstance.runId,
        };
      }
      try {
        const requestedSession = request.sessionKey
          ? resolveRequestedSessionAgentId(
              context.getRuntimeConfig(),
              request.sessionKey,
              request.agentId,
            )
          : undefined;
        if (requestedSession && !requestedSession.ok) {
          respond(false, undefined, requestedSession.error);
          return;
        }
        if (narrow && requestedSession?.ok) {
          // Starting a prompt uses the producer's agent ceiling; shared readers keep VIEW access.
          const agentError = authorizeGatewaySessionCreation({
            cfg: context.getRuntimeConfig(),
            client,
            agentId: requestedSession.agentId,
          });
          if (agentError) {
            respond(false, undefined, agentError);
            return;
          }
        }
        const sessionKey =
          request.sessionKey && requestedSession?.ok
            ? resolveStoredSessionKeyForAgentStore({
                cfg: context.getRuntimeConfig(),
                agentId: requestedSession.agentId,
                sessionKey: request.sessionKey,
              })
            : undefined;
        if (sessionKey && hasOperatorBoundary(client, context.getRuntimeConfig())) {
          const authorizationError = authorizeSessionSharing({
            cfg: context.getRuntimeConfig(),
            client,
            sessionKey,
            agentId: requestedSession?.ok ? requestedSession.agentId : undefined,
          });
          if (authorizationError) {
            respond(false, undefined, authorizationError);
            return;
          }
        }
        if (
          sessionKey &&
          requestedSession?.ok &&
          !request.questions.some((question) => question.isSecret || question.secretStore)
        ) {
          try {
            sessionAccess = captureQuestionSessionAccess(
              options,
              sessionKey,
              requestedSession.agentId,
            );
          } catch (error) {
            // A broad question keeps its existing workflow; unavailable retained facts grant no new narrow access.
            if (narrow) {
              throw error;
            }
          }
        }
        if (narrow) {
          authority.assertCurrent();
          if (!sessionAccess?.canAccess(client, "mutate")) {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.FORBIDDEN,
                "Session-scoped questions require your own materialized ordinary session.",
              ),
            );
            return;
          }
        }
        const broadcastQuestion = (
          event: string,
          payload: unknown,
          observation: QuestionObservation | null,
        ) => {
          const scoped =
            sessionKey && context.getRuntimeConfig().gateway?.roles
              ? {
                  sessionKeys: [sessionKey],
                  ...(requestedSession?.ok ? { agentId: requestedSession.agentId } : {}),
                }
              : undefined;
          const retained = questionBroadcastOptions(observation);
          if (scoped || retained) {
            context.broadcast(event, payload, { ...scoped, ...retained });
          } else {
            context.broadcast(event, payload);
          }
        };
        const record = manager.request({
          ...(request.id ? { id: request.id } : {}),
          questions: normalizeQuestions(request),
          ...(requestedSession?.ok
            ? { agentId: requestedSession.agentId }
            : request.agentId
              ? { agentId: request.agentId }
              : {}),
          ...(sessionKey ? { sessionKey } : {}),
          ...(request.runId ? { runId: request.runId } : {}),
          timeoutMs: request.timeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS,
          isRequesterActive,
          sessionAccess,
          registerHumanInputWait:
            requester && isRequesterActive
              ? (isPending) =>
                  registerActiveEmbeddedRunHumanInputWait(requester.delegatedAuthority, isPending)
              : undefined,
          onResolved: (event, observation) => {
            handleQuestionChannelResolved(event);
            broadcastQuestion("question.resolved", event, observation);
          },
        });
        accepted = true;
        handleQuestionChannelRequested(record);
        broadcastQuestion("question.requested", record, manager.observe(record.id, record));
        respond(true, { id: record.id, expiresAtMs: record.expiresAtMs }, undefined);
      } catch (error) {
        if (error instanceof QuestionRequestValidationError) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
          return;
        }
        if (!managerError(error, respond)) {
          if (storeBound) {
            respond(
              false,
              undefined,
              errorShape(ErrorCodes.UNAVAILABLE, "Secret store entry metadata is unavailable."),
            );
            return;
          }
          throw error;
        }
      } finally {
        if (!accepted) {
          sessionAccess?.release();
        }
      }
    },
    "question.waitAnswer": async (options) => {
      const { params, respond } = options;
      if (
        !assertValidParams(params, validateQuestionWaitAnswerParams, "question.waitAnswer", respond)
      ) {
        return;
      }
      const request = params;
      try {
        const question = manager.get(request.id);
        const authorize = prepareQuestionAuthorization(
          options,
          question ? manager.observe(request.id, question) : null,
          request.id,
          "read",
        );
        const authorizationError = authorize();
        if (authorizationError) {
          respond(false, undefined, authorizationError);
          return;
        }
        const answer = await manager.waitAnswer(
          request.id,
          request.timeoutMs,
          request.includeResolutionId,
        );
        // Reauthorize the original question's immutable routing, not a getter
        // that could expire/cancel it merely because this observer stopped.
        const responseError = authorize();
        if (responseError) {
          respond(false, undefined, responseError);
          return;
        }
        respond(true, answer, undefined);
      } catch (error) {
        if (!managerError(error, respond)) {
          throw error;
        }
      }
    },
    "question.resolve": async (options) => {
      const { params, respond, client } = options;
      if (!assertValidParams(params, validateQuestionResolveParams, "question.resolve", respond)) {
        return;
      }
      const request = params;
      try {
        const question = manager.get(request.id);
        const authorize = prepareQuestionAuthorization(
          options,
          question ? manager.observe(request.id, question) : null,
          request.id,
          "mutate",
        );
        const authorizationError = authorize();
        if (authorizationError) {
          respond(false, undefined, authorizationError);
          return;
        }
        if ("cancel" in request) {
          respond(true, manager.cancel(request.id, request.resolvedBy), undefined);
          return;
        }
        const secretQuestion = question?.questions[0];
        const binding = secretQuestion?.secretStore;
        if (!binding || !question) {
          if (request.secretStoreAllowedHosts !== undefined) {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.INVALID_REQUEST,
                "Secret store allowed hosts require a store-bound question.",
              ),
            );
            return;
          }
          respond(
            true,
            manager.resolve(request.id, request.answers, request.resolvedBy, {
              resolutionId: request.resolutionId,
            }),
            undefined,
          );
          return;
        }
        const submittedAnswers = request.answers.answers;
        const values = Object.hasOwn(submittedAnswers, secretQuestion.questionId)
          ? submittedAnswers[secretQuestion.questionId]
          : undefined;
        const value = values?.[0];
        if (
          Object.keys(submittedAnswers).length !== 1 ||
          values?.length !== 1 ||
          value === undefined
        ) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `question '${secretQuestion.questionId}' requires exactly one secret value`,
            ),
          );
          return;
        }
        registerSecretValueForRedaction(value);
        const allowedHosts = request.secretStoreAllowedHosts ?? binding.allowedHosts;
        let saved = false;
        try {
          // Only the synthetic marker enters state, fanout, and waiting agents.
          // The manager validates liveness and settles before refresh can yield.
          const result = manager.resolve(
            request.id,
            { answers: { [secretQuestion.questionId]: ["stored"] } },
            request.resolvedBy,
            {
              resolutionId: request.resolutionId,
              commit: () => {
                storeWriteService.write({
                  name: binding.name,
                  value,
                  kind: "secret",
                  ...(allowedHosts !== undefined ? { allowedHosts } : {}),
                  updatedBy: storeWriteService.resolveUpdatedBy(client),
                });
                saved = true;
              },
            },
          );
          await storeWriteService.reloadReference(binding.name);
          respond(true, result, undefined);
        } catch (error) {
          if (managerError(error, respond)) {
            return;
          }
          respond(
            false,
            undefined,
            errorShape(
              !saved && error instanceof SecretStoreValidationError
                ? ErrorCodes.INVALID_REQUEST
                : ErrorCodes.UNAVAILABLE,
              saved
                ? "Secret store entry was saved, but runtime refresh failed. Resolve provider errors and retry secrets.reload; do not resubmit this answer."
                : error instanceof SecretStoreValidationError
                  ? error.message
                  : "Secret store entry could not be saved.",
            ),
          );
        }
      } catch (error) {
        if (!managerError(error, respond)) {
          throw error;
        }
      }
    },
    "question.get": (options) => {
      const { params, respond } = options;
      if (!assertValidParams(params, validateQuestionGetParams, "question.get", respond)) {
        return;
      }
      const id = (params as { id: string }).id;
      const question = manager.get(id);
      if (!question) {
        respond(false, undefined, questionNotFound(id));
        return;
      }
      const authorizationError = prepareQuestionAuthorization(
        options,
        manager.observe(id, question),
        id,
        "read",
      )();
      if (authorizationError) {
        respond(false, undefined, authorizationError);
        return;
      }
      respond(true, { question }, undefined);
    },
    "question.list": (options) => {
      const { params, respond } = options;
      if (!assertValidParams(params, validateQuestionListParams, "question.list", respond)) {
        return;
      }
      const questions = manager
        .list()
        .filter(
          (question) =>
            !prepareQuestionAuthorization(
              options,
              manager.observe(question.id, question),
              question.id,
              "read",
            )(),
        );
      respond(true, { questions }, undefined);
    },
  };
}
