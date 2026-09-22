import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { ensureSessionKeyContractSchemaInTransaction } from "./openclaw-agent-db-schema-helpers.js";
import { ensureSessionEntryValidityProjection } from "./openclaw-agent-db-session-migrations.js";

function withCurrentProjection(operation: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE session_nodes (
        session_key TEXT PRIMARY KEY,
        current_session_id TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        entry_valid INTEGER NOT NULL DEFAULT 0 CHECK (entry_valid IN (-1, 0, 1))
      );
    `);
    ensureSessionEntryValidityProjection(db);
    ensureSessionKeyContractSchemaInTransaction(db);
    operation(db);
  } finally {
    db.close();
  }
}

it("requires mutation authority before pending rows in an otherwise current projection", () => {
  withCurrentProjection((db) => {
    db.prepare("INSERT INTO session_nodes VALUES (?, ?, ?, ?, ?)").run(
      "agent:main:pending",
      "pending-session",
      JSON.stringify({ sessionId: "pending-session", updatedAt: 1 }),
      1,
      0,
    );
    const beforeMutation = vi.fn(() => {
      expect(db.prepare("SELECT entry_valid FROM session_nodes").get()?.entry_valid).toBe(0);
      throw new Error("original write authority revoked");
    });
    expect(() => ensureSessionEntryValidityProjection(db, beforeMutation)).toThrow(
      "original write authority revoked",
    );
    expect(beforeMutation).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT entry_valid FROM session_nodes").get()?.entry_valid).toBe(0);
    const accepted = vi.fn();
    ensureSessionEntryValidityProjection(db, accepted);
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT entry_valid FROM session_nodes").get()?.entry_valid).toBe(1);
  });
});

it("fences a missing session-key seed before INSERT OR IGNORE can restore it", () => {
  withCurrentProjection((db) => {
    db.exec("DELETE FROM session_key_contract WHERE id = 1");
    const beforeMutation = vi.fn(() => {
      expect(db.prepare("SELECT 1 FROM session_key_contract").get()).toBeUndefined();
      throw new Error("seed mutation denied");
    });
    expect(() => ensureSessionKeyContractSchemaInTransaction(db, beforeMutation)).toThrow(
      "seed mutation denied",
    );
    expect(beforeMutation).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT 1 FROM session_key_contract").get()).toBeUndefined();
  });
});

it.each([
  "session_nodes_entry_valid_after_insert",
  "session_nodes_entry_valid_after_entry_update",
  "session_nodes_entry_valid_after_identity_update",
])("requires authority before restoring %s", (trigger) => {
  withCurrentProjection((db) => {
    db.exec(`DROP TRIGGER ${trigger}`);
    const beforeMutation = vi.fn(() => {
      throw new Error("trigger mutation denied");
    });
    expect(() => ensureSessionEntryValidityProjection(db, beforeMutation)).toThrow(
      "trigger mutation denied",
    );
    expect(beforeMutation).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name = ?").get(trigger)).toBeUndefined();
    expect(() => ensureSessionKeyContractSchemaInTransaction(db, beforeMutation)).toThrow(
      "trigger mutation denied",
    );
    expect(beforeMutation).toHaveBeenCalledTimes(2);
  });
});

it("does not promote a healthy no-op projection or contract refresh", () => {
  withCurrentProjection((db) => {
    const beforeMutation = vi.fn(() => {
      throw new Error("healthy metadata refresh was incorrectly invalidated");
    });
    ensureSessionEntryValidityProjection(db, beforeMutation);
    ensureSessionKeyContractSchemaInTransaction(db, beforeMutation);
    expect(beforeMutation).not.toHaveBeenCalled();
  });
});
