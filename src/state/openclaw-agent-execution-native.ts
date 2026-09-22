import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Result } from "@openclaw/normalization-core/result";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-coordinator.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import type {
  SqliteWorkerAdmissionFactory,
  SqliteWorkerAdmissionRequest,
} from "../infra/sqlite-worker-operation-admission.js";
import {
  closeUnclaimedSharedStateSqliteWorkers,
  isSqliteWorkerStoreAvailable,
  openAgentDatabaseSqliteWorkerStore,
  runSqliteWorkerStoreOperation,
  type SqliteWorkerStore,
} from "../infra/sqlite-worker-store.js";
import type {
  OpenClawAgentDatabaseRegistrationFacts,
  OpenClawAgentDatabaseRegistrationCommit,
  OpenClawAgentDatabaseReadFacts,
  OpenClawAgentDatabaseSelectorRow,
} from "./openclaw-agent-db-contract.js";
import type { OpenClawAgentDatabaseWorkerLeaseReceipt } from "./openclaw-agent-db-lease.js";
import { captureOpenClawAgentDatabaseRegistration } from "./openclaw-agent-db-registry-listing.js";
import {
  captureOpenClawAgentDatabaseValidationTransfer,
  getOpenClawAgentDatabaseValidationForTransfer,
} from "./openclaw-agent-db-validation-cache.js";
import { cleanupRetiredAgentDatabaseLease } from "./openclaw-agent-execution-cleanup.js";
import type {
  AgentDatabaseExecutionIdentity,
  AgentDatabaseExecutionFileIdentity,
  AgentDatabaseExecutionOpen,
  AgentDatabaseRequestExecutionSource,
  AgentDatabaseOperations,
} from "./openclaw-agent-execution-contract.js";
import { requestOpenClawAgentDatabaseQuickCheck } from "./openclaw-database-verify.js";
import { publishOpenClawStateDatabaseWorkerAdmission } from "./openclaw-state-db-cache.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

type Store = SqliteWorkerStore<AgentDatabaseOperations>;
type Registration = ReturnType<typeof captureOpenClawAgentDatabaseRegistration>;

