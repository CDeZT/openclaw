// Runs post-plugin convergence checks without retaining pre-update plugin modules.
import os from "node:os";
import path from "node:path";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV,
  UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV,
  UPDATE_POST_CORE_CONVERGENCE_ENV,
} from "../../commands/doctor/shared/update-phase.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { resolveConfigPath, resolveStateDir } from "../../config/paths.js";
import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import { resolveGatewayInstallEntrypoint } from "../../daemon/gateway-entrypoint.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveAggregateSqliteInspectionTimeoutMs } from "../../infra/sqlite-readonly-worker.js";
import { collectStateDatabasePaths } from "../../infra/update-candidate-state.js";
import { readUpdateStateDatabaseSizes } from "../../infra/update-candidate-state.sizes.js";
import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import { hasDeferredUpdateModelRetirement } from "../../infra/update-deferred-model-retirement.js";
import {
  consumeUpdatePostInstallDoctorResult,
  createUpdatePostInstallDoctorResultPath,
  UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  UpdateDoctorError,
  type UpdatePostInstallDoctorResult,
} from "../../infra/update-doctor-result.js";
import {
  createUpdateFailureFact,
  normalizeUpdateFailureFacts,
  parseConfigFailureFacts,
  type UpdateFailureFact,
} from "../../infra/update-failure-facts.js";
import { POST_CORE_UPDATE_ENV } from "../../infra/update-post-core-context.js";
import { UpdateRequesterRevokedError } from "../../infra/update-requester-authority.js";
import { buildUpdateDoctorEnv } from "../../infra/update-runner-doctor.js";
import { redactSupportString } from "../../logging/diagnostic-support-redaction.js";
import { formatCommandOutput } from "../../process/command-error.js";
import {
  createSanitizedCommandError,
  hasCommandProcessCleanupError,
} from "../../process/exec-result.js";
import { isPlainCommandExitFailure, runExec, type RunExecOptions } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { truncateUtf8Prefix, truncateUtf8Suffix } from "../../utils/utf8-truncate.js";
import { parseUpdateTimeoutMs, resolveNodeRunner, type UpdateCommandOptions } from "./shared.js";
import { createUpdateCommandAuthority } from "./update-command-authority.js";
import { readUpdateConfigSnapshot } from "./update-command-config-snapshot.js";
import {
  assertUpdateDoctorChildSucceeded,
  inspectUpdateDoctorChildSupport,
  withUpdateDoctorChild,
} from "./update-command-doctor-child.js";
import type { PostCorePluginUpdateResult } from "./update-command-plugins.js";
import { applyPostPluginUpdateReadiness } from "./update-command-post-plugin-readiness.js";
import {
  applyPostPluginConfigValidation,
  POST_PLUGIN_DOCTOR_EXECUTION_FAILED_REASON,
  POST_PLUGIN_CONFIG_VALIDATION_EXECUTION_FAILED_REASON,
  type PostPluginConfigValidation,
} from "./update-command-post-plugin-validation.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import {
  disableUpdatedPackageCompileCacheEnv,
  stripGatewayServiceMarkerEnv,
} from "./update-command-service-env.js";
import { captureUpdateFinalizationDoctorOutput } from "./update-finalization-output.js";

type UpdateDoctorPhase = "pre-plugin" | "post-plugin";

