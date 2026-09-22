import { isIncognitoSessionKey } from "../routing/session-key.js";
import { operatorScopeSatisfied } from "../shared/operator-scope-compat.js";
import { resolveGatewayOperatorRoleActor } from "./operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import type { QuestionObservation } from "./question-manager.js";
import type { GatewayClient, GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { isSessionCreatorProfile } from "./session-creator.js";
import { createSessionListEntryFilter, resolveSessionSharingTarget } from "./session-sharing.js";
import { retainGatewaySessionEntryReadOnly } from "./session-utils-read-lifetime.js";

/** Producer-owned facts remain private and retained until the question entry is retired. */
export type QuestionSessionAccess = {
  readonly agentId: string;
  readonly sessionKey: string;
  canAccess: (client: GatewayClient | null, access: "read" | "mutate") => boolean;
  release: () => void;
};

export function captureQuestionSessionAccess(
  options: GatewayRequestHandlerOptions,
  sessionKey: string,
  agentId: string,
): QuestionSessionAccess | undefined {
  const read = retainGatewaySessionEntryReadOnly(sessionKey, agentId);
  const selected = read.entry;
  if (
    !selected?.sessionId ||
    !selected.lifecycleRevision ||
    selected.incognito ||
    isIncognitoSessionKey(read.canonicalKey)
  ) {
    read.release();
    return undefined;
  }
  let source: ReturnType<typeof captureGatewayOperatorRunAuthority>;
  let released = false;
  try {
    source = captureGatewayOperatorRunAuthority(options);
  } catch (error) {
    read.release();
    throw error;
  }
  const producer = resolveGatewayOperatorRoleActor(options.client);
  return {
    agentId: read.agentId,
    sessionKey: read.canonicalKey,
    canAccess: (client, access) => {
      try {
        if (released || !read.isGenerationCurrentAtResponse()) {
          return false;
        }
        source?.authority.assertCurrent();
        const currentProducer = resolveGatewayOperatorRoleActor(options.client);
        if (
          producer?.kind === "operator" &&
          (currentProducer?.kind !== "operator" || currentProducer.profileId !== producer.profileId)
        ) {
          return false;
        }
        const actor = resolveGatewayOperatorRoleActor(client);
        if (actor?.kind !== "operator" || !actor.profileId.trim() || client?.invalidated) {
          return false;
        }
        const scope = access === "read" ? "operator.sessions.read" : "operator.sessions.write";
        if (!operatorScopeSatisfied(scope, client?.connect.scopes ?? [])) {
          return false;
        }
        client?.internal?.operatorAccessAuthority?.assertCurrent();
        client?.internal?.operatorRunAuthority?.assertCurrent();
        const cfg = options.context.getRuntimeConfig();
        const target = resolveSessionSharingTarget({
          cfg,
          agentId: read.agentId,
          sessionKey: read.canonicalKey,
        });
        if (
          !target ||
          target.agentId !== read.agentId ||
          target.canonicalKey !== read.canonicalKey ||
          target.storePath !== read.storePath ||
          target.entry.sessionId !== selected.sessionId ||
          target.entry.lifecycleRevision !== selected.lifecycleRevision ||
          target.entry.incognito ||
          isIncognitoSessionKey(target.canonicalKey)
        ) {
          return false;
        }
        return access === "mutate"
          ? isSessionCreatorProfile(target.entry.createdActor, actor.profileId)
          : (createSessionListEntryFilter({ cfg, client })?.(target.canonicalKey, target.entry) ??
              true);
      } catch {
        return false;
      }
    },
    release: () => {
      if (!released) {
        released = true;
        source?.release();
        read.release();
      }
    },
  };
}

/** Shared by RPC readers and event fanout; never advances the manager's lifecycle. */
export function canAccessSessionQuestion(
  observation: QuestionObservation | null,
  client: GatewayClient | null,
  access: "read" | "mutate",
): boolean {
  return Boolean(
    observation?.isCurrent() &&
    observation.ordinary &&
    observation.sessionAccess?.canAccess(client, access),
  );
}
