import fs from "node:fs";
import path from "node:path";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { resolveAgentSessionDirsFromAgentsDirSync } from "../agents/session-dirs.js";
import { formatCliCommand } from "../cli/command-format.js";
import { quoteCliArg, quotePowerShellArg } from "../cli/quote-cli-arg.js";
import { resolveStateDir } from "../config/paths.js";
import { isSessionArchiveArtifactName } from "../config/sessions/artifacts.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  readRetainedAgentDeletions,
  type RetainedAgentDeletion,
} from "../state/agent-deletion-journal.read.js";
import { readRegisteredAgentDatabases } from "../state/openclaw-agent-db-registry-listing.js";
import {
  createOpenClawAgentDatabasePathMatcher,
  isPersistentOpenClawAgentDatabasePath,
  unregisterOpenClawAgentDatabase,
} from "../state/openclaw-agent-db-registry.js";
import { hasErrnoCode } from "./errno.js";
import { isPathInside } from "./path-guards.js";
import { SQLITE_SIDECAR_SUFFIXES } from "./sqlite-files.js";

export type AgentDatabaseMigrationTarget = {
  agentId: string;
  path: string;
  realPath: string;
  source: "configured" | "disk" | "registry" | "deletion";
};

type CandidateTarget = Omit<AgentDatabaseMigrationTarget, "realPath">;

export type PreparedAgentDatabaseMigrationDiscovery = {
  stateDir: string;
  configuredAgentDatabaseTargets: readonly { agentId: string; path: string }[];
  registeredAgentDatabases: readonly { agentId: string; path: string }[];
  discovery: ReturnType<typeof discoverAgentDatabaseMigrationTargets>;
};

function readAgentsDirectoryIdentity(env: NodeJS.ProcessEnv): string | null {
  try {
    const stat = fs.statSync(path.join(resolveStateDir(env), "agents"), { throwIfNoEntry: false });
    return stat ? `${stat.dev}:${stat.ino}:${stat.mtimeMs}` : "missing";
  } catch {
    return null;
  }
}

function sameTargets(
  left: readonly { agentId: string; path: string }[],
  right: readonly { agentId: string; path: string }[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (target, index) =>
        target.agentId === right[index]?.agentId && target.path === right[index]?.path,
    )
  );
}

