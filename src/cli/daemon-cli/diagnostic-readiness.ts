import { resolveConfigPath, resolveGatewayPort, resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { mergeGatewayServiceEnv } from "../../daemon/service-env-merge.js";
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import type { GatewayServiceCommandConfig } from "../../daemon/service-types.js";
import { readGatewayServiceState, resolveGatewayService } from "../../daemon/service.js";
import { isImplicitLocalGatewayTarget } from "../../gateway/call.js";
import { resolveGatewayProbeAuthSafeWithSecretInputs } from "../../gateway/probe-auth.js";
import { readGatewayOwnerLease } from "../../infra/gateway-owner-lease.js";
import { LOOPBACK_PORT_PROBE_HOSTS } from "../../infra/ports-probe.js";
import { parseTcpPortFromArgs } from "../../infra/tcp-port.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { resolveGatewayRestartProbeContext } from "./restart-health-probe.js";
import { DEFAULT_RESTART_HEALTH_TIMEOUT_MS } from "./restart-health.constants.js";
import { waitForGatewayHealthyRestart, type GatewayRestartSnapshot } from "./restart-health.js";

/** Returns undefined when the original diagnostic path owns target or authentication handling. */
export async function waitForGatewayDiagnosticReadiness(opts: {
  config?: OpenClawConfig;
  timeoutMs?: number;
  deadlineMs?: number;
  url?: string;
  token?: string;
  password?: string;
  ignoreEnvUrlOverride?: boolean;
  localPortOverride?: number;
  onProgress?: (phase: string) => void;
}): Promise<GatewayRestartSnapshot | undefined> {
  if (!(await isImplicitLocalGatewayTarget(opts))) {
    return undefined;
  }
  const probeContext = opts.config
    ? {
        config: opts.config,
        auth: (
          await resolveGatewayProbeAuthSafeWithSecretInputs({
            cfg: opts.config,
            mode: "local",
            explicitAuth: { token: opts.token, password: opts.password },
          })
        ).auth,
      }
    : await resolveGatewayRestartProbeContext(process.env, {
        token: opts.token,
        password: opts.password,
      });
  if (
    !probeContext.auth?.token &&
    !probeContext.auth?.password &&
    probeContext.config.gateway?.auth?.mode !== "none"
  ) {
    return undefined;
  }
  const port = opts.localPortOverride ?? resolveGatewayPort(probeContext.config);
  const nativeService = resolveGatewayService();
  let nativeCommand: Promise<GatewayServiceCommandConfig | null> | undefined;
  let runtimeObservation: { absentRuntime?: GatewayServiceRuntime } = {};
  return waitForGatewayHealthyRestart({
    port,
    timeoutMs: opts.timeoutMs ?? DEFAULT_RESTART_HEALTH_TIMEOUT_MS,
    deadlineMs: opts.deadlineMs,
    probeContext,
    probeHosts: LOOPBACK_PORT_PROBE_HOSTS,
    requirePluginHealth: false,
    isServiceAbsent: (runtime) => runtimeObservation.absentRuntime === runtime,
    onProgress: opts.onProgress,
    service: {
      readCommand: async () => null,
      readRuntime: async (env, options) => {
        // Reset before every read. Late completion can only mark its own observation.
        const observation: typeof runtimeObservation = {};
        runtimeObservation = observation;
        const owner = readGatewayOwnerLease({ env, port });
        if (
          owner?.state === "live" &&
          (owner.mode === "foreground" || owner.supervisor?.kind === "external")
        ) {
          return { status: "running", pid: owner.pid };
        }
        const startedAt = performance.now();
        const command = await (nativeCommand ??= nativeService
          .readCommand(env, options)
          .catch((error: unknown) => {
            if (hasCommandProcessCleanupError(error)) {
              throw error;
            }
            return null;
          }));
        const remainingTimeoutMs =
          options?.timeoutMs === undefined
            ? undefined
            : options.timeoutMs - (performance.now() - startedAt);
        if (remainingTimeoutMs !== undefined && remainingTimeoutMs <= 0) {
          return { status: "unknown", detail: "Service inspection deadline expired." };
        }
        const runtimeOptions = {
          ...options,
          ...(remainingTimeoutMs === undefined ? {} : { timeoutMs: remainingTimeoutMs }),
        };
        if (!command) {
          // A null best-effort command can also mean failed inspection. Let the
          // native service owner prove absence without loading a missing unit.
          const state = await readGatewayServiceState(nativeService, {
            env,
            ...runtimeOptions,
            requireEffective: true,
            requireLoadedCommand: true,
          });
          if (
            !state.installed &&
            state.command === null &&
            state.loadState.status === "not-loaded" &&
            state.runtime?.status === "stopped" &&
            state.runtime.missingUnit === true
          ) {
            observation.absentRuntime = state.runtime;
            return state.runtime;
          }
          return { status: "unknown" };
        }
        const serviceEnv = mergeGatewayServiceEnv(env, command);
        const servicePort =
          parseTcpPortFromArgs(command?.programArguments) ??
          resolveGatewayPort(probeContext.config, serviceEnv);
        if (
          servicePort !== port ||
          resolveStateDir(serviceEnv) !== resolveStateDir(env) ||
          resolveConfigPath(serviceEnv) !== resolveConfigPath(env)
        ) {
          return { status: "unknown" };
        }
        return nativeService.readRuntime(env, runtimeOptions);
      },
    },
  });
}
