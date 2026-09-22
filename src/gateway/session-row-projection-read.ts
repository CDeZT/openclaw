import { expectDefined } from "@openclaw/normalization-core";
import { getSubagentSessionListReadSnapshotIdentity } from "../agents/subagents/registry/subagent-registry-state.js";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { withSessionHistoryWorkerDatabases } from "../config/sessions/session-transcript-worker-runtime.js";
import {
  MAX_SESSION_ROW_FACTS_KEYS,
  type SessionRowDatabaseFacts,
} from "../config/sessions/session-transcript-worker.types.js";
import { resolveStateDir } from "../config/state-dir.js";
import { identity, isCurrentGeneration, type Row } from "./session-row-projection-record.js";

/** Retain each selected store until its prepared rows have been consumed by the projection. */
export async function withSessionRowDatabaseFacts(
  owner: {
    rows: ReadonlyMap<string, Row>;
    dirty: ReadonlySet<string>;
    revision: () => number | undefined;
  },
  consume: (ids: readonly string[], facts: ReadonlyMap<string, SessionRowDatabaseFacts>) => void,
): Promise<void> {
  const revision = owner.revision();
  const registrySnapshot = getSubagentSessionListReadSnapshotIdentity();
  const ids: string[] = [];
  for (const id of owner.dirty) {
    ids.push(id);
    if (ids.length === MAX_SESSION_ROW_FACTS_KEYS) {
      break;
    }
  }
  const rows = ids.flatMap((id) => owner.rows.get(id) ?? []);
  const env = cloneEnvWithPlatformSemantics(process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const groups = new Map<
    string,
    { database: { agentId: string; path: string; env: NodeJS.ProcessEnv }; rows: Row[] }
  >();
  for (const row of rows) {
    const { agentId, storePath } = row.storeTarget;
    const key = JSON.stringify([agentId, storePath]);
    let group = groups.get(key);
    if (!group) {
      group = { database: { agentId, path: storePath, env }, rows: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
  }
  const selected = [...groups.values()];
  await withSessionHistoryWorkerDatabases(
    selected.map(({ database }) => database),
    async (owners) => {
      const facts = new Map<string, SessionRowDatabaseFacts>();
      // Finish each accepted read before releasing any captured database owner on failure.
      for (const [index, group] of selected.entries()) {
        const databaseOwner = expectDefined(owners[index], "captured session row database");
        const reply = await databaseOwner.readRowFacts({
          env,
          sessionKeys: [...new Set(group.rows.map((row) => row.key))],
        });
        const byKey = new Map(reply.rows.map((row) => [row.sessionKey, row]));
        for (const row of group.rows) {
          const prepared = byKey.get(row.key);
          if (prepared) {
            facts.set(identity(row), prepared);
          }
        }
      }
      for (const databaseOwner of owners) {
        databaseOwner.assertCurrent();
      }
      if (
        revision !== undefined &&
        owner.revision() === revision &&
        registrySnapshot === getSubagentSessionListReadSnapshotIdentity()
      ) {
        const currentIds = rows
          .filter(
            (row) =>
              owner.dirty.has(identity(row)) &&
              isCurrentGeneration(row, owner.rows.get(identity(row))),
          )
          .map(identity);
        consume(currentIds, facts);
      }
    },
  );
}
