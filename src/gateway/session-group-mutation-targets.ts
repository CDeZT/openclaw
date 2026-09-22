import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAllAgentSessionStoreTargetsSync } from "../config/sessions.js";
import { listSessionEntriesReadOnly } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SessionMutationTarget } from "./session-mutation-authorization-error.js";

export function resolveSessionGroupMutationTargetsByName(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): Map<string, SessionMutationTarget[]> {
  const targetsByName = new Map<string, SessionMutationTarget[]>();
  for (const storeTarget of resolveAllAgentSessionStoreTargetsSync(cfg, { env })) {
    for (const { sessionKey, entry } of listSessionEntriesReadOnly({
      agentId: storeTarget.agentId,
      storePath: storeTarget.storePath,
      // Membership only borrows category metadata; full reads decode every saved prompt.
      projection: "list",
      clone: false,
    })) {
      const groupName = normalizeOptionalString(entry.category);
      if (!groupName) {
        continue;
      }
      const targets = targetsByName.get(groupName) ?? [];
      targets.push({ sessionKey, agentId: storeTarget.agentId });
      targetsByName.set(groupName, targets);
    }
  }
  return targetsByName;
}
