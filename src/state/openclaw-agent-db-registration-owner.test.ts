import { expect, it } from "vitest";
import { readExactSessionEntryWithContinuation } from "../config/sessions/session-accessor.sqlite-exact-read.js";
import { sessionChanges, type SessionRowChange } from "../sessions/session-row-changes.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { assertOpenClawAgentReadFactsCurrent } from "./openclaw-agent-db-identity.js";
import {
  openOpenClawAgentDatabaseReadOnly,
  readOpenClawAgentReadOnlySchemaFacts,
} from "./openclaw-agent-db-readonly-open.js";
import {
  captureOpenClawAgentDatabaseRegistration,
  listOpenClawRegisteredAgentDatabases,
  readOpenClawAgentDatabaseRegistryToken,
  preservesOpenClawAgentRegistrationRead,
} from "./openclaw-agent-db-registry-listing.js";
import { registerOpenClawAgentDatabase } from "./openclaw-agent-db-registry.js";
import { openOpenClawAgentDatabase } from "./openclaw-agent-db.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  retainOpenClawStateDatabaseSelector,
} from "./openclaw-state-db-cache.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";

async function withWitness(
  operation: (fixture: {
    env: NodeJS.ProcessEnv;
    database: ReturnType<typeof openOpenClawAgentDatabase>;
    shared: ReturnType<typeof openOpenClawStateDatabase>;
    selector: ReturnType<typeof retainOpenClawStateDatabaseSelector>;
    owner: ReturnType<typeof captureOpenClawAgentDatabaseRegistration>;
    register: () => void;
    retireRead: () => void;
    revokeWriter: () => void;
    events: SessionRowChange[];
  }) => void,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const shared = openOpenClawStateDatabase({ env });
    const admission = captureOpenClawStateDatabaseReadAdmission(shared.path);
    const selector = retainOpenClawStateDatabaseSelector(admission);
    const opened = openOpenClawAgentDatabaseReadOnly({
      agentId: database.agentId,
      path: database.path,
      env,
    });
    if (!opened.found) throw new Error("Expected the real held read-only source");
    let readHeld = true;
    let writable = true;
    const accepted = readExactSessionEntryWithContinuation(opened.database, "agent:main:absent");
    if (!accepted.facts) throw new Error("Actual accepted read did not carry schema facts");
    selector.acceptSource(accepted.facts, () => {
      if (!readHeld || !opened.database.db.isOpen) throw new Error("Specific read borrow expired");
      assertOpenClawAgentReadFactsCurrent(accepted.facts!);
    });
    const owner = captureOpenClawAgentDatabaseRegistration({
      agentId: database.agentId,
      agentPath: database.path,
      admission,
      publish: false,
      assertWrite() {
        if (!writable) throw new Error("Original W revoked");
      },
    });
    const events: SessionRowChange[] = [];
    const stop = sessionChanges.subscribe((event) => {
      if ("all" in event && event.scope === "stores") events.push(event);
    });
    try {
      owner.begin();
      operation({
        env,
        database,
        shared,
        selector,
        owner,
        events,
        register: () =>
          registerOpenClawAgentDatabase(
            { agentId: database.agentId, path: database.path, env },
            undefined,
            {
              owner,
              readSource: () => readOpenClawAgentReadOnlySchemaFacts(database),
            },
          ),
        retireRead() {
          readHeld = false;
        },
        revokeWriter() {
          writable = false;
        },
      });
    } finally {
      owner.finish();
      selector.release();
      readHeld = false;
      opened.database.close();
      stop();
    }
  });
}

it("preserves a live second source when the first captured borrower expires before registration", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const shared = openOpenClawStateDatabase({ env });
    const admission = captureOpenClawStateDatabaseReadAdmission(shared.path);
    const first = retainOpenClawStateDatabaseSelector(admission);
    const second = retainOpenClawStateDatabaseSelector(admission);
    const opened = openOpenClawAgentDatabaseReadOnly({
      agentId: database.agentId,
      path: database.path,
      env,
    });
    if (!opened.found) throw new Error("Expected the real read-only source");
    const accepted = readExactSessionEntryWithContinuation(opened.database, "agent:main:absent");
    if (!accepted.facts) throw new Error("Actual read did not carry source facts");
    for (const selector of [first, second]) {
      selector.acceptSource(accepted.facts, () => {
        if (!opened.database.db.isOpen) throw new Error("Specific native read expired");
        assertOpenClawAgentReadFactsCurrent(accepted.facts!);
      });
    }
    const owner = captureOpenClawAgentDatabaseRegistration({
      agentId: database.agentId,
      agentPath: database.path,
      admission,
      assertWrite: second.assertCurrent,
      publish: false,
    });
    const events: SessionRowChange[] = [];
    const stop = sessionChanges.subscribe((event) => {
      if ("all" in event && event.scope === "stores") events.push(event);
    });
    try {
      owner.begin();
      first.release();
      registerOpenClawAgentDatabase(
        { agentId: database.agentId, path: database.path, env },
        undefined,
        {
          owner,
          readSource: () => readOpenClawAgentReadOnlySchemaFacts(database),
        },
      );
      expect(events).toHaveLength(1);
      second.assertCurrent();
      expect(() => first.assertCurrent()).toThrow();
      expect(preservesOpenClawAgentRegistrationRead(events[0]!, second)).toBe(true);
      expect(preservesOpenClawAgentRegistrationRead(events[0]!, first)).toBe(false);
    } finally {
      owner.finish();
      first.release();
      second.release();
      opened.database.close();
      stop();
    }
  });
});

