import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createStatusGatewayProbeBudget } from "../../commands/status.gateway-probe-budget.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  readScheduledTaskCommand,
  resolveStartupEntryPaths,
  resolveTaskScriptPath,
} from "../../daemon/schtasks-layout.js";
import {
  isScheduledTaskInstalled,
  readScheduledTaskRuntime,
} from "../../daemon/schtasks-runtime.js";
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import type { GatewayService } from "../../daemon/service.js";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import { parseStatusRouteArgs } from "../program/route-args.js";
import {
  callGateway,
  classifyPortListener,
  inspectPortUsage,
  monotonicClock,
  readGatewayOwnerLease,
  requestStartupProbe,
  resetRestartHealthMocks,
  resolveGatewayProbeAuthSafeWithSecretInputs,
  restoreRestartHealthMocks,
} from "./restart-health.test-helpers.js";

const {
  readRuntime,
  readCommand,
  isAbsent,
  isLoaded,
  hasInstalledDefinition,
  serviceFixture,
  probeGateway,
} = vi.hoisted(() => ({
  readCommand: vi.fn<GatewayService["readCommand"]>(),
  readRuntime: vi.fn<GatewayService["readRuntime"]>(),
  isAbsent: vi.fn<NonNullable<GatewayService["isAbsent"]>>(),
  isLoaded: vi.fn<GatewayService["isLoaded"]>(),
  hasInstalledDefinition: vi.fn<NonNullable<GatewayService["hasInstalledDefinition"]>>(),
  serviceFixture: { hasInstalledDefinition: false },
  probeGateway: vi.fn(),
}));
vi.mock("../../daemon/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../daemon/service.js")>();
  const { createMockGatewayService } = await import("../../daemon/service.test-helpers.js");
  return {
    ...actual,
    resolveGatewayService: () =>
      createMockGatewayService({
        readRuntime,
        readCommand,
        isAbsent,
        isLoaded,
        ...(serviceFixture.hasInstalledDefinition ? { hasInstalledDefinition } : {}),
      }),
  };
});
vi.mock("../../commands/status.gateway-probe.js", () => ({
  resolveGatewayProbeAuthResolution: async () => ({ auth: {} }),
}));
vi.mock("../../gateway/probe.js", () => ({ probeGateway }));
const { waitForGatewayDiagnosticReadiness } = await import("./diagnostic-readiness.js");
const { resolveGatewayProbeSnapshot } = await import("../../commands/status.scan.shared.js");

