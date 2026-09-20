import { loadCombinedSessionStoreForGatewayCore } from "../config/sessions/combined-store-gateway.js";
import { resolveConfiguredAgentDatabaseTargets } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createRetainedAgentDatabaseMatcher } from "../state/agent-deletion-discovery.js";

type ProjectionStoreCallbacks = Required<
  Pick<
    NonNullable<Parameters<typeof loadCombinedSessionStoreForGatewayCore>[1]>,
    "loadEntries" | "onStoreLoaded"
  >
>;

/** Classify physical stores at topology invalidation, before resident identity readers run. */
export function loadSessionRowProjectionTopology(
  cfg: OpenClawConfig,
  callbacks: ProjectionStoreCallbacks,
) {
  const isRetained = createRetainedAgentDatabaseMatcher(process.env, () =>
    resolveConfiguredAgentDatabaseTargets(cfg, { env: process.env }),
  );
  return loadCombinedSessionStoreForGatewayCore(cfg, {
    includeIncognito: false,
    preserveSentinelOwners: "physical",
    loadEntries: (target, projection) =>
      isRetained(target.storePath) ? [] : callbacks.loadEntries(target, projection),
    onStoreLoaded: callbacks.onStoreLoaded,
  });
}
