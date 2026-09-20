import { discoverAgentDatabaseMigrationTargets } from "../infra/state-migrations.media-persistence-targets.js";
import { readRetainedAgentDeletions } from "./agent-deletion-journal.read.js";
import { readRegisteredAgentDatabases } from "./openclaw-agent-db-registry-listing.js";
import { createOpenClawAgentDatabasePathMatcher } from "./openclaw-agent-db-registry.js";

/** Reuse the discovery owner's physical-store disposition for a prepared inventory. */
export function createRetainedAgentDatabaseMatcher(
  env: NodeJS.ProcessEnv,
  readConfiguredTargets: () => readonly { agentId: string; path: string }[],
) {
  const retainedDeletions = readRetainedAgentDeletions({ env });
  if (retainedDeletions.length === 0) {
    return (_pathname: string) => false;
  }
  const { retainedTargets } = discoverAgentDatabaseMigrationTargets({
    env,
    retainedDeletions,
    configuredAgentDatabaseTargets: readConfiguredTargets(),
    registeredAgentDatabases: readRegisteredAgentDatabases(
      { env, includeIncompatibleSchemaVersions: true },
      false,
    ),
  });
  const samePath = createOpenClawAgentDatabasePathMatcher();
  return (pathname: string): boolean =>
    retainedTargets.some((target) => samePath(target.realPath, pathname));
}
