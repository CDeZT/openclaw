import { randomUUID } from "node:crypto";
import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import type { Result } from "@openclaw/normalization-core/result";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-coordinator.js";
import { assertTransactionUsable } from "../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../infra/sqlite-worker-contract.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../infra/sqlite-worker-identity.js";
import {
  requestSqliteWorkerOperationAdmission,
  deferSqliteWorkerCommitEffect,
  SqliteWorkerOpenRefusedError,
} from "../infra/sqlite-worker-operation-admission.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseRegistrationFacts,
} from "./openclaw-agent-db-contract.js";
import { readOpenClawAgentDatabaseIdentity } from "./openclaw-agent-db-identity.js";
import { prepareOpenClawAgentDatabaseWorkerLease } from "./openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabaseByPath,
  retainAgentDatabase,
} from "./openclaw-agent-db-lifecycle.js";
import { ensureOpenClawAgentDatabasePermissions } from "./openclaw-agent-db-permissions.js";
import type { OpenClawAgentRegistrationTransactionOwner } from "./openclaw-agent-db-registry-listing.js";
import {
  getOpenClawAgentDatabaseValidation,
  type OpenClawAgentDatabaseValidation,
} from "./openclaw-agent-db-validation-cache.js";
import { getOpenClawAgentDatabaseIfOpen, openOpenClawAgentDatabase } from "./openclaw-agent-db.js";
import type {
  AgentDatabaseExecutionIdentity,
  AgentDatabaseExecutionOpen,
  AgentDatabaseOperations,
} from "./openclaw-agent-execution-contract.js";
import { createAgentDatabaseDomainOwner } from "./openclaw-agent-execution-domain.js";
import {
  requireOpenClawStateDatabaseIdentity,
  retainOpenClawStateDatabase,
} from "./openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";

