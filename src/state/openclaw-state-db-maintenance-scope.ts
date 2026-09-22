import { AsyncLocalStorage } from "node:async_hooks";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-coordinator.js";
import type { tryCreateGatewaySchemaFenceDelegate } from "../infra/state-database-coordinator.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type MaintenanceResource = {
  phase:
    | "agent-resources"
    | "agent-handles"
    | "shared-resources"
    | "shared-references"
    | "shared-handles";
  close: () => void | Promise<void>;
};
type SchemaDelegateFactory = (
  params: Parameters<typeof tryCreateGatewaySchemaFenceDelegate>[0],
) => ReturnType<typeof tryCreateGatewaySchemaFenceDelegate>;

type AgentSchemaMigration = {
  agentId: string;
  path: string;
  foundVersion: number;
  supportedVersion: number;
};

export type OpenClawDatabaseMaintenanceScope = {
  readonly ownsSchemaMaintenance: boolean;
  assertOwnerCurrent(): void;
  assertAdmission(): void;
  addAgentSchemaMigrationCheck(check: (migration: AgentSchemaMigration) => void): void;
  assertAgentSchemaMigration(migration: AgentSchemaMigration): void;
  run<T>(operation: () => T): T;
  track<T>(operation: Promise<T>): Promise<T>;
  own(
    resource: object,
    phase: MaintenanceResource["phase"],
    close: MaintenanceResource["close"],
  ): void;
  close(): Promise<void>;
  createSchemaFenceDelegate: SchemaDelegateFactory;
};

const maintenanceResources = resolveGlobalSingleton(
  Symbol.for("openclaw.databaseMaintenanceResources"),
  () => ({
    current: new AsyncLocalStorage<{ scope: OpenClawDatabaseMaintenanceScope; active: boolean }>(),
    claims: new WeakMap<
      object,
      MaintenanceResource & { scope: OpenClawDatabaseMaintenanceScope; release: () => void }
    >(),
    parents: new WeakMap<OpenClawDatabaseMaintenanceScope, OpenClawDatabaseMaintenanceScope>(),
  }),
);

export function getOpenClawDatabaseMaintenanceScope():
  | OpenClawDatabaseMaintenanceScope
  | undefined {
  return maintenanceResources.current.getStore()?.scope;
}

/** Delayed work acquires its own resources instead of inheriting the completed scope. */
export function runOutsideOpenClawDatabaseMaintenanceScope<T>(operation: () => T): T {
  return maintenanceResources.current.exit(operation);
}

export function isOpenClawDatabaseMaintenanceResourceOwned(
  resource: object,
  scope: OpenClawDatabaseMaintenanceScope,
): boolean {
  return maintenanceResources.claims.get(resource)?.scope === scope;
}

/** A cached handle used by an independent caller remains with the ordinary cache owner. */
export function observeOpenClawDatabaseMaintenanceResource(resource: object | undefined): void {
  if (!resource) {
    return;
  }
  const claim = maintenanceResources.claims.get(resource);
  const current = getOpenClawDatabaseMaintenanceScope();
  if (!claim) {
    return;
  }
  const owner = commonMaintenanceAncestor(claim.scope, current);
  if (owner === claim.scope) {
    return;
  }
  claim.release();
  maintenanceResources.claims.delete(resource);
  if (owner) {
    owner.own(resource, claim.phase, claim.close);
  }
}

function commonMaintenanceAncestor(
  owner: OpenClawDatabaseMaintenanceScope,
  scope: OpenClawDatabaseMaintenanceScope | undefined,
): OpenClawDatabaseMaintenanceScope | undefined {
  const ancestors = new Set<OpenClawDatabaseMaintenanceScope>();
  for (
    let current: OpenClawDatabaseMaintenanceScope | undefined = owner;
    current;
    current = maintenanceResources.parents.get(current)
  ) {
    ancestors.add(current);
  }
  for (let current = scope; current; current = maintenanceResources.parents.get(current)) {
    if (ancestors.has(current)) {
      return current;
    }
  }
  return undefined;
}

