import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db-contract.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-readonly.js";
import type { DB } from "./openclaw-state-db.generated.js";

export type RetainedAgentDeletion = {
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  databasePaths: string[];
};

export function parseAgentDeletionDatabasePaths(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    !parsed.every((entry): entry is string => typeof entry === "string")
  ) {
    throw new Error("Invalid agent deletion database path journal.");
  }
  return parsed;
}

/** Read the deletion owner's retained-store disposition without ensuring or repairing schema. */
export function readRetainedAgentDeletionsFromDatabase(
  database: DatabaseSync,
): RetainedAgentDeletion[] {
  const db = getNodeSqliteKysely<
    Pick<DB, "agent_deletion_journal"> & { sqlite_master: { name: string; type: string } }
  >(database);
  const table = executeSqliteQueryTakeFirstSync(
    database,
    db.selectFrom("sqlite_master").select("type").where("name", "=", "agent_deletion_journal"),
  );
  if (!table) {
    return [];
  }
  if (table.type !== "table") {
    throw new Error("Invalid agent deletion journal.");
  }
  return executeSqliteQuerySync(
    database,
    db
      .selectFrom("agent_deletion_journal")
      .select(["agent_id", "agent_dir", "workspace_dir", "database_paths_json"])
      .where("cleanup_completed", "=", 1)
      .where("delete_files", "=", 0)
      .orderBy("agent_id", "asc"),
  ).rows.map((row) => ({
    agentId: row.agent_id,
    agentDir: row.agent_dir,
    workspaceDir: row.workspace_dir,
    databasePaths: parseAgentDeletionDatabasePaths(row.database_paths_json),
  }));
}

export function readRetainedAgentDeletions(
  options: OpenClawStateDatabaseOptions,
): RetainedAgentDeletion[] {
  return (
    withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) => readRetainedAgentDeletionsFromDatabase(db),
      options,
    ) ?? []
  );
}
