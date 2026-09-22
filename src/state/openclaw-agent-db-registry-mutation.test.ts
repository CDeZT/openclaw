import { expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  unregisterOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabases,
} from "./openclaw-agent-db-registry.js";
import { openOpenClawAgentDatabase } from "./openclaw-agent-db.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  retainOpenClawStateDatabaseSelector,
} from "./openclaw-state-db-cache.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";

it.each([
  ["one", "commit"],
  ["one", "rollback"],
  ["all", "commit"],
  ["all", "rollback"],
] as const)("holds %s deregistration's hard interval through outer %s", async (kind, outcome) => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const agent = openOpenClawAgentDatabase({ agentId: "main", env });
    const shared = openOpenClawStateDatabase({ env });
    const admission = captureOpenClawStateDatabaseReadAdmission(shared.path);
    const before = retainOpenClawStateDatabaseSelector(admission);
    before.assertCurrent();
    const transaction = () =>
      runOpenClawStateWriteTransaction(
        () => {
          if (kind === "one") {
            unregisterOpenClawAgentDatabase({ agentId: agent.agentId, path: agent.path, env });
          } else {
            unregisterOpenClawAgentDatabases({ agentId: agent.agentId, database: shared, env });
          }
          expect(shared.db.isTransaction).toBe(true);
          expect(() => before.assertCurrent()).toThrow();
          let during: ReturnType<typeof retainOpenClawStateDatabaseSelector> | undefined;
          try {
            expect(() => {
              during = retainOpenClawStateDatabaseSelector(admission);
              during.assertCurrent();
            }).toThrow();
          } finally {
            during?.release();
          }
          if (outcome === "rollback") throw new Error("outer catalog rollback");
        },
        { env, database: shared },
      );
    try {
      if (outcome === "rollback") {
        expect(transaction).toThrow("outer catalog rollback");
      } else {
        transaction();
      }
      expect(shared.db.isTransaction).toBe(false);
      expect(() => before.assertCurrent()).toThrow();
      const after = retainOpenClawStateDatabaseSelector(admission);
      try {
        after.assertCurrent();
      } finally {
        after.release();
      }
    } finally {
      before.release();
    }
  });
});