/** Associate lexical database work with exact resources, never all files beneath a root. */
export function createOpenClawDatabaseMaintenanceScope(
  createSchemaFenceDelegate?: SchemaDelegateFactory,
  assertOwnerCurrent?: () => void,
): OpenClawDatabaseMaintenanceScope {
  const parent = getOpenClawDatabaseMaintenanceScope();
  const schemaDelegateFactory =
    createSchemaFenceDelegate ??
    (parent?.ownsSchemaMaintenance ? parent.createSchemaFenceDelegate : undefined);
  const pending = new Set<Promise<unknown>>();
  const schemaMigrationChecks = new Set<(migration: AgentSchemaMigration) => void>();
  const resources = new Map<object, MaintenanceResource>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const assertOpen = () => {
    if (closed) {
      throw new Error("Database maintenance resource scope is closed");
    }
  };
  const scope: OpenClawDatabaseMaintenanceScope = {
    ownsSchemaMaintenance: schemaDelegateFactory !== undefined,
    assertOwnerCurrent() {
      parent?.assertOwnerCurrent();
      assertOwnerCurrent?.();
    },
    assertAdmission() {
      assertOpen();
      scope.assertOwnerCurrent();
      const inherited = maintenanceResources.current.getStore();
      if (closing && !(inherited?.scope === scope && inherited.active)) {
        throw new Error("Database maintenance resource admission is closed");
      }
    },
    addAgentSchemaMigrationCheck(check) {
      scope.assertAdmission();
      schemaMigrationChecks.add(check);
    },
    assertAgentSchemaMigration(migration) {
      assertOpen();
      scope.assertOwnerCurrent();
      parent?.assertAgentSchemaMigration(migration);
      for (const check of schemaMigrationChecks) {
        check(migration);
      }
    },
    run(operation) {
      scope.assertAdmission();
      const accepted = { scope, active: true };
      try {
        const result = maintenanceResources.current.run(accepted, operation);
        if (result instanceof Promise) {
          const settled = () => {
            accepted.active = false;
          };
          void result.then(settled, settled);
          void scope.track(result);
        } else {
          accepted.active = false;
        }
        return result;
      } catch (error) {
        accepted.active = false;
        throw error;
      }
    },
    track(operation) {
      assertOpen();
      pending.add(operation);
      const settled = () => pending.delete(operation);
      void operation.then(settled, settled);
      return operation;
    },
    own(resource, phase, close) {
      assertOpen();
      resources.set(resource, { phase, close });
      maintenanceResources.claims.set(resource, {
        scope,
        phase,
        close,
        release: () => resources.delete(resource),
      });
    },
    createSchemaFenceDelegate(params) {
      assertOpen();
      return schemaDelegateFactory?.(params);
    },
    close() {
      return (closing ??= maintenanceResources.current
        .run({ scope, active: true }, async () => {
          while (pending.size || resources.size) {
            while (pending.size) {
              await Promise.allSettled(pending);
            }
            // Agent lease release can create shared-state handles during cleanup.
            for (const phase of [
              "agent-resources",
              "agent-handles",
              "shared-resources",
              "shared-references",
              "shared-handles",
            ] as const) {
              while ([...resources.values()].some((resource) => resource.phase === phase)) {
                // Earlier cleanup can start tracked work using resources in this batch.
                while (pending.size) {
                  await Promise.allSettled(pending);
                }
                const batch = [...resources].filter(([, resource]) => resource.phase === phase);
                const results = await Promise.allSettled(
                  batch.map(async ([key, resource]) => {
                    await resource.close();
                    resources.delete(key);
                    maintenanceResources.claims.delete(key);
                  }),
                );
                const errors = results.flatMap((result) =>
                  result.status === "rejected" ? [result.reason] : [],
                );
                if (errors.length === 1) {
                  throw errors[0];
                }
                if (errors.length > 1) {
                  throw createSqliteLifecycleAggregateError(
                    errors,
                    "Maintenance resource cleanup failed",
                    errors[0],
                  );
                }
              }
            }
          }
          schemaMigrationChecks.clear();
          closed = true;
        })
        .catch((error: unknown) => {
          closing = undefined;
          throw error;
        }));
    },
  };
  if (parent) {
    maintenanceResources.parents.set(scope, parent);
  }
  return scope;
}