it("does not certify a standalone registration from matching catalog fields alone", async () => {
  await withWitness(({ env, database, selector, shared }) => {
    registerOpenClawAgentDatabase({ agentId: database.agentId, path: database.path, env });
    expect(() => selector.assertCurrent()).toThrow();
    const fresh = retainOpenClawStateDatabaseSelector(
      captureOpenClawStateDatabaseReadAdmission(shared.path),
    );
    try {
      fresh.assertCurrent();
    } finally {
      fresh.release();
    }
  });
});

it("certifies only the exact committed event while full registry metadata freshness changes", async () => {
  await withWitness(({ env, shared, selector, register, events }) => {
    const before = readOpenClawAgentDatabaseRegistryToken({ env });
    const rows = listOpenClawRegisteredAgentDatabases({ env });
    runOpenClawStateWriteTransaction(
      () => {
        register();
        selector.assertCurrent();
        expect(events).toEqual([]);
        expect(shared.db.isTransaction).toBe(true);
      },
      { env },
    );
    expect(shared.db.isTransaction).toBe(false);
    expect(readOpenClawAgentDatabaseRegistryToken({ env })).not.toBe(before);
    expect(
      listOpenClawRegisteredAgentDatabases({ env }).map(({ agentId, path, schemaVersion }) => ({
        agentId,
        path,
        schemaVersion,
      })),
    ).toEqual(rows.map(({ agentId, path, schemaVersion }) => ({ agentId, path, schemaVersion })));
    expect(events).toHaveLength(1);
    expect(preservesOpenClawAgentRegistrationRead(events[0]!, selector)).toBe(true);
    expect(preservesOpenClawAgentRegistrationRead({ ...events[0]! }, selector)).toBe(false);
    selector.assertCurrent();
  });
});

it("interprets expired R as hard while valid W still commits exactly once", async () => {
  await withWitness(({ env, shared, selector, register, retireRead, events }) => {
    runOpenClawStateWriteTransaction(
      () => {
        register();
        retireRead();
        expect(events).toEqual([]);
      },
      { env },
    );
    expect(shared.db.isTransaction).toBe(false);
    expect(events).toHaveLength(1);
    expect(preservesOpenClawAgentRegistrationRead(events[0]!, selector)).toBe(false);
    expect(() => selector.assertCurrent()).toThrow("selector changed");
    expect(listOpenClawRegisteredAgentDatabases({ env })).toHaveLength(1);
  });
});

it("refuses the real outer COMMIT after W is revoked, with no committed event", async () => {
  await withWitness(({ env, register, revokeWriter, events }) => {
    const before = listOpenClawRegisteredAgentDatabases({ env });
    expect(() =>
      runOpenClawStateWriteTransaction(
        () => {
          register();
          revokeWriter();
        },
        { env },
      ),
    ).toThrow("Original W revoked");
    expect(events).toEqual([]);
    expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual(before);
  });
});

it("makes a raw equal-row registration hard rather than inferring continuity from row equality", async () => {
  await withWitness(({ env, database, selector, events }) => {
    registerOpenClawAgentDatabase({ agentId: database.agentId, path: database.path, env });
    expect(events).toHaveLength(1);
    expect(preservesOpenClawAgentRegistrationRead(events[0]!, selector)).toBe(false);
    expect(() => selector.assertCurrent()).toThrow("selector changed");
  });
});

it("applies mixed hard effects before either queued stores event can preserve a reader", async () => {
  await withWitness(({ env, database, selector, register, events }) => {
    runOpenClawStateWriteTransaction(
      () => {
        register();
        registerOpenClawAgentDatabase({ agentId: database.agentId, path: database.path, env });
        expect(() => selector.assertCurrent()).toThrow();
        expect(events).toEqual([]);
      },
      { env },
    );
    expect(events).toHaveLength(2);
    for (const event of events)
      expect(preservesOpenClawAgentRegistrationRead(event, selector)).toBe(false);
  });
});

it("discards nested registration participants and events on rollback without reviving hard epochs", async () => {
  await withWitness(({ env, database, selector, events }) => {
    const rollback = new Error("nested rollback");
    runOpenClawStateWriteTransaction(
      () => {
        expect(() =>
          runOpenClawStateWriteTransaction(
            () => {
              registerOpenClawAgentDatabase({
                agentId: database.agentId,
                path: database.path,
                env,
              });
              throw rollback;
            },
            { env },
          ),
        ).toThrow(rollback);
        expect(() => selector.assertCurrent()).toThrow();
      },
      { env },
    );
    expect(events).toEqual([]);
    expect(listOpenClawRegisteredAgentDatabases({ env })).toHaveLength(1);
  });
});
