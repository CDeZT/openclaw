import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import {
  resolveAgentSessionStoreTargetsSync,
  resolveAllAgentSessionStoreCandidateTargetsSync,
  resolveSessionStoreTargets,
  type SessionStoreTarget as ResolvedSessionStoreTarget,
} from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  excludeRetainedAgentDatabaseTargets,
  listDoctorSessionStoreTargets,
  resolveTargetSqlitePath,
} from "./doctor-session-sqlite-readers.js";
import type { DoctorSessionSqliteMode } from "./doctor-session-sqlite-types.js";

type SessionStoreTarget = ResolvedSessionStoreTarget & { sqlitePath?: string };

export function resolveDoctorSessionSqliteTargets(params: {
  allAgents?: boolean;
  agent?: string;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  mode: DoctorSessionSqliteMode;
  store?: string;
}): SessionStoreTarget[] {
  if (params.store) {
    return resolveSessionStoreTargets(params.cfg, { store: params.store }, { env: params.env });
  }
  const discoversHistory =
    params.mode === "dry-run" || params.mode === "import" || params.mode === "validate";
  if (
    params.mode === "restore" ||
    params.mode === "recover" ||
    (discoversHistory && params.agent)
  ) {
    const candidates = resolveAllAgentSessionStoreCandidateTargetsSync(params.cfg, {
      env: params.env,
    });
    if (!params.agent) {
      return candidates;
    }
    const requestedAgentId = normalizeAgentId(params.agent);
    return candidates.filter((target) => normalizeAgentId(target.agentId) === requestedAgentId);
  }
  if (params.agent) {
    return resolveAgentSessionStoreTargetsSync(params.cfg, params.agent, { env: params.env });
  }
  if (params.allAgents) {
    // Discovery must admit validated directories even before either registry exists.
    const targets = discoversHistory
      ? excludeRetainedAgentDatabaseTargets(
          resolveAllAgentSessionStoreCandidateTargetsSync(params.cfg, { env: params.env }),
          params.env,
          params.cfg,
        )
      : listDoctorSessionStoreTargets(params.cfg, params.env);
    if (!discoversHistory) {
      return targets;
    }
    const legacyStorePath = path.join(resolveStateDir(params.env), "sessions", "sessions.json");
    if (!fs.existsSync(legacyStorePath)) {
      return targets;
    }
    const legacyTargets = resolveSessionStoreTargets(
      params.cfg,
      { allAgents: true },
      { env: params.env },
    ).map((target) => ({
      agentId: target.agentId,
      sqlitePath: resolveTargetSqlitePath(target),
      storePath: legacyStorePath,
    }));
    return excludeRetainedAgentDatabaseTargets(
      [...legacyTargets, ...targets],
      params.env,
      params.cfg,
    );
  }
  return resolveSessionStoreTargets(params.cfg, {}, { env: params.env });
}
