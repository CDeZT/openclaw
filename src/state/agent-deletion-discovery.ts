import fs from "node:fs";
import { resolveStateDir } from "../config/paths.js";
import { isPathInside } from "../infra/path-guards.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  readAgentDatabaseDeletionSnapshot,
  type AgentDeletionJournalDisposition,
} from "./agent-deletion-journal.read.js";
import {
  createOpenClawAgentDatabasePathMatcher,
  isPersistentOpenClawAgentDatabasePath,
} from "./openclaw-agent-db-registry.js";

type Target = { agentId: string; path: string };

/** Recorded surviving owners can share retained files; directory-name inference cannot. */
export function createAgentDatabaseDeletionClassifier(params: {
  env: NodeJS.ProcessEnv;
  retainedDeletions: AgentDeletionJournalDisposition;
  configuredAgentDatabaseTargets: readonly Target[];
  registeredAgentDatabases: readonly Target[];
  artifactDirectories?: readonly Target[];
}) {
  const entries = params.retainedDeletions;
  const samePath = createOpenClawAgentDatabasePathMatcher();
  const recorded = params.artifactDirectories ?? [
    ...params.configuredAgentDatabaseTargets,
    ...params.registeredAgentDatabases,
  ];
  return (pathname: string, agentId?: string) => {
    if (entries === "unavailable") {
      return entries;
    }
    const deletion = entries.find(
      (entry) =>
        entry.agentId === agentId ||
        (params.artifactDirectories ? [entry.agentDir] : entry.databasePaths).some((file) =>
          samePath(file, pathname),
        ),
    );
    if (!deletion) {
      return undefined;
    }
    const surviving = recorded.some(
      (target) =>
        !entries.some((entry) => entry.agentId === normalizeAgentId(target.agentId)) &&
        samePath(target.path, pathname) &&
        (params.artifactDirectories !== undefined ||
          (isPersistentOpenClawAgentDatabasePath(target.path, params.env) &&
            (params.configuredAgentDatabaseTargets.includes(target) ||
              isPathInside(
                fs.realpathSync.native(resolveStateDir(params.env)),
                fs.realpathSync.native(target.path),
              )))),
    );
    return agentId === deletion.agentId || !surviving ? deletion : undefined;
  };
}

export function createRetainedAgentDatabaseMatcher(
  env: NodeJS.ProcessEnv,
  readConfiguredTargets: () => readonly Target[],
  namespace: "database" | "agent-directory" = "database",
) {
  const snapshot = readAgentDatabaseDeletionSnapshot(env);
  const retainedDeletions = snapshot?.retainedDeletions ?? "unavailable";
  if (retainedDeletions === "unavailable" || retainedDeletions.length === 0) {
    return (_pathname: string, _agentId?: string) => retainedDeletions === "unavailable";
  }
  const configured = readConfiguredTargets();
  return createAgentDatabaseDeletionClassifier({
    env,
    retainedDeletions,
    configuredAgentDatabaseTargets: configured,
    artifactDirectories: namespace === "agent-directory" ? configured : undefined,
    registeredAgentDatabases: snapshot?.registeredAgentDatabases ?? [],
  });
}
