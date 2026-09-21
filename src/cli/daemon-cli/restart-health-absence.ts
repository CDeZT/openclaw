// Native-absence eligibility for diagnostics, preserving observed startup grace.
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import type { readGatewayOwnerLease } from "../../infra/gateway-owner-lease.js";
import { hasActiveStartupMigrationLease } from "../../infra/startup-migration-checkpoint.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";

export function createNativeServiceAbsenceCheck(params: {
  env?: NodeJS.ProcessEnv;
  isServiceAbsent?: (runtime: GatewayServiceRuntime) => boolean;
  supervisorKeepsAlive?: boolean;
  isStartupMigrationActive?: typeof hasActiveStartupMigrationLease;
}) {
  let blocked = false;
  return (
    runtime: GatewayServiceRuntime,
    stoppedFree: boolean,
    owner: ReturnType<typeof readGatewayOwnerLease>,
  ): "absent" | "blocked" | undefined => {
    if (
      blocked ||
      !params.isServiceAbsent?.(runtime) ||
      !stoppedFree ||
      (owner && owner.state !== "dead") ||
      params.supervisorKeepsAlive
    ) {
      return undefined;
    }
    // Pre-action migrations precede Gateway ownership. Once observed or uncertain,
    // keep ordinary startup grace even after the migration lease is released.
    try {
      blocked = (params.isStartupMigrationActive ?? hasActiveStartupMigrationLease)({
        env: params.env,
      });
    } catch (error) {
      if (hasCommandProcessCleanupError(error)) {
        throw error;
      }
      blocked = true;
    }
    return blocked ? "blocked" : "absent";
  };
}