function preparedDiscoveryIsCurrent(
  prepared: PreparedAgentDatabaseMigrationDiscovery,
  params: {
    configuredAgentDatabaseTargets: readonly { agentId: string; path: string }[];
    registeredAgentDatabases: readonly { agentId: string; path: string }[];
    retainedDeletions: readonly RetainedAgentDeletion[];
    env: NodeJS.ProcessEnv;
  },
): boolean {
  const directoryIdentity = readAgentsDirectoryIdentity(params.env);
  if (
    prepared.stateDir !== resolveStateDir(params.env) ||
    !sameTargets(prepared.configuredAgentDatabaseTargets, params.configuredAgentDatabaseTargets) ||
    !sameTargets(prepared.registeredAgentDatabases, params.registeredAgentDatabases) ||
    JSON.stringify(prepared.discovery.retainedDeletions) !==
      JSON.stringify(params.retainedDeletions) ||
    prepared.discovery.failures.length > 0 ||
    directoryIdentity === null ||
    directoryIdentity !== prepared.discovery.agentsDirectoryIdentity
  ) {
    return false;
  }
  try {
    for (const [pathname, identity] of prepared.discovery.sourceIdentities) {
      let realPath: string | undefined;
      try {
        realPath = fs.realpathSync.native(pathname);
      } catch (error) {
        if (!hasErrnoCode(error, "ENOENT")) {
          return false;
        }
      }
      if (
        realPath !== identity.realPath ||
        (identity.isFile !== undefined &&
          (fs.statSync(pathname, { throwIfNoEntry: false })?.isFile() ?? false) !== identity.isFile)
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function listDefaultAgentDatabaseTargets(
  env: NodeJS.ProcessEnv,
  failure: (pathname: string, reason: string) => void,
): CandidateTarget[] {
  const agentsDir = path.join(resolveStateDir(env), "agents");
  try {
    return resolveAgentSessionDirsFromAgentsDirSync(agentsDir).map((sessionsDir) => {
      const agentDir = path.dirname(sessionsDir);
      return {
        agentId: normalizeAgentId(path.basename(agentDir)),
        path: path.join(agentDir, "agent", "openclaw-agent.sqlite"),
        source: "disk" as const,
      };
    });
  } catch (error) {
    failure(agentsDir, `Could not enumerate agent databases under ${agentsDir}: ${String(error)}`);
    return [];
  }
}

/** Discover maintenance targets without mutating the registry or creating stores. */
export function discoverAgentDatabaseMigrationTargets(params: {
  configuredAgentDatabaseTargets: readonly { agentId: string; path: string }[];
  registeredAgentDatabases: readonly { agentId: string; path: string }[];
  retainedDeletions?: readonly RetainedAgentDeletion[];
  env: NodeJS.ProcessEnv;
}) {
  const warnings: string[] = [];
  const externalWarnings: string[] = [];
  const retainedDeletions =
    params.retainedDeletions ?? readRetainedAgentDeletions({ env: params.env });
  const retainedById = new Map(retainedDeletions.map((entry) => [entry.agentId, entry]));
  const retainedByFile = new Map<
    string,
    {
      target: AgentDatabaseMigrationTarget & { reason: "retained-by-deletion" };
      deletion: RetainedAgentDeletion;
    }
  >();
  const failures: Array<{ path: string; reason: string }> = [];
  const registryRemovals: Array<{ agentId: string; path: string; change?: string }> = [];
  const agentsDirectoryIdentity = readAgentsDirectoryIdentity(params.env);
  const sourceIdentities = new Map<string, { realPath?: string; isFile?: boolean }>();
  const failure = (pathname: string, reason: string) => {
    warnings.push(reason);
    failures.push({ path: pathname, reason });
  };
  const discard = (candidate: CandidateTarget, change?: string) => {
    if (candidate.source === "registry") {
      registryRemovals.push({ agentId: candidate.agentId, path: candidate.path, change });
    }
  };
  // Owner authority is explicit config, then the recorded registry fact, then
  // directory-name inference. Recorded identity must beat a stale directory basename.
  const candidates: CandidateTarget[] = [
    ...params.configuredAgentDatabaseTargets.map((target) => ({
      agentId: target.agentId,
      path: target.path,
      source: "configured" as const,
    })),
    ...params.registeredAgentDatabases.map((entry) => ({
      agentId: entry.agentId,
      path: entry.path,
      source: "registry" as const,
    })),
    ...retainedDeletions.flatMap((deletion) => {
      const files = new Set(deletion.databasePaths);
      return deletion.databasePaths
        .filter(
          (pathname) =>
            !SQLITE_SIDECAR_SUFFIXES.some(
              (suffix) => pathname.endsWith(suffix) && files.has(pathname.slice(0, -suffix.length)),
            ),
        )
        .map((pathname) => ({
          agentId: deletion.agentId,
          path: pathname,
          source: "deletion" as const,
        }));
    }),
    ...listDefaultAgentDatabaseTargets(params.env, failure),
  ];
  const activeStateDir = resolveStateDir(params.env);
  let activeStateDirRealPath: string | undefined;
  try {
    activeStateDirRealPath = fs.realpathSync.native(activeStateDir);
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      failure(
        activeStateDir,
        `Could not resolve active state directory ${activeStateDir}: ${String(error)}`,
      );
    }
  }
  const configuredPathMatcher = createOpenClawAgentDatabasePathMatcher();
  const targets: AgentDatabaseMigrationTarget[] = [];
  const seenPhysicalFiles = new Set<string>();
  for (const candidate of candidates) {
    const deletion = retainedById.get(normalizeAgentId(candidate.agentId));
    // Preserve the original locator: lexical normalization of `link/../file`
    // can select a different file than filesystem symlink traversal does.
    const pathname = candidate.path;
    if (!isPersistentOpenClawAgentDatabasePath(pathname, params.env)) {
      discard(
        candidate,
        `Removed archived or transient agent database registry entry ${pathname}.`,
      );
      continue;
    }
    let realPath: string | undefined;
    try {
      realPath = fs.realpathSync.native(pathname);
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        failure(pathname, `Could not resolve agent database ${pathname}: ${String(error)}`);
      }
    }
    sourceIdentities.set(pathname, { realPath });
    const isConfiguredPath =
      realPath !== undefined &&
      params.configuredAgentDatabaseTargets.some((configuredTarget) => {
        if (normalizeAgentId(configuredTarget.agentId) !== normalizeAgentId(candidate.agentId)) {
          return false;
        }
        try {
          return configuredPathMatcher(pathname, configuredTarget.path);
        } catch {
          return false;
        }
      });
    const isInsideActiveStateDir = Boolean(
      realPath &&
      activeStateDirRealPath &&
      (realPath === activeStateDirRealPath || isPathInside(activeStateDirRealPath, realPath)),
    );
    if (realPath && !isInsideActiveStateDir && !isConfiguredPath && !deletion) {
      discard(candidate);
      const warning = `Skipped foreign agent database ${sanitizeForLog(pathname)}; it is outside the active state directory and is not a configured session store.`;
      warnings.push(warning);
      externalWarnings.push(warning);
      continue;
    }
    let stat: fs.BigIntStats | undefined;
    try {
      stat = fs.statSync(pathname, { bigint: true });
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        failure(
          pathname,
          `Could not inspect ${candidate.source === "registry" ? "registered " : ""}agent database ${pathname}: ${String(error)}`,
        );
        continue;
      }
    }
    if (!stat?.isFile()) {
      sourceIdentities.set(pathname, { realPath, isFile: false });
      discard(candidate, `Removed missing agent database registry entry ${pathname}.`);
      if (candidate.source === "registry") {
        warnings.push(`Skipped missing registered agent database ${pathname}.`);
      }
      continue;
    }
    sourceIdentities.set(pathname, { realPath, isFile: true });
    if (!realPath) {
      discard(candidate);
      failure(
        pathname,
        `Skipped agent database ${pathname}; its filesystem boundary is unresolved.`,
      );
      continue;
    }
    const physicalFile = `${stat.dev}:${stat.ino}`;
    if (seenPhysicalFiles.has(physicalFile)) {
      continue;
    }
    if (deletion) {
      if (!retainedByFile.has(physicalFile)) {
        retainedByFile.set(physicalFile, {
          target: { ...candidate, realPath, reason: "retained-by-deletion" },
          deletion,
        });
      }
      continue;
    }
    // A surviving recorded owner beats a tombstone; a directory basename does not.
    if (candidate.source === "disk" && retainedByFile.has(physicalFile)) {
      continue;
    }
    seenPhysicalFiles.add(physicalFile);
    retainedByFile.delete(physicalFile);
    targets.push({ ...candidate, path: pathname, realPath });
  }
  const retainedTargets = [...retainedByFile.values()].map(({ target }) => target);
  const notices = [...retainedByFile.values()].map(({ target, deletion }) => {
    const quote = process.platform === "win32" ? quotePowerShellArg : quoteCliArg;
    const restore = formatCliCommand(
      `openclaw agents add ${quote(deletion.agentId)} --workspace ${quote(deletion.workspaceDir)} --agent-dir ${quote(deletion.agentDir)} --non-interactive`,
      params.env,
    );
    return `Preserved agent database retained-by-deletion: ${sanitizeForLog(target.path)}. To restore this agent, run ${sanitizeForLog(restore)}, then ${formatCliCommand("openclaw doctor --fix", params.env)} with the same state/config.`;
  });
  return {
    targets,
    retainedTargets,
    retainedDeletions,
    notices,
    registryRemovals,
    warnings,
    externalWarnings,
    failures,
    agentsDirectoryIdentity,
    sourceIdentities,
  };
}

/** Migration alone owns cleanup of stale registry entries discovered above. */
export function resolveAgentDatabaseMigrationTargets(params: {
  changes: string[];
  configuredAgentDatabaseTargets: readonly { agentId: string; path: string }[];
  env: NodeJS.ProcessEnv;
  warnings: string[];
  notices?: string[];
  preparedDiscovery?: PreparedAgentDatabaseMigrationDiscovery;
}): { targets: AgentDatabaseMigrationTarget[]; recoverableWarningCount: number } {
  let registeredAgentDatabases: readonly { agentId: string; path: string }[] = [];
  let registryReadFailed = false;
  try {
    registeredAgentDatabases = readRegisteredAgentDatabases(
      {
        env: params.env,
        includeIncompatibleSchemaVersions: true,
      },
      false,
    );
  } catch (error) {
    registryReadFailed = true;
    params.warnings.push(
      `Failed enumerating registered agent databases for state migration: ${String(error)}`,
    );
  }
  // Schema repair can rewrite registrations. Validate the prepared source once at mutation
  // admission, including missing candidates, before applying its registry removals.
  const retainedDeletions = readRetainedAgentDeletions({ env: params.env });
  const discovery =
    !registryReadFailed &&
    params.preparedDiscovery &&
    preparedDiscoveryIsCurrent(params.preparedDiscovery, {
      ...params,
      registeredAgentDatabases,
      retainedDeletions,
    })
      ? params.preparedDiscovery.discovery
      : discoverAgentDatabaseMigrationTargets({
          ...params,
          registeredAgentDatabases,
          retainedDeletions,
        });
  for (const removed of discovery.registryRemovals) {
    unregisterOpenClawAgentDatabase({ ...removed, env: params.env });
    if (removed.change) {
      params.changes.push(removed.change);
    }
  }
  params.warnings.push(...discovery.warnings);
  params.notices?.push(...discovery.notices);
  // Deliberate registry omissions are reported without blocking authorized stores.
  // Failed discovery never grants that disposition, even if it also omitted a foreign entry.
  return {
    targets: discovery.targets,
    recoverableWarningCount:
      registryReadFailed || discovery.failures.length > 0 ? 0 : discovery.warnings.length,
  };
}

export function listTranscriptArchives(directory: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.includes(".jsonl.") &&
        isSessionArchiveArtifactName(entry.name),
    )
    .map((entry) => path.join(directory, entry.name));
}