export async function withPrePluginUpdateDoctorEnv<T>(run: () => Promise<T>): Promise<T> {
  const previousValues = [
    "OPENCLAW_UPDATE_IN_PROGRESS",
    UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV,
    UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV,
    UPDATE_POST_CORE_CONVERGENCE_ENV,
  ].map((key) => [key, process.env[key]] as const);
  process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
  process.env[UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV] = "1";
  process.env[UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV] = "1";
  delete process.env[UPDATE_POST_CORE_CONVERGENCE_ENV];
  try {
    return await run();
  } finally {
    for (const [key, value] of previousValues) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function withNormalConfigValidation<T>(run: () => Promise<T>): Promise<T> {
  const previousUpdateInProgress = process.env.OPENCLAW_UPDATE_IN_PROGRESS;
  process.env.OPENCLAW_UPDATE_IN_PROGRESS = "0";
  try {
    return await run();
  } finally {
    if (previousUpdateInProgress === undefined) {
      delete process.env.OPENCLAW_UPDATE_IN_PROGRESS;
    } else {
      process.env.OPENCLAW_UPDATE_IN_PROGRESS = previousUpdateInProgress;
    }
  }
}

function createPostPluginDoctorExecutionFailure(
  pluginUpdate: PostCorePluginUpdateResult,
  reason: string,
  failureFacts?: UpdateFailureFact[],
): PostCorePluginUpdateResult {
  return {
    ...pluginUpdate,
    status: "error",
    reason: POST_PLUGIN_DOCTOR_EXECUTION_FAILED_REASON,
    ...(failureFacts?.length ? { failureFacts } : {}),
    warnings: [
      ...(pluginUpdate.warnings ?? []),
      {
        reason,
        message: "Updated plugin migrations could not be run in a fresh process.",
        guidance: ["Run `openclaw update repair` to retry post-update plugin repair."],
      },
    ],
  };
}

export async function runUpdateFinalizationDoctorInFreshProcess(params: {
  phase: UpdateDoctorPhase;
  root: string;
  runId?: string;
  opts?: UpdateCommandOptions;
  /** Only local candidate code may supply its known native Doctor contract. */
  doctorConfigWrites?: true;
  yes: boolean;
  json: boolean;
  workspaceSuggestions?: boolean;
  timeoutMs?: number;
  nodeRunner?: string;
  entryPath?: string;
  onWarnings?: (warnings: string[]) => void;
  assertCurrent?: () => void;
  /** Propagate a refused child authority to the finalization owner without retrying it. */
  onAuthorityRefused?: () => void;
}): Promise<void> {
  const {
    run,
    executorFence,
    runId,
    requester,
    assertCurrent,
    assertRequesterCurrent,
    refuseAuthority,
  } = createUpdateCommandAuthority(params, "Fresh Doctor");
  assertCurrent();
  const entryPath = params.entryPath ?? (await resolveGatewayInstallEntrypoint(params.root));
  if (!entryPath) {
    throw new Error("Updated OpenClaw entrypoint not found for post-plugin doctor");
  }
  assertCurrent();
  const args = [
    entryPath,
    "doctor",
    "--repair",
    "--non-interactive",
    ...(params.workspaceSuggestions ? [] : ["--no-workspace-suggestions"]),
    ...(params.yes ? ["--yes"] : []),
  ];
  const baseEnv = stripGatewayServiceMarkerEnv(disableUpdatedPackageCompileCacheEnv(process.env));
  delete baseEnv[UPDATE_POST_CORE_CONVERGENCE_ENV];
  const doctorResultPath = createUpdatePostInstallDoctorResultPath();
  let doctorResult: UpdatePostInstallDoctorResult | null = null;
  let result: { stdout?: unknown; stderr?: unknown } | undefined;
  assertCurrent();
  try {
    const commandOptions: RunExecOptions = {
      cwd: params.root,
      // Normal updates also carry a default step allowance. Only operator opts
      // may impose a Doctor deadline; standalone finalization supplies its own.
      timeoutMs: params.opts ? parseUpdateTimeoutMs(params.opts.timeout) : params.timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      logOutput: false,
      onOutputChunk: captureUpdateFinalizationDoctorOutput(params.phase),
      baseEnv,
      env: {
        [UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]: doctorResultPath,
        ...((runId ?? params.runId) ? { [UPDATE_RUN_ID_ENV]: runId ?? params.runId } : {}),
        // The outer updater owns service refresh and activation after every
        // migration finishes; a fresh Doctor must not resume its parked service.
        ...buildUpdateDoctorEnv({
          allowGatewayServiceRepair: false,
          allowGatewayActivation: false,
          serviceRepairPolicy: "external",
          deferConfiguredPluginInstallRepair: true,
        }),
        ...(params.phase === "post-plugin" ? { [UPDATE_POST_CORE_CONVERGENCE_ENV]: "1" } : {}),
      },
    };
    const workerCommand = [
      params.nodeRunner ?? resolveNodeRunner(),
      path.join(
        params.root,
        "dist",
        runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath,
      ),
    ];
    const doctorConfigWrites =
      run &&
      (params.doctorConfigWrites ??
        (await inspectUpdateDoctorChildSupport(
          workerCommand,
          {
            cwd: params.root,
            timeoutMs: params.timeoutMs,
            baseEnv,
            env: commandOptions.env,
          },
          assertCurrent,
        )));
    assertCurrent();
    if (doctorConfigWrites && executorFence && runId) {
      const snapshot = await readUpdateConfigSnapshot(resolveConfigPath());
      assertCurrent();
      const child = await withUpdateDoctorChild(
        {
          root: params.root,
          context: {
            runId,
            executorFence,
            requester: requester?.requester,
            assertRequesterCurrent,
          },
          input: {
            configInputHash: snapshot.hash,
            repair: true,
            yes: params.yes,
            workspaceSuggestions: params.workspaceSuggestions === true,
            ...(params.phase === "post-plugin" && process.env[POST_CORE_UPDATE_ENV] === "1"
              ? { postCoreSchemaRepair: true as const }
              : {}),
          },
        },
        (runCommand) =>
          runCommand([...workerCommand, "--doctor"], {
            ...commandOptions,
            maxOutputBytes: commandOptions.maxBuffer,
            terminateOnOutputLimit: true,
          }),
      );
      result = child;
      assertUpdateDoctorChildSucceeded(child);
      assertCurrent();
    } else {
      // A valid legacy target contract retains its shipped CLI Doctor. This is
      // capability selection, never recovery from missing or refused authority.
      result = await runExec(params.nodeRunner ?? resolveNodeRunner(), args, commandOptions);
      assertCurrent();
    }
  } catch (error) {
    if (
      collectNestedErrorCandidates(error).some(
        (cause) =>
          cause instanceof UpdateCommandRecoveryPendingError ||
          cause instanceof UpdateRequesterRevokedError,
      )
    ) {
      refuseAuthority(error);
    }
    assertCurrent();
    doctorResult = await consumeUpdatePostInstallDoctorResult(doctorResultPath);
    if (
      doctorResult?.configWriteRefusal?.reason === "authority-check-failed" ||
      doctorResult?.configWriteRefusal?.reason === "requester-revoked"
    ) {
      refuseAuthority(error);
    }
    if (isRecord(error)) {
      result = error;
      // Enabling the existing result channel gives deferred plugin repair its
      // advisory exit code. Convergence below still owns that repair.
      if (
        error.exitCode === UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE &&
        isPlainCommandExitFailure({
          ...error,
          failed: error.failed === true,
          cause: error.cause,
        }) &&
        doctorResult?.status === "advisory"
      ) {
        return;
      }
    }
    const exitCode = isRecord(error) && typeof error.exitCode === "number" ? error.exitCode : null;
    const redaction = { env: process.env, stateDir: resolveStateDir() };
    const failureFacts = doctorResult?.failureFacts?.length
      ? doctorResult.failureFacts
      : [
          createUpdateFailureFact({
            check: "doctor",
            code: "doctor-failed",
            message:
              typeof result?.stderr === "string" && result.stderr.trim()
                ? result.stderr
                : error instanceof Error
                  ? error.message
                  : String(error),
          }),
        ];
    const details = (["stderr", "stdout"] as const).flatMap((stream) => {
      const output = result?.[stream];
      if (typeof output !== "string" || !output.trim()) {
        return [];
      }
      // Execa's message starts with full argv. Keep both actual diagnostics before
      // the bounded update handoff, without cutting a credential before redaction.
      const redacted = redactSupportString(output, redaction, {
        maxLength: Number.MAX_SAFE_INTEGER,
      });
      const formatted = formatCommandOutput(redacted, 384);
      let excerpt = formatted;
      if (Buffer.byteLength(redacted) > 384 || Buffer.byteLength(formatted) > 384) {
        const beginning = formatCommandOutput(truncateUtf8Prefix(redacted, 256), 256);
        excerpt = `${truncateUtf8Prefix(beginning, 256)}\n...\n${truncateUtf8Suffix(formatted, 123)}`;
      }
      return excerpt ? [`${stream}: ${excerpt}`] : [];
    });
    if (details.length > 0) {
      throw new UpdateDoctorError(
        `Updated ${params.phase} Doctor failed:\n${details.join("\n")}`,
        failureFacts,
        { cause: error, exitCode },
      );
    }
    throw new UpdateDoctorError(
      error instanceof Error ? error.message : String(error),
      failureFacts,
      { cause: error, exitCode },
    );
  } finally {
    doctorResult ??= await consumeUpdatePostInstallDoctorResult(doctorResultPath);
    if (doctorResult?.warnings?.length) {
      params.onWarnings?.(doctorResult.warnings);
    }
    // Clack writes directly to the child's stdout. Preserve diagnostics on either
    // exit path without letting them share the parent's JSON result stream.
    if (typeof result?.stdout === "string" && result.stdout.trim()) {
      defaultRuntime[params.json ? "error" : "log"](result.stdout.trimEnd());
    }
    if (typeof result?.stderr === "string" && result.stderr.trim()) {
      defaultRuntime.error(result.stderr.trimEnd());
    }
  }
}

async function validatePostPluginConfigInFreshProcess(params: {
  root: string;
  timeoutMs: number;
  entryPath: string;
  nodeRunner?: string;
}): Promise<PostPluginConfigValidation> {
  try {
    await runExec(
      params.nodeRunner ?? resolveNodeRunner(),
      [params.entryPath, "config", "validate", "--json"],
      {
        cwd: params.root,
        timeoutMs: params.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        logOutput: false,
        baseEnv: stripGatewayServiceMarkerEnv(disableUpdatedPackageCompileCacheEnv(process.env)),
        env: { OPENCLAW_UPDATE_IN_PROGRESS: "0" },
      },
    );
    return { status: "valid" };
  } catch (error) {
    const result = isRecord(error) ? error : {};
    // Temporary FreeBSD diagnostic relay. Reconstruct one closed record; never
    // forward arbitrary child stderr or change the original validation outcome.
    try {
      const marker = "OPENCLAW_FREEBSD_TEMP_DIAGNOSTIC_V1 ";
      if (process.platform === "freebsd" && typeof result.stderr === "string") {
        const start = result.stderr.indexOf(marker);
        const end = result.stderr.indexOf("\n", start);
        if (start >= 0 && (start === 0 || result.stderr[start - 1] === "\n") && end >= 0) {
          const line = result.stderr.slice(start, end + 1);
          if (Buffer.byteLength(line) > 8192)
            throw new Error("Diagnostic record exceeds its bound");
          const object = (value: unknown, keys: string[]): Record<string, unknown> => {
            if (
              !isRecord(value) ||
              Object.keys(value).length !== keys.length ||
              keys.some((key) => !Object.hasOwn(value, key))
            )
              throw new Error("Invalid diagnostic fields");
            return value;
          };
          const choice = (value: unknown, values: readonly string[]): string => {
            if (typeof value !== "string" || !values.includes(value))
              throw new Error("Invalid diagnostic label");
            return value;
          };
          const boolean = (value: unknown): boolean => {
            if (typeof value !== "boolean") throw new Error("Invalid diagnostic boolean");
            return value;
          };
          const integer = (value: unknown, signed = false): number | null => {
            if (value === null) return null;
            if (
              typeof value !== "number" ||
              !Number.isSafeInteger(value) ||
              value < (signed ? -0x80000000 : 0) ||
              value > (signed ? 0x7fffffff : 0xffffffff)
            )
              throw new Error("Invalid diagnostic integer");
            return value;
          };
          const decimal = (
            value: unknown,
            min = -0x8000000000000000n,
            max = 0x7fffffffffffffffn,
          ): string | null => {
            if (value === null) return null;
            if (
              typeof value !== "string" ||
              !/^(?:0|-?[1-9][0-9]{0,18})$/u.test(value) ||
              BigInt(value) < min ||
              BigInt(value) > max
            )
              throw new Error("Invalid diagnostic metadata");
            return value;
          };
          const array = (value: unknown, max: number): unknown[] => {
            if (!Array.isArray(value) || value.length > max)
              throw new Error("Invalid diagnostic array");
            return value;
          };
          const roleValues = [
            "logging-preferred",
            "logging-fallback",
            "sqlite-cache-preferred",
            "sqlite-cache-fallback",
          ];
          const roles = (value: unknown) => {
            const selected = array(value, 4).map((role) => choice(role, roleValues));
            if (new Set(selected).size !== selected.length)
              throw new Error("Duplicate diagnostic role");
            return selected;
          };
          const codes = [
            "EACCES",
            "EPERM",
            "ENOENT",
            "EEXIST",
            "ENOTDIR",
            "EISDIR",
            "ELOOP",
            "EMLINK",
            "EINVAL",
            "EBADF",
            "EIO",
            "EROFS",
            "ENOSPC",
            "EDQUOT",
            "EMFILE",
            "ENFILE",
            "ENAMETOOLONG",
            "ENOSYS",
            "ENOTSUP",
            "ECANCELED",
            "EFTYPE",
            "EOPNOTSUPP",
            "ESTALE",
            "ENXIO",
            "ENODEV",
            "EFAULT",
            "EINTR",
            "EOVERFLOW",
            "ERANGE",
            "UNKNOWN",
          ];
          const syscalls = [
            "lstat",
            "stat",
            "open",
            "fstat",
            "fchmod",
            "close",
            "access",
            "mkdir",
            "UNKNOWN",
          ];
          const fields = (value: Record<string, unknown>) => ({
            code: value.code === null ? null : choice(value.code, codes),
            syscall: value.syscall === null ? null : choice(value.syscall, syscalls),
            errno: integer(value.errno, true),
          });
          const input = object(JSON.parse(line.slice(marker.length)), [
            "v",
            "origin",
            "timing",
            "pid",
            "ppid",
            "uid",
            "euid",
            "selection",
            "selectedRoles",
            "causes",
            "causeTruncated",
            "causeCycle",
            "paths",
          ]);
          if (
            input.v !== 1 ||
            input.origin !== "config-snapshot" ||
            input.timing !== "post-failure"
          )
            throw new Error("Invalid diagnostic origin");
          const selectedRoles = roles(input.selectedRoles);
          const selection = choice(input.selection, ["exact", "ambiguous", "unknown"]);
          if (
            selection !==
              (selectedRoles.length === 0
                ? "unknown"
                : selectedRoles.length === 1
                  ? "exact"
                  : "ambiguous") ||
            selectedRoles.some((role) => !role.endsWith("-fallback"))
          )
            throw new Error("Invalid diagnostic selection");
          const causes = array(input.causes, 8).map((value, id) => {
            const cause = object(value, [
              "id",
              "parent",
              "via",
              "kind",
              "operation",
              "code",
              "syscall",
              "errno",
            ]);
            const parent = integer(cause.parent);
            const via = choice(cause.via, ["root", "cause", "aggregate"]);
            if (
              cause.id !== id ||
              (id === 0
                ? parent !== null || via !== "root"
                : parent === null || parent >= id || via === "root")
            )
              throw new Error("Invalid diagnostic cause graph");
            return {
              id,
              parent,
              via,
              kind: choice(cause.kind, ["Error", "AggregateError", "other"]),
              operation: choice(cause.operation, [
                "fallback-admission",
                "descriptor-unavailable",
                "identity-owner-type",
                "identity-changed",
                "descriptor-invalid",
                "permissions-unsafe",
                "chmod-verification",
                "repair-close",
                "native-syscall",
                "unknown",
              ]),
              ...fields(cause),
            };
          });
          if (causes.length === 0 || causes[0]!.operation !== "fallback-admission")
            throw new Error("Missing diagnostic failure");
          const pathRoles = new Set<string>();
          const paths = array(input.paths, 4).map((value) => {
            const observation = object(value, ["roles", "lstat", "access"]);
            const aliases = roles(observation.roles);
            if (
              aliases.length === 0 ||
              aliases.some(
                (role) =>
                  pathRoles.has(role) ||
                  !selectedRoles.some(
                    (selected) =>
                      selected.replace(/-fallback$/u, "") ===
                      role.replace(/-(?:preferred|fallback)$/u, ""),
                  ),
              )
            )
              throw new Error("Invalid diagnostic path roles");
            for (const role of aliases) pathRoles.add(role);
            const stat = object(observation.lstat, [
              "status",
              "uid",
              "mode",
              "dev",
              "ino",
              "metadataUnknown",
              "isDirectory",
              "isSymbolicLink",
              "code",
              "syscall",
              "errno",
            ]);
            const status = choice(stat.status, ["ok", "error"]);
            const metadata = {
              uid: decimal(stat.uid, 0n, 0xffffffffn),
              mode: decimal(stat.mode, 0n, 0xffffffffn),
              dev: decimal(stat.dev),
              ino: decimal(stat.ino),
            };
            const metadataUnknown = boolean(stat.metadataUnknown);
            if (metadataUnknown !== Object.values(metadata).some((item) => item === null))
              throw new Error("Invalid diagnostic metadata status");
            const isDirectory = stat.isDirectory === null ? null : boolean(stat.isDirectory);
            const isSymbolicLink =
              stat.isSymbolicLink === null ? null : boolean(stat.isSymbolicLink);
            const statFields = fields(stat);
            if (
              status === "ok"
                ? isDirectory === null ||
                  isSymbolicLink === null ||
                  Object.values(statFields).some((item) => item !== null)
                : Object.values(metadata).some((item) => item !== null) ||
                  isDirectory !== null ||
                  isSymbolicLink !== null
            )
              throw new Error("Invalid diagnostic stat result");
            const accessInput = object(observation.access, ["status", "code", "syscall", "errno"]);
            const accessStatus = choice(accessInput.status, ["ok", "error", "not-run"]);
            const accessFields = fields(accessInput);
            if (
              accessStatus !== "error" &&
              Object.values(accessFields).some((item) => item !== null)
            )
              throw new Error("Invalid diagnostic access result");
            if ((status !== "ok" || !isDirectory || isSymbolicLink) && accessStatus !== "not-run")
              throw new Error("Invalid diagnostic access admission");
            return {
              roles: aliases,
              lstat: {
                status,
                ...metadata,
                metadataUnknown,
                isDirectory,
                isSymbolicLink,
                ...statFields,
              },
              access: { status: accessStatus, ...accessFields },
            };
          });
          if (selection === "unknown" && paths.length !== 0)
            throw new Error("Unknown diagnostic path observation");
          const record = {
            v: 1,
            origin: "config-validator-relay",
            timing: "post-failure",
            pid: integer(input.pid),
            ppid: integer(input.ppid),
            uid: integer(input.uid),
            euid: integer(input.euid),
            selection,
            selectedRoles,
            causes,
            causeTruncated: boolean(input.causeTruncated),
            causeCycle: boolean(input.causeCycle),
            paths,
          };
          const output = `${marker}${JSON.stringify(record)}\n`;
          if (Buffer.byteLength(output) <= 8192)
            process.getBuiltinModule("node:fs").writeSync(2, output);
        }
      }
    } catch {
      /* Missing, truncated or invalid diagnostics cannot alter failure precedence. */
    }
    const cleanupUncertain = result.cleanup === "uncertain" || hasCommandProcessCleanupError(error);
    // The CLI also emits valid:false for runtime exceptions. Only an ordinary
    // completed failure with actual issues establishes invalid authored config.
    const issues =
      !cleanupUncertain &&
      isPlainCommandExitFailure({
        ...result,
        failed: result.failed === true,
        cause: result.cause,
      }) &&
      typeof result.stdout === "string"
        ? parseConfigFailureFacts(result.stdout, process.env)
        : [];
    if (issues.length) {
      return { status: "invalid", failureFacts: issues };
    }
    const summary = [
      createSanitizedCommandError(result).message,
      ...(typeof result.signal === "string" ? [`signal=${result.signal}`] : []),
      ...(cleanupUncertain ? ["cleanup=uncertain"] : []),
    ].join("; ");
    return {
      status: "execution-failed",
      failureFacts: normalizeUpdateFailureFacts([
        {
          check: "config",
          code: POST_PLUGIN_CONFIG_VALIDATION_EXECUTION_FAILED_REASON,
          message: summary,
        },
        ...(["stderr", "stdout"] as const).flatMap((stream) => {
          const output = result[stream];
          return typeof output === "string" && output.trim()
            ? [{ check: "config", code: "command-failed", message: `${stream}: ${output}` }]
            : [];
        }),
      ]),
    };
  }
}

export async function completePostCorePluginUpdate(params: {
  root: string;
  runId?: string;
  opts?: UpdateCommandOptions;
  doctorConfigWrites?: true;
  pluginUpdate: PostCorePluginUpdateResult;
  freshDoctorRequired: boolean;
  yes: boolean;
  json: boolean;
  timeoutMs?: number;
  nodeRunner?: string;
  beforeDoctor?: () => Promise<void>;
  onWarnings?: (warnings: string[]) => void;
  assertCurrent?: () => void;
}): Promise<{
  pluginUpdate: PostCorePluginUpdateResult;
  configSnapshot: ConfigFileSnapshot;
}> {
  // Preserve the first refused assertion; Doctor error handling cannot retry it.
  let authorityFailed = false;
  const assertCurrent = () => {
    try {
      params.assertCurrent?.();
    } catch (error) {
      authorityFailed = true;
      throw error;
    }
  };
  assertCurrent();
  let pluginUpdate = params.pluginUpdate;
  let entryPath: string | undefined;
  let freshConfigValidation: PostPluginConfigValidation | undefined;
  if (pluginUpdate.status !== "error") {
    try {
      entryPath = await resolveGatewayInstallEntrypoint(params.root);
      assertCurrent();
      if (!entryPath) {
        throw new Error("Updated OpenClaw entrypoint not found for post-plugin doctor");
      }
      if (params.freshDoctorRequired || hasDeferredUpdateModelRetirement()) {
        await params.beforeDoctor?.();
        await runUpdateFinalizationDoctorInFreshProcess({
          ...params,
          assertCurrent,
          onAuthorityRefused: () => {
            authorityFailed = true;
          },
          entryPath,
          phase: "post-plugin",
        });
      }
    } catch (err) {
      if (authorityFailed) {
        throw err;
      }
      // Lost updater authority must not become an advisory that starts more children.
      assertCurrent();
      pluginUpdate = createPostPluginDoctorExecutionFailure(
        params.pluginUpdate,
        String(err),
        err instanceof UpdateDoctorError ? err.failureFacts : undefined,
      );
    }
  }

  assertCurrent();
  // The target owns state writes and its version stamp. Read context without
  // migrating target stores or warning about this parent's expected version skew.
  const configSnapshot = await withNormalConfigValidation(() =>
    readConfigFileSnapshot({ observe: false, suppressFutureVersionWarning: true }),
  );
  assertCurrent();
  if (entryPath) {
    let checkTimeoutMs = params.timeoutMs;
    if (checkTimeoutMs === undefined) {
      // Doctor can grow shared and agent stores. Measure once after its writes settle.
      const env = { ...process.env };
      const databases = await collectStateDatabasePaths(
        { stateDir: resolveStateDir(env), config: configSnapshot.sourceConfig, env },
        { includeUnconfiguredAgents: false },
      );
      assertCurrent();
      checkTimeoutMs = resolveAggregateSqliteInspectionTimeoutMs(
        "post-plugin checks",
        await readUpdateStateDatabaseSizes(
          Array.from(databases.values(), (database) => database.spellings[0]),
          { nodeRunner: process.execPath, sourceEnv: env, stagingRoot: os.tmpdir() },
        ),
      );
    }
    assertCurrent();
    // No authored file is a valid unconfigured install, not an invalid config.
    // Existing files still need the target schema; every install needs readiness.
    freshConfigValidation =
      !configSnapshot.exists && configSnapshot.valid
        ? { status: "valid" }
        : await validatePostPluginConfigInFreshProcess({
            ...params,
            entryPath,
            timeoutMs: checkTimeoutMs,
          });
    assertCurrent();
    if (freshConfigValidation.status === "valid") {
      pluginUpdate = await applyPostPluginUpdateReadiness({
        root: params.root,
        entryPath,
        pluginUpdate,
        timeoutMs: checkTimeoutMs,
        ...(params.nodeRunner ? { nodeRunner: params.nodeRunner } : {}),
      });
    }
  }
  assertCurrent();
  // Strict validity belongs to the target runtime even when no plugin changed.
  // The parent may retain the previous schema; its snapshot is best-effort context.
  if (freshConfigValidation) {
    pluginUpdate = applyPostPluginConfigValidation(pluginUpdate, freshConfigValidation);
  }
  return { pluginUpdate, configSnapshot };
}