/** The broker supplies a private admission channel before invoking this native factory. */
export function openExistingSqliteWorkerBackend(
  input: AgentDatabaseExecutionOpen,
  opening: { databasePath: string; existingIdentity?: string },
): SqliteWorkerBackend<AgentDatabaseOperations> {
  if (opening.databasePath !== input.databasePath) {
    throw new Error("Agent database open does not match its captured execution owner");
  }
  const admitOpen = () => {
    try {
      requestSqliteWorkerOperationAdmission({ stage: "open", facts: input });
    } catch (error) {
      throw new SqliteWorkerOpenRefusedError(error);
    }
  };
  admitOpen();
  const options = { agentId: input.agentId, path: input.databasePath, env: input.environment };
  let admittedFileIdentity =
    opening.existingIdentity ?? readDatabasePathIdentitySync(input.databasePath).key;
  const assertFileIdentity = () => {
    if (input.expectedIdentity) {
      assertExistingDatabaseIdentity(
        input.databasePath,
        `file:${input.expectedIdentity.physicalIdentity}`,
      );
    }
    if (admittedFileIdentity) {
      assertExistingDatabaseIdentity(input.databasePath, admittedFileIdentity);
    }
  };
  let database: OpenClawAgentDatabase | undefined;
  let shared: ReturnType<typeof openOpenClawStateDatabase> | undefined;
  let sharedBorrow: ReturnType<typeof retainOpenClawStateDatabase> | undefined;
  let releaseBorrow: (() => void) | undefined;
  let identity: AgentDatabaseExecutionIdentity | undefined;
  let identityPublished = false;
  let openingFailure: { error: unknown } | undefined;
  const openWriter = () => {
    let validation: OpenClawAgentDatabaseValidation | undefined;
    if (!database) {
      // Promotion needs the current command's source authority before any durable open work.
      admitOpen();
      assertFileIdentity();
      if (!shared) {
        shared = openOpenClawStateDatabase({
          path: input.stateDatabasePath,
          env: input.environment,
        });
        sharedBorrow = retainOpenClawStateDatabase(shared);
      }
      const lease = prepareOpenClawAgentDatabaseWorkerLease(options, shared, input.leaseId);
      const { port1, port2 } = new MessageChannel();
      try {
        requestSqliteWorkerOperationAdmission(
          {
            stage: "prepare",
            facts: {
              kind: "shared-owner",
              identity: requireOpenClawStateDatabaseIdentity(shared),
              lease: lease.receipt,
              validationPort: port2,
            },
          },
          [port2],
        );
        // The host posts before granting admission; shared revocation remains live after transfer.
        // SAFETY: this private port receives only the host's typed validation receipt.
        lease.validation = receiveMessageOnPort(port1)?.message as
          | OpenClawAgentDatabaseValidation
          | undefined;
      } catch (error) {
        throw new SqliteWorkerOpenRefusedError(error);
      } finally {
        port1.close();
        port2.close();
      }
      assertFileIdentity();
      const intentId = randomUUID();
      const binding = {
        intentId,
        leaseId: input.leaseId,
        agentId: input.agentId,
        agentPath: input.databasePath,
        stateDatabasePath: lease.receipt.sharedStatePath,
        stateDatabaseIdentity: lease.receipt.sharedStateIdentity,
      };
      let finalFacts: OpenClawAgentDatabaseRegistrationFacts | undefined;
      let transactionAdmitted = false;
      const requestRegistration = (
        stage: "prepare" | "transaction" | "commit",
        kind:
          | "agent-registration-mutation"
          | "agent-registration-selector"
          | "agent-registration-commit",
        facts?: OpenClawAgentDatabaseRegistrationFacts,
      ) => {
        assertFileIdentity();
        requestSqliteWorkerOperationAdmission({
          stage,
          facts: { kind, binding, registration: facts },
        });
      };
      const registration: OpenClawAgentRegistrationTransactionOwner = {
        assertWrite: assertFileIdentity,
        beforeMutation() {
          requestRegistration("prepare", "agent-registration-mutation");
        },
        classify(facts) {
          requestRegistration(
            transactionAdmitted ? "prepare" : "transaction",
            "agent-registration-selector",
            facts,
          );
          transactionAdmitted = true;
          finalFacts = facts;
        },
        prepareEvent() {},
        retainTransaction() {
          return { commit() {}, rollback() {} };
        },
        prepareReceipt(db, receipt, facts) {
          deferSqliteWorkerCommitEffect(db, {
            kind: "agent-registration",
            binding,
            receipt,
            registration: facts,
          });
        },
        withCommit(commit) {
          if (!finalFacts) throw new Error("Registration COMMIT has no canonical selector facts");
          requestRegistration("commit", "agent-registration-commit", finalFacts);
          assertFileIdentity();
          commit();
        },
      };
      let openingResult: Result<OpenClawAgentDatabase, unknown>;
      try {
        const opened = openOpenClawAgentDatabase(options, lease, undefined, registration);
        database = opened;
        releaseBorrow = retainAgentDatabase(opened.db);
        openingResult = { ok: true, value: opened };
      } catch (error) {
        openingFailure = { error };
        openingResult = { ok: false, error };
      }
      if (!openingResult.ok) {
        throw openingResult.error;
      }
      const opened = openingResult.value;
      const nativeIdentity = readOpenClawAgentDatabaseIdentity(opened);
      if (typeof nativeIdentity.identity !== "string") {
        throw new Error("Disk agent execution requires its canonical file identity");
      }
      const openedFileIdentity = `file:${nativeIdentity.identity}`;
      if (admittedFileIdentity && openedFileIdentity !== admittedFileIdentity) {
        throw new Error("Agent writer differs from its admitted physical file");
      }
      if (
        input.expectedIdentity &&
        nativeIdentity.identity !== input.expectedIdentity.physicalIdentity
      ) {
        throw new Error("Agent writer differs from its expected physical file");
      }
      admittedFileIdentity = openedFileIdentity;
      identity = {
        kind: "file",
        physicalIdentity: nativeIdentity.identity,
        incarnation: nativeIdentity.incarnation,
        nativeLocation: nativeIdentity.filename,
      };
      validation = getOpenClawAgentDatabaseValidation(opened);
    }
    if (!database || !database.db.isOpen || getOpenClawAgentDatabaseIfOpen(options) !== database) {
      throw new Error("Agent execution lost its retained native database");
    }
    try {
      requestSqliteWorkerOperationAdmission({ stage: "prepare", facts: { identity, validation } });
      identityPublished = true;
    } catch (error) {
      // A refused first native-identity publication still requires native retirement.
      if (!identityPublished) openingFailure = { error };
      throw error;
    }
    return database;
  };
  const domain = createAgentDatabaseDomainOwner({
    databasePath: input.databasePath,
    assertCurrent() {
      assertOpen();
      const current = openWriter();
      assertFileIdentity();
      return current.db;
    },
    admit(stage) {
      assertFileIdentity();
      requestSqliteWorkerOperationAdmission({ stage, facts: { identity } });
      if (stage === "commit") {
        ensureOpenClawAgentDatabasePermissions(input.databasePath, options);
      }
    },
  });
  let closed = false;
  const assertOpen = () => {
    if (closed) {
      throw new Error("Agent database execution owner is closed");
    }
  };
  return {
    prepare(command) {
      if (
        command.type === "database.domain.bind" ||
        command.type === "database.domain.execute" ||
        command.type === "database.domain.close"
      ) {
        return domain.prepare(command);
      }
      return undefined;
    },
    assertSettled() {
      if (openingFailure) {
        // A failed promotion requires native retirement, including custody retained by the opener.
        throw openingFailure.error;
      }
      domain.assertSettled();
      if (database) {
        assertTransactionUsable(database.db);
        if (!identity || !database.db.isOpen || database.db.isTransaction) {
          throw new Error("Agent database command left an unsettled native connection");
        }
      }
    },
    execute(command) {
      assertOpen();
      if (
        command.type === "database.domain.bind" ||
        command.type === "database.domain.execute" ||
        command.type === "database.domain.close"
      ) {
        return domain.execute(command);
      }
      if (command.type === "database.prepareWrite") {
        openWriter();
        return undefined;
      }
      throw new Error("Unknown agent database operation");
    },
    close() {
      closed = true;
      const errors: unknown[] = [];
      for (const cleanup of [
        () => domain.close(),
        () => database && closeOpenClawAgentDatabaseByPath(database.path, database.agentId),
        () => releaseBorrow?.(),
        () => sharedBorrow?.release(),
      ]) {
        try {
          cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw createSqliteLifecycleAggregateError(
          errors,
          "Agent database cleanup failed",
          errors[0],
        );
      }
    },
  };
}
