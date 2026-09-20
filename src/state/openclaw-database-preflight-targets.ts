import { resolveStateDir } from "../config/paths.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  discoverAgentDatabaseMigrationTargets,
  type PreparedAgentDatabaseMigrationDiscovery,
} from "../infra/state-migrations.media-persistence-targets.js";
import type { RetainedAgentDeletion } from "./agent-deletion-journal.read.js";
import {
  createOpenClawAgentDatabasePathMatcher,
  isPersistentOpenClawAgentDatabasePath,
} from "./openclaw-agent-db-registry.js";

type AgentTarget = { agentId: string; path: string };

/** Select read-only inspection targets from the captured shared-state ownership facts. */
export function collectAgentDatabasePreflightTargets(options: {
  env: NodeJS.ProcessEnv;
  registeredDatabases: readonly AgentTarget[];
  retainedDeletions: readonly RetainedAgentDeletion[];
  configuredAgentDatabaseTargets?:
    | readonly AgentTarget[]
    | ((registered: readonly AgentTarget[]) => readonly AgentTarget[]);
  configuredAgentDatabaseCandidatePaths?: readonly string[];
  inspectCandidateOwners: boolean;
  onAgentDatabaseDiscovery?: (prepared: PreparedAgentDatabaseMigrationDiscovery) => void;
}) {
  const { registeredDatabases, retainedDeletions } = options;
  let agentTargets = registeredDatabases;
  const retainedAgentIds = new Set(retainedDeletions.map((deletion) => deletion.agentId));
  const retainedPaths = new Set<string>();
  const failures: Array<{ path: string; reason: string }> = [];
  if (options.configuredAgentDatabaseTargets !== undefined) {
    // Doctor must resolve configured paths from these read-only facts: the
    // runtime registry reader rejects the very legacy schema Doctor repairs.
    const configuredTargets =
      typeof options.configuredAgentDatabaseTargets === "function"
        ? options.configuredAgentDatabaseTargets(registeredDatabases)
        : options.configuredAgentDatabaseTargets;
    const discovery = discoverAgentDatabaseMigrationTargets({
      env: options.env,
      configuredAgentDatabaseTargets: configuredTargets,
      registeredAgentDatabases: registeredDatabases,
      retainedDeletions,
    });
    options.onAgentDatabaseDiscovery?.({
      stateDir: resolveStateDir(options.env),
      configuredAgentDatabaseTargets: configuredTargets,
      registeredAgentDatabases: registeredDatabases,
      discovery,
    });
    agentTargets = discovery.targets;
    for (const retained of discovery.retainedTargets) {
      retainedPaths.add(retained.realPath);
    }
    failures.push(...discovery.failures);
  }
  // An occupied custom-store candidate can have a newer, unreadable owner.
  // Check its version without promoting it into an owned migration target.
  const candidates: Array<{ agentId?: string; path: string }> = [
    ...agentTargets,
    // Migration discovery intentionally declines ownership of foreign registry
    // paths. Preflight remains read-only, so preserve their downgrade guard.
    ...(options.configuredAgentDatabaseTargets !== undefined
      ? registeredDatabases.filter((database) =>
          isPersistentOpenClawAgentDatabasePath(database.path, options.env),
        )
      : []),
    ...(options.configuredAgentDatabaseCandidatePaths ?? []).map((candidatePath) => ({
      agentId: options.inspectCandidateOwners
        ? resolveUnsuffixedSqliteTargetFromSessionStorePath(candidatePath).agentId
        : undefined,
      path: candidatePath,
    })),
  ];
  const samePath = createOpenClawAgentDatabasePathMatcher();
  const retained = [...retainedPaths];
  return {
    candidates: candidates.filter(
      (row) => row.agentId === undefined || !retainedAgentIds.has(row.agentId),
    ),
    isRetainedPath: (pathname: string) =>
      retained.some((candidate) => samePath(candidate, pathname)),
    failures,
  };
}