describe("diagnostic Gateway readiness", () => {
  beforeEach(() => {
    resetRestartHealthMocks();
    inspectPortUsage.mockImplementation(async (port) => ({
      port,
      status: "free",
      listeners: [],
      hints: [],
    }));
    readRuntime.mockReset();
    readRuntime.mockResolvedValue({ status: "stopped" });
    readCommand.mockReset();
    readCommand.mockResolvedValue({ programArguments: ["gateway", "--port", "18789"] });
    isAbsent.mockReset().mockResolvedValue(false);
    isLoaded.mockReset().mockResolvedValue(false);
    hasInstalledDefinition.mockReset().mockResolvedValue(false);
    serviceFixture.hasInstalledDefinition = false;
    probeGateway.mockReset();
    vi.stubEnv("OPENCLAW_GATEWAY_URL", undefined);
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", undefined);
  });
  afterEach(() => {
    restoreRestartHealthMocks();
    vi.unstubAllEnvs();
  });

  it.each([
    "command",
    "initial absence",
    "strict absence",
    "load state",
    "runtime",
    "scheduled task query",
  ] as const)("preserves unsettled command cleanup from the %s inspection", async (stage) => {
    const failure = new Error("native inspection failed", {
      cause: new CommandProcessCleanupError(),
    });
    readCommand.mockResolvedValue(null);
    if (stage === "command") {
      readCommand.mockRejectedValueOnce(failure);
    } else if (stage === "initial absence") {
      isAbsent.mockRejectedValue(failure);
    } else if (stage === "strict absence") {
      isAbsent.mockImplementation(async (options) => {
        if (options.strictCommandAbsent) {
          throw failure;
        }
        return false;
      });
    } else if (stage === "load state") {
      isLoaded.mockRejectedValue(failure);
    } else if (stage === "scheduled task query") {
      vi.spyOn(await import("../../daemon/schtasks-exec.js"), "execSchtasks").mockRejectedValue(
        failure,
      );
      isLoaded.mockImplementation(isScheduledTaskInstalled);
    } else {
      readRuntime.mockRejectedValue(failure);
    }

    await expect(
      waitForGatewayDiagnosticReadiness({
        config: { gateway: { auth: { mode: "none" } } },
        timeoutMs: 1_000,
      }),
    ).rejects.toBe(failure);
    if (stage === "command") {
      expect(readCommand).toHaveBeenCalledOnce();
    }
    expect(inspectPortUsage).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("keeps failed installed-definition inspection unknown", async () => {
    serviceFixture.hasInstalledDefinition = true;
    readCommand.mockResolvedValue(null);
    readRuntime.mockResolvedValue({ status: "stopped", missingUnit: true });
    hasInstalledDefinition.mockRejectedValue(new Error("Native definition is unreadable"));

    const result = await waitForGatewayDiagnosticReadiness({
      config: { gateway: { auth: { mode: "none" } } },
      timeoutMs: 1_000,
    });

    expect(result?.waitOutcome).toBe("timeout");
    expect(result?.runtime.status).toBe("unknown");
    expect(monotonicClock.nowMs).toBe(1_000);
  });

  it.each([false, true])(
    "joins native runtime inspection before propagating definition failure (cleanup=%s)",
    async (cleanupUncertain) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      serviceFixture.hasInstalledDefinition = true;
      readCommand.mockResolvedValue(null);
      hasInstalledDefinition.mockRejectedValue(new Error("Native definition is unreadable"));
      const entered = createDeferred();
      const heldRuntime = createDeferred<GatewayServiceRuntime>();
      const cleanupFailure = new CommandProcessCleanupError();
      readRuntime.mockImplementationOnce(async () => {
        entered.resolve();
        return heldRuntime.promise;
      });
      let settled = false;
      const outcome = waitForGatewayDiagnosticReadiness({
        config: { gateway: { auth: { mode: "none" } } },
        timeoutMs: 1_000,
      }).then(
        (value) => {
          settled = true;
          return { value, error: undefined };
        },
        (error: unknown) => {
          settled = true;
          return { value: undefined, error };
        },
      );
      try {
        await entered.promise;
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);
        expect(readRuntime).toHaveBeenCalledOnce();
        expect(inspectPortUsage).not.toHaveBeenCalled();
      } finally {
        if (cleanupUncertain) {
          heldRuntime.reject(cleanupFailure);
        } else {
          heldRuntime.resolve({ status: "stopped", missingUnit: true });
        }
        await outcome;
        vi.useRealTimers();
      }
      const result = await outcome;
      if (cleanupUncertain) {
        expect(result.error).toBe(cleanupFailure);
      } else {
        expect(result.error).toBeUndefined();
        expect(result.value?.waitOutcome).toBe("timeout");
      }
    },
  );

  it("does not restart native inspection after the command consumes its deadline", async () => {
    readCommand.mockResolvedValue(null).mockImplementationOnce(async () => {
      monotonicClock.nowMs += 1_000;
      return null;
    });
    const result = await waitForGatewayDiagnosticReadiness({
      config: { gateway: { auth: { mode: "none" } } },
      timeoutMs: 1_000,
    });

    expect(readCommand).toHaveBeenCalledTimes(1);
    expect(isAbsent).not.toHaveBeenCalled();
    expect(isLoaded).not.toHaveBeenCalled();
    expect(readRuntime).not.toHaveBeenCalled();
    expect(result?.waitOutcome).toBe("timeout");
    expect(monotonicClock.nowMs).toBe(1_000);
  });

  it.each(["load state", "runtime"] as const)(
    "does not inspect Startup entries after the %s query consumes its deadline",
    async (stage) => {
      vi.stubEnv("APPDATA", "/fixture/appdata");
      const access = vi.spyOn(fs, "access").mockRejectedValue(new Error("Missing fixture entry"));
      if (stage === "load state") {
        readCommand.mockResolvedValue(null);
        isLoaded.mockImplementation(isScheduledTaskInstalled);
        vi.spyOn(await import("../../daemon/schtasks-exec.js"), "execSchtasks").mockImplementation(
          async () => {
            monotonicClock.nowMs += 1_000;
            return { code: 124, stdout: "", stderr: "schtasks timed out after 1000ms" };
          },
        );
      } else {
        readRuntime.mockImplementation(readScheduledTaskRuntime);
        vi.spyOn(
          await import("../../daemon/schtasks-state-probe.js"),
          "probeScheduledTaskState",
        ).mockImplementation(() => {
          monotonicClock.nowMs += 1_000;
          return { status: "missing" };
        });
      }
      const result = await waitForGatewayDiagnosticReadiness({
        config: { gateway: { auth: { mode: "none" } } },
        timeoutMs: 1_000,
      });

      expect(access).not.toHaveBeenCalled();
      expect(result?.waitOutcome).toBe("timeout");
      expect(monotonicClock.nowMs).toBe(1_000);
    },
  );

  it.each(["missing", "found"] as const)(
    "carries the remaining deadline into runtime command inspection with a %s task",
    async (taskState) => {
      vi.stubEnv("APPDATA", "/fixture/appdata");
      readRuntime.mockImplementation(readScheduledTaskRuntime);
      vi.spyOn(
        await import("../../daemon/schtasks-state-probe.js"),
        "probeScheduledTaskState",
      ).mockImplementation(() => {
        monotonicClock.nowMs += 400;
        return taskState === "missing" ? { status: "missing" } : { status: "found", state: 3 };
      });
      vi.spyOn(fs, "access").mockImplementation(async () => {
        monotonicClock.nowMs += 400;
      });
      const command = vi
        .spyOn(await import("../../daemon/schtasks-layout.js"), "readScheduledTaskCommand")
        .mockImplementation(async (_env, options) => {
          monotonicClock.nowMs += options?.timeoutMs ?? 15_000;
          return null;
        });
      const result = await waitForGatewayDiagnosticReadiness({
        config: { gateway: { auth: { mode: "none" } } },
        timeoutMs: 1_000,
      });

      expect(monotonicClock.nowMs).toBe(1_000);
      expect(command).toHaveBeenCalledWith(expect.any(Object), {
        timeoutMs: taskState === "missing" ? 200 : 600,
      });
      expect(result?.waitOutcome).toBe("timeout");
    },
  );

  it.each(["EACCES", "EPERM"])(
    "keeps real strict Windows Startup inspection unknown after %s",
    async (code) => {
      vi.stubEnv("APPDATA", "/fixture/appdata");
      const script = resolveTaskScriptPath(process.env);
      const startupPaths = resolveStartupEntryPaths(process.env);
      const missing = () =>
        Object.assign(new Error("Missing fixture definition"), { code: "ENOENT" });
      vi.spyOn(fs, "readFile").mockImplementation(async (filename) => {
        if (String(filename) !== script) {
          throw new Error("Unexpected fixture file read");
        }
        throw missing();
      });
      const stat = vi.spyOn(fs, "lstat").mockImplementation(async (filename) => {
        if (String(filename) === script) {
          throw missing();
        }
        if (!startupPaths.includes(String(filename))) {
          throw new Error("Unexpected fixture definition lookup");
        }
        throw Object.assign(new Error("Unreadable fixture Startup entry"), { code });
      });
      vi.spyOn(
        await import("../../daemon/schtasks-state-probe.js"),
        "probeScheduledTaskExists",
      ).mockReturnValue(false);
      readCommand.mockImplementation(readScheduledTaskCommand);
      const result = await waitForGatewayDiagnosticReadiness({
        config: { gateway: { auth: { mode: "none" } } },
        timeoutMs: 1_000,
      });

      expect(result?.waitOutcome).toBe("timeout");
      expect(result?.runtime.status).toBe("unknown");
      expect(stat.mock.calls.some(([filename]) => startupPaths.includes(String(filename)))).toBe(
        true,
      );
      expect(isLoaded).not.toHaveBeenCalled();
      expect(readRuntime).not.toHaveBeenCalled();
    },
  );

  it("does not turn later unreadable Startup evidence into proven absence", async () => {
    vi.stubEnv("APPDATA", "/fixture/appdata");
    const missing = () =>
      Object.assign(new Error("Missing fixture definition"), { code: "ENOENT" });
    vi.spyOn(fs, "readFile").mockRejectedValue(missing());
    vi.spyOn(fs, "lstat").mockRejectedValue(missing());
    const access = vi.spyOn(fs, "access").mockRejectedValue(
      Object.assign(new Error("Startup access changed after strict command inspection"), {
        code: "EACCES",
      }),
    );
    vi.spyOn(
      await import("../../daemon/schtasks-state-probe.js"),
      "probeScheduledTaskExists",
    ).mockReturnValue(false);
    vi.spyOn(
      await import("../../daemon/schtasks-state-probe.js"),
      "probeScheduledTaskState",
    ).mockReturnValue({ status: "missing" });
    vi.spyOn(await import("../../daemon/schtasks-exec.js"), "execSchtasks").mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "missing fixture task",
    });
    readCommand.mockImplementation(readScheduledTaskCommand);
    isLoaded.mockImplementation(isScheduledTaskInstalled);
    readRuntime.mockImplementation(readScheduledTaskRuntime);
    const result = await waitForGatewayDiagnosticReadiness({
      config: { gateway: { auth: { mode: "none" } } },
      timeoutMs: 1_000,
    });

    expect(result?.waitOutcome).toBe("timeout");
    expect(result?.runtime.status).toBe("unknown");
    expect(access).toHaveBeenCalled();
    expect(monotonicClock.nowMs).toBe(1_000);
  });

  it("retains a verified Startup process within the remaining inspection budget", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    vi.stubEnv("APPDATA", "/fixture/appdata");
    readRuntime.mockImplementation(readScheduledTaskRuntime);
    vi.spyOn(
      await import("../../daemon/schtasks-state-probe.js"),
      "probeScheduledTaskState",
    ).mockReturnValue({ status: "missing" });
    vi.spyOn(fs, "access").mockResolvedValue(undefined);
    const programArguments = [
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\openclaw\\dist\\index.js",
      "gateway",
      "--port",
      "18789",
    ];
    vi.spyOn(
      await import("../../daemon/schtasks-layout.js"),
      "readScheduledTaskCommand",
    ).mockResolvedValue({ programArguments });
    const snapshot = vi
      .spyOn(
        await import("../../daemon/schtasks-process-snapshot.js"),
        "readWindowsProcessSnapshot",
      )
      .mockImplementation(() => {
        monotonicClock.nowMs += 100;
        return [
          {
            ProcessId: 9000,
            CommandLine:
              '"C:\\Program Files\\nodejs\\node.exe" "C:\\openclaw\\dist\\index.js" gateway --port 18789',
          },
        ];
      });
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 9000 }],
      hints: [],
    });
    requestStartupProbe.mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify({ status: "started" }),
    });
    callGateway.mockImplementation(gatewayHealthResponse());
    const result = await waitForGatewayDiagnosticReadiness({
      config: { gateway: { auth: { mode: "none" } } },
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({ healthy: true, runtime: { status: "running", pid: 9000 } });
    expect(snapshot).toHaveBeenCalledWith(1_000);
    expect(monotonicClock.nowMs).toBe(100);
  });

  it.each<{ envUrl?: string; url?: string; config?: OpenClawConfig }>([
    { url: "ws://127.0.0.1:18789" },
    { config: { gateway: { mode: "remote", remote: { url: "wss://peer.example" } } } },
    { envUrl: "wss://peer.example" },
  ])("preserves an explicit or remote target: %j", async ({ envUrl, ...options }) => {
    if (envUrl) {
      vi.stubEnv("OPENCLAW_GATEWAY_URL", envUrl);
    }
    await expect(
      waitForGatewayDiagnosticReadiness({ config: {}, ...options }),
    ).resolves.toBeUndefined();
    expect(inspectPortUsage).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("defers to original diagnostic authentication when no shared credential is available", async () => {
    const result = await waitForGatewayDiagnosticReadiness({
      config: { gateway: { auth: { mode: "token" } } },
    });
    expect(result).toBeUndefined();
    expect(monotonicClock.nowMs).toBe(0);
    expect(readRuntime).not.toHaveBeenCalled();
    expect(inspectPortUsage).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
  });

  it.each([22_000, 61_000])(
    "charges %d ms of authentication preparation to the caller's absolute deadline",
    async (authElapsedMs) => {
      resolveGatewayProbeAuthSafeWithSecretInputs.mockImplementation(async () => {
        monotonicClock.nowMs += authElapsedMs;
        return { auth: { token: "fixture-token" } };
      });
      readGatewayOwnerLease.mockReturnValue({
        owner: "fixture-owner",
        pid: 8000,
        host: "fixture-host",
        startedAt: 1,
        port: 18789,
        mode: "foreground",
        supervisor: null,
        state: "live",
        expired: false,
      });

      const result = await waitForGatewayDiagnosticReadiness({
        config: { gateway: { auth: { mode: "token" } } },
        timeoutMs: 60_000,
        deadlineMs: 60_000,
      });

      expect(result).toMatchObject({
        healthy: false,
        waitOutcome: "timeout",
        elapsedMs: Math.max(0, 60_000 - authElapsedMs),
      });
      expect(monotonicClock.nowMs).toBe(Math.max(60_000, authElapsedMs));
      expect(callGateway).not.toHaveBeenCalled();
      if (authElapsedMs >= 60_000) {
        expect(inspectPortUsage).not.toHaveBeenCalled();
        expect(result?.probeError).toBe("Gateway readiness budget exhausted.");
      }
    },
  );

  it.each(
    (["foreground", "external", "native"] as const).flatMap((ownerMode) =>
      [20_000, 7_500].map((timeoutMs) => ({ ownerMode, timeoutMs })),
    ),
  )(
    "observes a $ownerMode startup using the selected config, auth, port and $timeoutMs ms budget",
    async ({ ownerMode, timeoutMs }) => {
      readCommand.mockResolvedValue(null);
      isAbsent.mockResolvedValue(true);
      const config: OpenClawConfig = { gateway: { port: 19091, auth: { mode: "token" } } };
      resolveGatewayProbeAuthSafeWithSecretInputs.mockResolvedValue({
        auth: { token: "fixture-token" },
      });
      if (ownerMode === "native") {
        readCommand.mockResolvedValue({ programArguments: ["gateway", "--port", "19091"] });
        readRuntime.mockResolvedValue({ status: "running", pid: 8000 });
      } else {
        readGatewayOwnerLease.mockReturnValue({
          owner: "fixture-owner",
          pid: 8000,
          host: "fixture-host",
          startedAt: 1,
          port: 19091,
          mode: ownerMode === "foreground" ? "foreground" : "supervised",
          supervisor: ownerMode === "foreground" ? null : { kind: "external", name: "fixture" },
          state: "live",
          expired: false,
        });
      }
      inspectPortUsage.mockImplementation(async (port) => ({
        port,
        status: "busy",
        listeners: [{ pid: 8000 }],
        hints: [],
      }));
      requestStartupProbe.mockImplementation(async () => ({
        statusCode: monotonicClock.nowMs < 20_000 ? 503 : 200,
        body: JSON.stringify(
          monotonicClock.nowMs < 20_000
            ? { status: "starting", pendingReason: "plugin-convergence" }
            : { status: "started" },
        ),
      }));
      callGateway.mockImplementation(gatewayHealthResponse());
      const result = await waitForGatewayDiagnosticReadiness({
        config,
        token: "fixture-token",
        timeoutMs,
      });
      expect(result).toMatchObject({
        healthy: timeoutMs === 20_000,
        waitOutcome: timeoutMs === 20_000 ? "healthy" : "still-starting",
        elapsedMs: timeoutMs,
        runtime: { status: "running", pid: 8000 },
        portUsage: { port: 19091 },
      });
      if (ownerMode === "native") {
        expect(readRuntime).toHaveBeenCalled();
      } else {
        expect(readRuntime).not.toHaveBeenCalled();
      }
      expect(isAbsent).not.toHaveBeenCalled();
      if (timeoutMs === 20_000) {
        expect(callGateway).toHaveBeenCalledWith(
          expect.objectContaining({ config, token: "fixture-token", localPortOverride: 19091 }),
        );
      } else {
        expect(result?.startupPhase).toBe("plugin-convergence");
        expect(callGateway).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["port", "state directory", "config path"])(
    "does not use a service with a different %s as the selected Gateway's process identity",
    async (mismatch) => {
      readRuntime.mockResolvedValue({ status: "running" });
      readCommand.mockResolvedValue({
        programArguments: ["gateway", "--port", "18789"],
        environment:
          mismatch === "state directory"
            ? { OPENCLAW_STATE_DIR: "/other-gateway-state" }
            : mismatch === "config path"
              ? { OPENCLAW_CONFIG_PATH: "/other-gateway-config.json" }
              : undefined,
      });
      const port = mismatch === "port" ? 19092 : 18789;
      const result = await waitForGatewayDiagnosticReadiness({
        config: { gateway: { auth: { mode: "none" } } },
        localPortOverride: port,
        timeoutMs: 1_000,
      });
      expect(result).toMatchObject({
        healthy: false,
        waitOutcome: "timeout",
        elapsedMs: 1_000,
        runtime: { status: "unknown" },
        portUsage: { port },
      });
      expect(readRuntime).not.toHaveBeenCalled();
      expect(isAbsent).not.toHaveBeenCalled();
    },
  );

  it("reports proven absence through plain status without spending its omitted-timeout budget", async () => {
    readCommand.mockResolvedValue(null);
    isAbsent.mockResolvedValue(true);
    const parsed = parseStatusRouteArgs(["node", "openclaw", "status"]);
    expect(parsed).not.toBeNull();
    expect(parsed?.timeoutMs).toBeUndefined();
    const budget = createStatusGatewayProbeBudget(parsed?.timeoutMs);
    const result = await resolveGatewayProbeSnapshot({
      cfg: { gateway: { auth: { mode: "none" } } },
      configPath: "/fixture/openclaw.json",
      env: process.env,
      opts: budget,
    });

    expect(result.gatewayReachable).toBe(false);
    expect(result.gatewayProbe).toMatchObject({ ok: false, error: "Gateway is unreachable" });
    expect(result.gatewayProbe?.startupPhase).toBeUndefined();
    expect(monotonicClock.nowMs).toBe(0);
    expect(budget.gatewayProbeDeadlineMs).toBe(60_000);
    expect(probeGateway).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("accepts strict missing-service runtime evidence without converting unknown into stopped", async () => {
    readCommand.mockResolvedValue(null);
    readRuntime.mockResolvedValue({ status: "stopped", missingUnit: true });

    const result = await waitForGatewayDiagnosticReadiness({
      config: { gateway: { auth: { mode: "none" } } },
    });

    expect(result).toMatchObject({
      healthy: false,
      waitOutcome: "stopped-free",
      elapsedMs: 0,
      runtime: { status: "stopped", missingUnit: true },
    });
  });

  it.each(["EACCES", "EPERM"])(
    "retains a matching cached command's native missing-unit hint with unreadable Startup entries (%s)",
    async (code) => {
      vi.stubEnv("APPDATA", "/fixture/appdata");
      const startupPaths = resolveStartupEntryPaths(process.env);
      const access = fs.access.bind(fs);
      const accessSpy = vi.spyOn(fs, "access").mockImplementation(async (pathname, mode) => {
        if (startupPaths.includes(String(pathname))) {
          throw Object.assign(new Error("Startup launcher is unreadable"), { code });
        }
        return access(pathname, mode);
      });
      vi.spyOn(
        await import("../../daemon/schtasks-state-probe.js"),
        "probeScheduledTaskState",
      ).mockReturnValue({ status: "missing" });
      // Keep the matching non-null command and real Windows ordinary runtime reader.
      // Its best-effort access failure is a hint, not the strict definition-absence proof.
      readRuntime.mockImplementation(readScheduledTaskRuntime);

      const result = await waitForGatewayDiagnosticReadiness({
        config: { gateway: { auth: { mode: "none" } } },
        timeoutMs: 1_000,
      });

      expect(result).toMatchObject({
        healthy: false,
        waitOutcome: "timeout",
        elapsedMs: 1_000,
        runtime: { status: "stopped", missingUnit: true },
      });
      expect(readCommand).toHaveBeenCalledOnce();
      expect(readRuntime.mock.calls.length).toBeGreaterThan(1);
      expect(isAbsent).not.toHaveBeenCalled();
      for (const pathname of startupPaths) {
        expect(accessSpy).toHaveBeenCalledWith(pathname);
      }
    },
  );

  it.each(["installed command", "inspection error"])(
    "does not carry strict absence into the next observation with %s",
    async (condition) => {
      readCommand.mockResolvedValue(null);
      const runtime = { status: "stopped", missingUnit: true };
      readRuntime.mockResolvedValue(runtime);
      // Block the first strict observation's return, then make its proof stale.
      inspectPortUsage.mockResolvedValueOnce({
        port: 18789,
        status: "unknown",
        listeners: [],
        hints: [],
      });
      readCommand.mockImplementation(async (_env, options) => {
        if (!options?.requireEffective || monotonicClock.nowMs === 0) {
          return null;
        }
        if (condition === "inspection error") {
          throw new Error("Native definition became unreadable");
        }
        return { programArguments: ["gateway", "--port", "18789"] };
      });

      const result = await waitForGatewayDiagnosticReadiness({
        config: { gateway: { auth: { mode: "none" } } },
        timeoutMs: 1_000,
      });

      expect(result).toMatchObject({
        healthy: false,
        waitOutcome: "timeout",
        elapsedMs: 1_000,
        runtime: { status: "unknown" },
      });
      expect(monotonicClock.nowMs).toBe(1_000);
    },
  );

  it.each(["failed", "malformed", "unreadable"])(
    "keeps %s strict native command inspection unknown",
    async (failure) => {
      readCommand.mockImplementation(async (_env, options) => {
        if (options?.requireEffective) {
          throw new Error(`Native definition ${failure}`);
        }
        return null;
      });
      readRuntime.mockResolvedValue({ status: "stopped", missingUnit: true });

      const result = await waitForGatewayDiagnosticReadiness({
        config: { gateway: { auth: { mode: "none" } } },
        timeoutMs: 1_000,
      });

      expect(result).toMatchObject({
        healthy: false,
        waitOutcome: "timeout",
        elapsedMs: 1_000,
        runtime: { status: "unknown" },
      });
    },
  );

  it.each([
    "null command",
    "unknown runtime",
    "loaded",
    "unreadable load state",
    "unreadable owner",
  ])("does not infer absence from %s", async (condition) => {
    readCommand.mockResolvedValue(null);
    readRuntime.mockResolvedValue({
      status: condition === "unknown runtime" ? "unknown" : "stopped",
      missingUnit: condition !== "null command",
    });
    isLoaded.mockResolvedValue(condition === "loaded");
    if (condition === "unreadable load state") {
      isLoaded.mockRejectedValue(new Error("Native load inspection unavailable"));
    }
    if (condition === "unreadable owner") {
      readGatewayOwnerLease.mockImplementation(() => {
        throw new Error("Gateway owner could not be inspected");
      });
    }

    const result = await waitForGatewayDiagnosticReadiness({
      config: { gateway: { auth: { mode: "none" } } },
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({
      healthy: false,
      waitOutcome: "timeout",
      elapsedMs: 1_000,
      runtime: { status: "unknown" },
    });
  });

  it.each(["live", "unknown"] as const)(
    "retains a %s owner acquired while native absence is inspected",
    async (state) => {
      readCommand.mockResolvedValue(null);
      isAbsent.mockResolvedValue(true);
      inspectPortUsage.mockImplementation(async (port) => {
        readGatewayOwnerLease.mockReturnValue({
          owner: "new-owner",
          pid: 8000,
          host: "fixture-host",
          startedAt: 1,
          port,
          mode: "supervised",
          supervisor: { kind: "systemd", name: "fixture" },
          state,
          expired: true,
        });
        return { port, status: "free", listeners: [], hints: [] };
      });

      const result = await waitForGatewayDiagnosticReadiness({
        config: { gateway: { auth: { mode: "none" } } },
        timeoutMs: 1_000,
      });

      expect(result).toMatchObject({ healthy: false, waitOutcome: "timeout", elapsedMs: 1_000 });
    },
  );

  it.each(
    ["strict absence", "matching command"].flatMap((nativeState) =>
      ["native", "port"].map((afterAwait) => ({ nativeState, afterAwait })),
    ),
  )(
    "keeps ownership unknown after the $afterAwait await with $nativeState, beyond both early-exit windows",
    async ({ nativeState, afterAwait }) => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      let unreadable = false;
      let failedOwnerReads = 0;
      let initialOwnerReads = 0;
      readGatewayOwnerLease.mockImplementation(() => {
        if (unreadable) {
          unreadable = false;
          failedOwnerReads += 1;
          throw new Error("Gateway owner identity became unverifiable");
        }
        initialOwnerReads += 1;
        return undefined;
      });
      if (nativeState === "strict absence") {
        readCommand.mockResolvedValue(null);
        isAbsent.mockImplementation(async () => {
          unreadable = afterAwait === "native";
          return true;
        });
      } else {
        readRuntime.mockImplementation(async () => {
          unreadable = afterAwait === "native";
          return { status: "stopped", missingUnit: true };
        });
      }
      inspectPortUsage.mockImplementation(async (port) => {
        if (afterAwait === "port") {
          unreadable = true;
        }
        return { port, status: "free", listeners: [], hints: [] };
      });

      const result = await waitForGatewayDiagnosticReadiness({
        config: { gateway: { auth: { mode: "none" } } },
        timeoutMs: 20_000,
      });

      expect(result).toMatchObject({
        healthy: false,
        waitOutcome: "timeout",
        elapsedMs: 20_000,
        runtime: { status: "unknown", detail: "Gateway owner could not be inspected." },
        portUsage: { status: "free" },
      });
      expect(failedOwnerReads).toBeGreaterThan(1);
      expect(initialOwnerReads).toBe(failedOwnerReads);
      expect(inspectPortUsage).toHaveBeenCalledTimes(failedOwnerReads);
      expect(callGateway).not.toHaveBeenCalled();
    },
  );

  it.each(["busy", "unknown"] as const)(
    "does not fast-return absence when the selected port is %s",
    async (status) => {
      readCommand.mockResolvedValue(null);
      isAbsent.mockResolvedValue(true);
      classifyPortListener.mockReturnValue("unknown");
      inspectPortUsage.mockImplementation(async (port) => ({
        port,
        status,
        listeners: status === "busy" ? [{ pid: 9000 }] : [],
        hints: [],
      }));

      const result = await waitForGatewayDiagnosticReadiness({
        config: { gateway: { auth: { mode: "none" } } },
        timeoutMs: 1_000,
      });

      expect(result).toMatchObject({ healthy: false, waitOutcome: "timeout", elapsedMs: 1_000 });
      expect(result?.portUsage.status).toBe(status);
    },
  );

  it.each([false, true])(
    "preserves a live listener's health result despite native absence (channel failure=%s)",
    async (failed) => {
      readCommand.mockResolvedValue(null);
      isAbsent.mockResolvedValue(true);
      inspectPortUsage.mockImplementation(async (port) => ({
        port,
        status: "busy",
        listeners: [{ pid: 8000 }],
        hints: [],
      }));
      callGateway.mockImplementation(
        gatewayHealthResponse({
          health: failed
            ? { channels: { fixture: { probe: { ok: false, error: "failed" } } } }
            : {},
        }),
      );

      const result = await waitForGatewayDiagnosticReadiness({
        config: { gateway: { auth: { mode: "none" } } },
      });

      expect(result).toMatchObject({
        healthy: !failed,
        waitOutcome: failed ? "channel-errors" : "healthy",
        elapsedMs: 0,
      });
      if (failed) {
        expect(result?.channelProbeErrors).toEqual([{ id: "fixture", error: "failed" }]);
      }
    },
  );

  it("charges absence inspection to the existing explicit deadline", async () => {
    readCommand.mockImplementation(async () => {
      monotonicClock.nowMs += 300;
      return null;
    });
    isAbsent.mockImplementation(async ({ timeoutMs }) => {
      expect(timeoutMs).toBe(700);
      monotonicClock.nowMs += 800;
      return true;
    });

    const result = await waitForGatewayDiagnosticReadiness({
      config: { gateway: { auth: { mode: "none" } } },
      timeoutMs: 1_000,
      deadlineMs: 1_000,
    });

    expect(result).toMatchObject({ healthy: false, waitOutcome: "timeout", elapsedMs: 1_100 });
    expect(monotonicClock.nowMs).toBe(1_100);
  });

  it("bounds an actually-down Gateway with the caller's shorter deadline", async () => {
    const result = await waitForGatewayDiagnosticReadiness({
      config: { gateway: { auth: { mode: "none" } } },
      timeoutMs: 1_250,
    });
    expect(result).toMatchObject({
      healthy: false,
      waitOutcome: "timeout",
      elapsedMs: 1_250,
      portUsage: { status: "free" },
    });
    expect(callGateway).not.toHaveBeenCalled();
  });
});
