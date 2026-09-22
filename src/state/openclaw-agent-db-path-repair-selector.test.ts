import { expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { repairOpenClawAgentDatabasePathAliases } from "./openclaw-agent-db-path-repair.js";
import { openOpenClawAgentDatabase } from "./openclaw-agent-db.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  retainOpenClawStateDatabaseSelector,
} from "./openclaw-state-db-cache.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";

it.runIf(process.platform === "win32").each(["commit", "rollback"] as const)(
  "holds real Windows alias repair through outer %s",
  async (outcome) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const agent = openOpenClawAgentDatabase({ agentId: "main", env });
      const shared = openOpenClawStateDatabase({ env });
      const extended = agent.path.startsWith("\\\\?\\") ? agent.path : `\\\\?\\${agent.path}`;
      // Normal registration canonicalizes this path already. Seed the persisted
      // legacy alias so the real repair owner, not a fake writer, performs the fix.
      runOpenClawStateWriteTransaction(
        (database) => {
          const inserted = database.db
            .prepare(
              "INSERT INTO agent_databases (agent_id, path, schema_version, last_seen_at, size_bytes) SELECT agent_id, ?, schema_version, last_seen_at, size_bytes FROM agent_databases WHERE agent_id = ? LIMIT 1",
            )
            .run(extended, agent.agentId);
          expect(inserted.changes).toBe(1);
        },
        { env, database: shared },
      );
      const admission = captureOpenClawStateDatabaseReadAdmission(shared.path);
      const previous = retainOpenClawStateDatabaseSelector(admission);
      try {
        const transaction = () =>
          runOpenClawStateWriteTransaction(
            (database) => {
              expect(repairOpenClawAgentDatabasePathAliases(database).repaired).toBe(1);
              expect(() => previous.assertCurrent()).toThrow();
              let during: ReturnType<typeof retainOpenClawStateDatabaseSelector> | undefined;
              try {
                expect(() => {
                  during = retainOpenClawStateDatabaseSelector(admission);
                  during.assertCurrent();
                }).toThrow();
              } finally {
                during?.release();
              }
              if (outcome === "rollback") throw new Error("outer alias rollback");
            },
            { env, database: shared },
          );
        if (outcome === "rollback") expect(transaction).toThrow("outer alias rollback");
        else transaction();
        expect(() => previous.assertCurrent()).toThrow();
        const next = retainOpenClawStateDatabaseSelector(admission);
        try {
          next.assertCurrent();
        } finally {
          next.release();
        }
      } finally {
        previous.release();
      }
    });
  },
);