async function settleAgentRegistration<T>(
  registration: Registration,
  operation: () => Promise<T>,
  reconcile: (operationSucceeded: boolean) => void,
): Promise<T> {
  let result: Result<T, unknown>;
  try {
    result = { ok: true, value: await operation() };
  } catch (error) {
    result = { ok: false, error };
  }
  try {
    reconcile(result.ok);
  } catch (error) {
    registration.abandonPreservation();
    result = {
      ok: false,
      error: result.ok
        ? error
        : createSqliteLifecycleAggregateError(
            [result.error, error],
            "Agent open and committed-fact reconciliation failed",
            result.error,
          ),
    };
  }
  try {
    registration.finish();
  } catch (error) {
    if (!result.ok) {
      throw createSqliteLifecycleAggregateError(
        [result.error, error],
        "Agent open and registration publication failed",
        result.error,
      );
    }
    throw error;
  }
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function decodeRegistrationFacts(value: unknown): OpenClawAgentDatabaseRegistrationFacts {
  const row = (input: unknown): OpenClawAgentDatabaseSelectorRow => {
    if (
      !isRecord(input) ||
      typeof input.agentId !== "string" ||
      typeof input.path !== "string" ||
      typeof input.schemaVersion !== "number" ||
      !Number.isSafeInteger(input.schemaVersion)
    ) {
      throw new Error("Invalid registration selector facts");
    }
    return { agentId: input.agentId, path: input.path, schemaVersion: input.schemaVersion };
  };
  if (!isRecord(value)) throw new Error("Missing canonical registration facts");
  let source: OpenClawAgentDatabaseReadFacts | null = null;
  if (value.source !== null) {
    const observed = value.source;
    if (
      !isRecord(observed) ||
      typeof observed.agentId !== "string" ||
      typeof observed.path !== "string" ||
      typeof observed.physicalIdentity !== "string" ||
      typeof observed.birthtime !== "string" ||
      typeof observed.userVersion !== "number" ||
      !Number.isSafeInteger(observed.userVersion) ||
      (observed.schemaVersion !== null &&
        (typeof observed.schemaVersion !== "number" ||
          !Number.isSafeInteger(observed.schemaVersion))) ||
      (observed.role !== null && typeof observed.role !== "string") ||
      (observed.schemaAgentId !== null && typeof observed.schemaAgentId !== "string")
    ) {
      throw new Error("Invalid registration physical/schema facts");
    }
    source = {
      agentId: observed.agentId,
      path: observed.path,
      physicalIdentity: observed.physicalIdentity,
      birthtime: observed.birthtime,
      userVersion: observed.userVersion,
      schemaVersion: observed.schemaVersion,
      role: observed.role,
      schemaAgentId: observed.schemaAgentId,
    };
  }
  return {
    before: value.before === null ? null : row(value.before),
    after: row(value.after),
    source,
  };
}

export type AgentDatabaseExecutionScope = Pick<Store, "execute">;
export type AgentDatabaseNativeGeneration = {
  failed(): boolean;
  runExisting<T>(
    source: AgentDatabaseRequestExecutionSource,
    operation: (scope: AgentDatabaseExecutionScope) => Promise<T>,
    assertCallerCurrent?: () => void,
  ): Promise<T | undefined>;
  close(): Promise<void>;
};

/** A logical execution owner can replace this generation only after its native close settles. */
export function createAgentDatabaseNativeGeneration(
  agentId: string,
  pathname: string,
  context: OpenClawStateWorkerContext,
  assertLogicalCurrent: () => void,
  assertCleanupOwned: () => void,
  expectedIdentity: AgentDatabaseExecutionFileIdentity | undefined,
  acceptFileIdentity: (identity: AgentDatabaseExecutionFileIdentity) => void,
): AgentDatabaseNativeGeneration {
  const input: AgentDatabaseExecutionOpen = {
    leaseId: randomUUID(),
    agentId,
    databasePath: pathname,
    stateDatabasePath: context.admission.databasePath,
    environment: context.environment,
    ...(expectedIdentity ? { expectedIdentity } : {}),
  };
  let retiring = false;
  let opening: Promise<Store | undefined> | undefined;
  let openedStore: Store | undefined;
  let openingFailed = false;
  let closing: Promise<void> | undefined;
  let nativeIdentity: AgentDatabaseExecutionIdentity | undefined;
  let nativeStopped: Promise<void> | undefined;
  let lease: OpenClawAgentDatabaseWorkerLeaseReceipt | undefined;
  let quickCheckPending = false;
  const registrationSettlements = new WeakMap<
    Registration,
    (operationSucceeded: boolean) => void
  >();
  let receiveValidation:
    | ReturnType<typeof captureOpenClawAgentDatabaseValidationTransfer>
    | undefined;

  const assertCurrent = () => {
    assertLogicalCurrent();
    if (retiring) {
      throw new Error("Agent native generation is retiring");
    }
    if (openedStore && !isSqliteWorkerStoreAvailable(openedStore)) {
      throw new Error("Agent database execution lost its native owner");
    }
  };
  const admission =
    (
      source: AgentDatabaseRequestExecutionSource,
      registration?: Registration,
      assertCallerCurrent?: () => void,
    ): SqliteWorkerAdmissionFactory =>
    (operation) => {
      const nativeLocations = [
        pathname,
        ...(nativeIdentity ? [nativeIdentity.nativeLocation] : []),
        context.admission.databasePath,
        context.admission.identity.canonicalPath,
      ];
      let binding:
        | {
            intentId: string;
            leaseId: string;
            agentId: string;
            agentPath: string;
            stateDatabasePath: string;
            stateDatabaseIdentity: string;
          }
        | undefined;
      let commitRequest: SqliteWorkerAdmissionRequest | undefined;
      let commitFacts: OpenClawAgentDatabaseRegistrationFacts | undefined;
      const authorizeNative = (request: SqliteWorkerAdmissionRequest): boolean => {
        const facts = request.facts;
        if (
          isRecord(facts) &&
          (facts.kind === "agent-registration-mutation" ||
            facts.kind === "agent-registration-selector" ||
            facts.kind === "agent-registration-commit")
        ) {
          assertCurrent();
          assertCallerCurrent?.();
          source.assertCurrent();
          const received = facts.binding;
          if (
            !registration ||
            !lease ||
            !isRecord(received) ||
            typeof received.intentId !== "string" ||
            received.intentId.length === 0 ||
            received.intentId.length > 128
          ) {
            throw new Error("Registration request has no admitted operation/lease binding");
          }
          const expected = {
            intentId: binding?.intentId ?? received.intentId,
            leaseId: input.leaseId,
            agentId: input.agentId,
            agentPath: pathname,
            stateDatabasePath: lease.sharedStatePath,
            stateDatabaseIdentity: lease.sharedStateIdentity,
          };
          if (!isDeepStrictEqual(received, expected))
            throw new Error("Registration request changed its original owner");
          binding ??= expected;
          if (facts.kind === "agent-registration-mutation") {
            if (request.stage !== "prepare")
              throw new Error("Registration mutation request is out of order");
            registration.beforeMutation();
          } else {
            if ((facts.kind === "agent-registration-commit") !== (request.stage === "commit")) {
              throw new Error("Registration COMMIT request is out of order");
            }
            const canonical = decodeRegistrationFacts(facts.registration);
            if (
              canonical.after.agentId !== input.agentId ||
              canonical.after.path !== pathname ||
              (canonical.source &&
                (canonical.source.agentId !== input.agentId || canonical.source.path !== pathname))
            ) {
              throw new Error("Registration facts differ from the captured source");
            }
            if (canonical.source)
              assertExistingDatabaseIdentity(pathname, `file:${canonical.source.physicalIdentity}`);
            registration.classify(canonical);
            if (request.stage === "commit") {
              if (commitRequest) throw new Error("Registration COMMIT grant was reused");
              commitRequest = request;
              commitFacts = structuredClone(canonical);
            }
          }
          // A hard promotion may revoke the original requester: never bypass that W.
          assertCurrent();
          assertCallerCurrent?.();
          source.assertCurrent();
          return true;
        }
        assertCurrent();
        assertCallerCurrent?.();
        if (request.stage === "prepare" && isRecord(facts) && facts.kind === "shared-owner") {
          if (!(facts.validationPort instanceof MessagePort)) {
            throw new Error("Agent worker lost its validation handoff port");
          }
          try {
            source.assertCurrent();
            publishOpenClawStateDatabaseWorkerAdmission(context.admission);
            const received = facts.lease;
            if (
              !isDeepStrictEqual(facts.identity, context.admission.identity) ||
              !isRecord(received) ||
              received.leaseId !== input.leaseId ||
              received.agentId !== input.agentId ||
              received.path !== pathname ||
              received.ownerPid !== process.pid ||
              (received.ownerStartTime !== null && typeof received.ownerStartTime !== "number") ||
              received.sharedStatePath !== context.admission.databasePath ||
              received.sharedStateIdentity !== context.admission.identity.key
            ) {
              throw new Error("Agent worker lease differs from its captured native owner");
            }
            lease = {
              leaseId: input.leaseId,
              agentId: input.agentId,
              path: pathname,
              ownerPid: process.pid,
              ownerStartTime: received.ownerStartTime,
              sharedStatePath: context.admission.databasePath,
              sharedStateIdentity: context.admission.identity.key,
            };
            receiveValidation = captureOpenClawAgentDatabaseValidationTransfer({
              agentId,
              path: pathname,
            });
            facts.validationPort.postMessage(
              getOpenClawAgentDatabaseValidationForTransfer({ agentId, path: pathname }),
              [],
            );
          } finally {
            facts.validationPort.close();
          }
          return true;
        }
        if (
          request.stage === "prepare" &&
          isRecord(facts) &&
          facts.kind === "agent-integrity-cached"
        ) {
          source.assertCurrent();
          if (!lease || !isDeepStrictEqual(facts.lease, lease)) {
            throw new Error("Agent integrity notice differs from its captured native lease");
          }
          quickCheckPending = true;
          return true;
        }
        if (request.stage === "open") {
          if (!isDeepStrictEqual(facts, input)) {
            throw new Error("Agent database open differs from its captured owner");
          }
        } else {
          const received = isRecord(facts) ? facts.identity : undefined;
          if (
            !isRecord(received) ||
            received.kind !== "file" ||
            typeof received.physicalIdentity !== "string" ||
            typeof received.incarnation !== "string" ||
            typeof received.nativeLocation !== "string" ||
            (nativeIdentity && !isDeepStrictEqual(received, nativeIdentity))
          ) {
            throw new Error("Agent database operation belongs to another native owner");
          }
          const receivedIdentity: AgentDatabaseExecutionIdentity = {
            kind: "file",
            physicalIdentity: received.physicalIdentity,
            incarnation: received.incarnation,
            nativeLocation: received.nativeLocation,
          };
          assertExistingDatabaseIdentity(pathname, `file:${receivedIdentity.physicalIdentity}`);
          if (
            expectedIdentity &&
            receivedIdentity.physicalIdentity !== expectedIdentity.physicalIdentity
          ) {
            throw new Error("Agent database operation differs from its expected physical file");
          }
          acceptFileIdentity({
            kind: "file",
            physicalIdentity: receivedIdentity.physicalIdentity,
            nativeLocation: receivedIdentity.nativeLocation,
          });
          assertCallerCurrent?.();
          nativeIdentity ??= receivedIdentity;
        }
        return false;
      };
      const prepareGrant = (request: SqliteWorkerAdmissionRequest) => {
        assertCurrent();
        assertCallerCurrent?.();
        if (request.stage === "open") {
          registration?.begin();
        }
      };
      const retained = source.createAdmission({
        nativeLocations,
        assertCurrent,
        authorize(request) {
          if (authorizeNative(request)) {
            return;
          }
          source.assertCurrent();
          prepareGrant(request);
          if (request.stage === "prepare" && nativeIdentity && isRecord(request.facts)) {
            receiveValidation?.(nativeIdentity.physicalIdentity, request.facts.validation);
            receiveValidation = undefined;
          }
        },
      })(operation);
      if (registration)
        registrationSettlements.set(registration, (operationSucceeded) => {
          const failures: unknown[] = [];
          let validatedReceipt: OpenClawAgentDatabaseRegistrationCommit | undefined;
          for (const effect of retained.admission.committed?.effects ?? []) {
            if (!isRecord(effect) || typeof effect.kind !== "string" || effect.kind.length === 0) {
              failures.push(new Error("Malformed native COMMIT effect"));
              continue;
            }
            if (effect.kind !== "agent-registration") continue;
            const receipt = {
              agentId: input.agentId,
              agentPath: pathname,
              stateDatabasePath: context.admission.databasePath,
              stateDatabaseIdentity: lease?.sharedStateIdentity,
            };
            try {
              if (
                !binding ||
                !lease ||
                !commitRequest ||
                !commitFacts ||
                !isDeepStrictEqual(effect.binding, binding) ||
                !isDeepStrictEqual(effect.receipt, receipt) ||
                !isDeepStrictEqual(effect.registration, commitFacts)
              ) {
                throw new Error("Unbound native registration COMMIT evidence");
              }
              if (!retained.admission.wasGranted?.(commitRequest)) {
                throw new Error("Native registration COMMIT lacks its exact host grant");
              }
              if (validatedReceipt) {
                throw new Error("Duplicate native registration COMMIT evidence");
              }
              validatedReceipt = {
                ...receipt,
                stateDatabaseIdentity: lease.sharedStateIdentity,
              };
            } catch (error) {
              // Validate the entire set before publishing state. A bad neighbor
              // must not hide an independently bound and actually granted fact.
              failures.push(error);
            }
          }
          if (operationSucceeded && commitRequest && !validatedReceipt) {
            failures.push(new Error("Missing native registration COMMIT evidence"));
          }
          if (validatedReceipt) {
            // Apply one proven fact once; duplicate claims still fail the operation
            // without erasing that original COMMIT or minting another publication.
            registration.recordCommitted(validatedReceipt);
          }
          if (failures.length === 1) throw failures[0];
          if (failures.length) {
            throw createSqliteLifecycleAggregateError(
              failures,
              "Native registration COMMIT evidence was rejected",
              failures[0],
            );
          }
        });
      return retained;
    };
  const open = (
    source: AgentDatabaseRequestExecutionSource,
    assertCallerCurrent?: () => void,
  ): Promise<Store | undefined> => {
    assertCurrent();
    source.assertCurrent();
    assertCallerCurrent?.();
    opening ??= (async () => {
      const store = await openAgentDatabaseSqliteWorkerStore<AgentDatabaseOperations>(
        {
          moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.agentDatabaseExecution),
          databasePath: pathname,
          input,
          existingOnly: true,
        },
        {
          stateContext: context,
          stateDatabasePath: context.admission.databasePath,
          assertCurrent,
          createAdmission: admission(source, undefined, assertCallerCurrent),
          onNativeStopped: (stopped) => {
            nativeStopped = stopped;
          },
        },
      );
      if (!store) {
        return undefined;
      }
      openedStore = store;
      try {
        assertCurrent();
        return store;
      } catch (error) {
        try {
          await store.close();
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Agent open and cleanup failed", {
            cause: cleanupError,
          });
        }
        throw error;
      }
    })().catch((error: unknown) => {
      openingFailed = true;
      throw error;
    });
    const attempt = opening;
    return attempt.then((store) => {
      if (!store && opening === attempt) {
        opening = undefined;
      }
      return store;
    });
  };
  async function runExisting<T>(
    source: AgentDatabaseRequestExecutionSource,
    operation: (scope: AgentDatabaseExecutionScope) => Promise<T>,
    assertCallerCurrent?: () => void,
  ): Promise<T | undefined> {
    const store = await open(source, assertCallerCurrent);
    assertCurrent();
    assertCallerCurrent?.();
    source.assertCurrent();
    if (!store) {
      return undefined;
    }
    if (!nativeIdentity) {
      const registration = captureOpenClawAgentDatabaseRegistration({
        agentId,
        agentPath: pathname,
        admission: context.admission,
      });
      await settleAgentRegistration(
        registration,
        async () => {
          await runSqliteWorkerStoreOperation(
            store,
            (scope) => scope.execute({ type: "database.prepareWrite", input: undefined }),
            context,
            assertCurrent,
            admission(source, registration, assertCallerCurrent),
          );
          assertCurrent();
          source.assertCurrent();
        },
        (operationSucceeded) => registrationSettlements.get(registration)?.(operationSucceeded),
      );
      registrationSettlements.delete(registration);
      if (quickCheckPending) {
        quickCheckPending = false;
        requestOpenClawAgentDatabaseQuickCheck({ path: pathname, env: input.environment });
      }
    }
    return runSqliteWorkerStoreOperation(
      store,
      operation,
      context,
      assertCurrent,
      admission(source, undefined, assertCallerCurrent),
    );
  }
  return {
    failed: () =>
      openingFailed || Boolean(openedStore && !isSqliteWorkerStoreAvailable(openedStore)),
    runExisting: (source, operation, assertCallerCurrent) =>
      runExisting(source, operation, assertCallerCurrent),
    close() {
      retiring = true;
      closing ??= (async () => {
        const errors: unknown[] = [];
        if (opening) {
          try {
            await opening.then(
              (store) => store?.close(),
              () => closeUnclaimedSharedStateSqliteWorkers(pathname),
            );
          } catch (error) {
            errors.push(error);
          }
        }
        if (nativeStopped && lease) {
          try {
            await cleanupRetiredAgentDatabaseLease({
              context,
              stopped: nativeStopped,
              assertOwned: assertCleanupOwned,
              lease,
            });
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length === 1) {
          throw errors[0];
        }
        if (errors.length > 1) {
          throw new AggregateError(errors, "Agent native close and lease cleanup failed", {
            cause: errors[0],
          });
        }
      })().catch((error: unknown) => {
        closing = undefined;
        throw error;
      });
      return closing;
    },
  };
}
