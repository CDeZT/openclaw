import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import {
  ServiceDefinitionInspectionError,
  ServiceInspectionError,
} from "./service-inspection-error.js";
import { readGatewayServiceState, resolveGatewayService, type GatewayService } from "./service.js";
import { createMockGatewayService, mockSystemAccountHome } from "./service.test-helpers.js";
import { readSystemdServiceRuntime } from "./systemd-runtime.js";
import { findInstalledSystemdGatewayScope, isSystemdServiceAbsent } from "./systemd-scope.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const serviceEnv = (scenario: string) => ({
  HOME: `/openclaw-service-proof/${scenario}`,
  XDG_RUNTIME_DIR: `/openclaw-service-proof/${scenario}/runtime`,
  DBUS_SESSION_BUS_ADDRESS: `unix:path=/openclaw-service-proof/${scenario}/bus`,
  USER: "service",
  LOGNAME: "service",
  SUDO_USER: undefined,
});

beforeEach(() => {
  mockSystemAccountHome();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("readGatewayServiceState absence", () => {
  it.each(
    (["user", "system"] as const).flatMap((scope) =>
      ["missing-tools", "not-booted"].map((manager) => ({ scope, manager })),
    ),
  )("reports a stale $scope unit with $manager", async ({ scope, manager }) => {
    mockProcessPlatform("linux");
    const env = serviceEnv(`${scope}-${manager}`);
    const unitPath =
      scope === "user"
        ? `${env.HOME}/.config/systemd/user/openclaw-gateway.service`
        : "/etc/systemd/system/openclaw-gateway.service";
    const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
    vi.spyOn(fs, "readFile").mockImplementation(async (file) => {
      if (file !== unitPath) {
        throw missing();
      }
      return "[Service]\nExecStart=/usr/bin/node /old/openclaw/dist/index.js gateway\n";
    });
    vi.spyOn(fs, "access").mockImplementation(async (file) => {
      if (file !== unitPath) {
        throw missing();
      }
    });
    vi.spyOn(fs, "readdir").mockResolvedValue([]);
    vi.spyOn(await import("./exec-file.js"), "execFileUtf8").mockImplementation(async () => ({
      code: 1,
      termination: manager === "missing-tools" ? "error" : "exit",
      errorCode: manager === "missing-tools" ? "ENOENT" : undefined,
      stdout: "",
      stderr: "System has not been booted with systemd as init system (PID 1). Can't operate.",
    }));
    const state = await readGatewayServiceState(resolveGatewayService(), { env });
    expect(state.systemdInstallation?.kind).toBe(scope);
    expect(state.installed).toBe(true);
    expect(state.inspectionReason).toBe("service-manager-unavailable");
    expect(state.runtime?.inspectionReason).toBe("service-manager-unavailable");
  });

  it("retains proven manager absence without a recorded unit", async () => {
    mockProcessPlatform("linux");
    const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
    vi.spyOn(fs, "lstat").mockRejectedValue(missing());
    vi.spyOn(fs, "access").mockRejectedValue(missing());
    vi.spyOn(fs, "readdir").mockResolvedValue([]);
    const native = vi.spyOn(await import("./exec-file.js"), "execFileUtf8");
    const state = await readGatewayServiceState(resolveGatewayService(), {
      env: { ...serviceEnv("no-manager-or-unit"), DBUS_SESSION_BUS_ADDRESS: undefined },
    });
    expect(state).toMatchObject({
      inspectionReason: "service-manager-unavailable",
      installed: false,
      command: null,
      runtime: { inspectionReason: "service-manager-unavailable", missingUnit: true },
    });
    expect(native).not.toHaveBeenCalled();
  });

  it.each(["directory EACCES", "directory EPERM", "definition EACCES", "definition EPERM"])(
    "does not project initial manager absence through incomplete discovery (%s)",
    async (condition) => {
      const fixture = tempDirs.make("openclaw-incomplete-discovery-");
      await fs.writeFile(path.join(fixture, "custom-gateway.service"), "[Service]\n");
      const readdir = fs.readdir;
      mockProcessPlatform("linux");
      const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
      const denied = () =>
        Object.assign(new Error("unreadable"), { code: condition.split(" ")[1] });
      vi.spyOn(fs, "lstat").mockRejectedValue(missing());
      vi.spyOn(fs, "access").mockRejectedValue(missing());
      vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
        if (String(args[0]) !== "/etc/systemd/system") {
          return [];
        }
        if (condition.startsWith("directory ")) {
          throw denied();
        }
        args[0] = fixture;
        return readdir(...args);
      });
      vi.spyOn(fs, "readFile").mockImplementation(async (file) => {
        if (String(file) === "/etc/systemd/system/custom-gateway.service") {
          throw denied();
        }
        throw missing();
      });
      vi.spyOn(await import("./exec-file.js"), "execFileUtf8").mockResolvedValue({
        code: 1,
        termination: "error",
        errorCode: "ENOENT",
        stdout: "",
        stderr: "service manager unavailable",
      });

      const state = await readGatewayServiceState(resolveGatewayService(), {
        env: { ...serviceEnv("incomplete-initial-discovery"), DBUS_SESSION_BUS_ADDRESS: undefined },
      });

      expect(state.runtime?.status).toBe("unknown");
      expect(state.runtime?.missingUnit).not.toBe(true);
    },
  );

  it("preserves command inspection diagnosis when runtime availability also fails", async () => {
    vi.spyOn(await import("./systemd-exec.js"), "assertSystemdAvailable").mockRejectedValue(
      new Error("systemctl not available"),
    );
    const state = await readSystemdServiceRuntime(serviceEnv("runtime-failure"), {
      systemdReadTarget: {
        scope: "user",
        unitName: "openclaw-gateway.service",
        unitPath: "/openclaw-service-proof/runtime-failure/gateway.service",
      },
      commandInspection: {
        kind: "unavailable",
        error: new ServiceInspectionError("service-manager-unavailable"),
      },
    });
    expect(state).toMatchObject({
      status: "unknown",
      inspectionReason: "service-manager-unavailable",
    });
  });

  it("does not require a user bus to inspect a running system service", async () => {
    mockProcessPlatform("linux");
    const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
    vi.spyOn(fs, "readFile").mockRejectedValue(missing());
    vi.spyOn(fs, "access").mockImplementation(async (file) => {
      if (file !== "/etc/systemd/system/openclaw-gateway.service") {
        throw missing();
      }
    });
    vi.spyOn(fs, "readdir").mockResolvedValue([]);
    vi.spyOn(await import("./exec-file.js"), "execFileUtf8").mockImplementation(
      async (command) => ({
        code: command === "busctl" ? 1 : 0,
        termination: "exit",
        stdout: command === "busctl" ? "" : "LoadState=loaded\nActiveState=active\nMainPID=42\n",
        stderr: command === "busctl" ? "Failed to connect to bus: No such file or directory" : "",
      }),
    );
    const state = await readGatewayServiceState(resolveGatewayService(), {
      env: serviceEnv("running-system-service"),
    });
    expect(state.runtime).toMatchObject({ status: "running", pid: 42 });
    expect(state.inspectionReason).toBeUndefined();
  });

  it.each([
    ["user bus", "systemd-user-bus-unavailable"],
    ["busctl", "systemd-busctl-unavailable"],
  ])(
    "reports missing %s instead of recommending an impossible fresh install",
    async (missingPiece, reason) => {
      mockProcessPlatform("linux");
      const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
      vi.spyOn(fs, "readFile").mockRejectedValue(missing());
      vi.spyOn(fs, "access").mockRejectedValue(missing());
      vi.spyOn(fs, "readdir").mockResolvedValue([]);
      const run = vi.spyOn(await import("./exec-file.js"), "execFileUtf8");
      run.mockImplementation(async (command) => ({
        code: command === "busctl" ? 1 : 0,
        termination: command === "busctl" && missingPiece === "busctl" ? "error" : "exit",
        errorCode: command === "busctl" && missingPiece === "busctl" ? "ENOENT" : undefined,
        stdout:
          command === "busctl" ? "" : "LoadState=not-found\nActiveState=inactive\nSubState=dead\n",
        stderr: command === "busctl" ? "Failed to connect to bus: No such file or directory" : "",
      }));
      const state = await readGatewayServiceState(resolveGatewayService(), {
        env: serviceEnv(reason),
      });
      expect(state.inspectionReason).toBe(reason);
      expect(state.runtime?.missingUnit).not.toBe(true);
      expect(state.runtime?.status).toBe("unknown");
    },
  );

  it.each(["current", "revoked", "expired"])(
    "preserves the admitted binding and deadline through an absent projection (%s)",
    async (condition) => {
      let current = true;
      let now = 100;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const binding = {
        unit: "openclaw-gateway.service",
        managerUid: 1000,
        destination: ":1.0",
        verify: vi.fn(() => {
          if (!current) {
            throw new Error("original binding retired");
          }
        }),
        query: vi.fn(async () => []),
        close: vi.fn(async () => {}),
      };
      const isAbsent = vi.fn<NonNullable<GatewayService["isAbsent"]>>(async (args) => {
        if (!args.strictCommandAbsent) {
          return false;
        }
        current = condition !== "revoked";
        if (condition === "expired") {
          now += 1001;
        }
        return true;
      });
      const readCommand = vi.fn<GatewayService["readCommand"]>(async () => null);
      const readRuntime = vi.fn<GatewayService["readRuntime"]>(async () => ({
        status: "unknown",
      }));
      const observed = readGatewayServiceState(
        createMockGatewayService({ isAbsent, readCommand, readRuntime }),
        {
          env: { HOME: "/openclaw-service-proof" },
          requireEffective: true,
          requireLoadedCommand: true,
          systemdReadBinding: binding,
          timeoutMs: 1000,
        },
      );
      if (condition === "current") {
        await expect(observed).resolves.toMatchObject({
          command: null,
          runtime: { status: "stopped", missingUnit: true },
        });
      } else {
        await expect(observed).rejects.toThrow(
          condition === "revoked" ? "original binding retired" : "deadline expired",
        );
      }
      expect(readCommand).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ systemdReadBinding: binding }),
      );
      expect(readRuntime).not.toHaveBeenCalled();
      expect(binding.close).not.toHaveBeenCalled();
    },
  );

  it.each(
    [false, true].flatMap((strictCommandAbsent) =>
      [
        "missing directories",
        "readable unrelated unit",
        "marker-owned unit",
        "directory EACCES",
        "directory EPERM",
        "directory EIO",
        "dangling directory",
        "definition EACCES",
        "definition EPERM",
        "listed definition ENOENT",
        "dangling user definition",
        "dangling system definition",
      ].map((condition) => ({ strictCommandAbsent, condition })),
    ),
  )(
    "requires complete discovery for $condition (strict command=$strictCommandAbsent)",
    async ({ strictCommandAbsent, condition }) => {
      const fixture = tempDirs.make("openclaw-absence-discovery-");
      const fixtureFile = path.join(fixture, "custom-gateway.service");
      await fs.writeFile(
        fixtureFile,
        condition === "marker-owned unit"
          ? "[Service]\nExecStart=/usr/bin/openclaw gateway\n"
          : "[Service]\nExecStart=/usr/bin/sleep infinity\n",
      );
      const present = await fs.lstat(fixture);
      const readdir = fs.readdir;
      const readFile = fs.readFile;
      mockProcessPlatform("linux");
      const env = { ...serviceEnv("discovery"), DBUS_SESSION_BUS_ADDRESS: undefined };
      const systemDir = "/etc/systemd/system";
      const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
      const unreadable = (code = "EACCES") => Object.assign(new Error("unreadable"), { code });
      vi.spyOn(fs, "access").mockRejectedValue(missing());
      vi.spyOn(fs, "lstat").mockImplementation(async (pathname) => {
        const target = String(pathname);
        if (
          (condition === "dangling directory" && target === systemDir) ||
          (condition === "dangling user definition" &&
            target === `${env.HOME}/.config/systemd/user/openclaw-gateway.service`) ||
          (condition === "dangling system definition" &&
            target === `${systemDir}/openclaw-gateway.service`)
        ) {
          return present;
        }
        throw missing();
      });
      vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
        if (String(args[0]) !== systemDir || condition === "missing directories") {
          throw missing();
        }
        if (condition.startsWith("directory ")) {
          throw unreadable(condition.slice("directory ".length));
        }
        if (condition === "dangling directory") {
          throw missing();
        }
        args[0] = fixture;
        return readdir(...args);
      });
      vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
        if (String(args[0]) !== `${systemDir}/custom-gateway.service`) {
          throw missing();
        }
        if (condition.startsWith("definition ")) {
          throw unreadable(condition.slice("definition ".length));
        }
        if (condition === "listed definition ENOENT") {
          throw missing();
        }
        args[0] = fixtureFile;
        return readFile(...args);
      });
      // The existing native-owner matrix below proves the selected name. This
      // matrix isolates whether canonical filesystem discovery may claim absence.
      vi.spyOn(
        await import("./systemd-system.js"),
        "assertNoSystemSystemdOwnership",
      ).mockResolvedValue();
      const uncertain =
        condition.startsWith("directory ") ||
        condition.startsWith("definition ") ||
        ["dangling directory", "listed definition ENOENT"].includes(condition);
      if (uncertain) {
        await expect(findInstalledSystemdGatewayScope(env)).resolves.toBeNull();
      }
      const result = isSystemdServiceAbsent(
        env,
        strictCommandAbsent ? { strictCommandAbsent: true } : undefined,
      );
      if (uncertain) {
        await expect(result).rejects.toBeInstanceOf(ServiceDefinitionInspectionError);
      } else {
        await expect(result).resolves.toBe(
          condition === "missing directories" || condition === "readable unrelated unit",
        );
      }
    },
  );

  it.each(
    ["parallel", "delegated serial"].flatMap((placement) =>
      [false, true].map((explicit) => ({ placement, explicit })),
    ),
  )(
    "preserves Windows elapsed allowance and control defaults ($placement, explicit=$explicit)",
    async ({ placement, explicit }) => {
      mockProcessPlatform("win32");
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
      vi.spyOn(fs, "readFile").mockImplementation(async () => {
        now += 100;
        throw missing();
      });
      vi.spyOn(fs, "lstat").mockRejectedValue(missing());
      vi.spyOn(fs, "access").mockRejectedValue(missing());
      const taskProbe = await import("./schtasks-state-probe.js");
      const exists = vi
        .spyOn(taskProbe, "probeScheduledTaskExists")
        .mockImplementation((_name, timeoutMs) => {
          expect(timeoutMs).toBe(explicit ? 900 : undefined);
          now += 200;
          return false;
        });
      const runtime = vi
        .spyOn(taskProbe, "probeScheduledTaskState")
        .mockImplementation((_name, timeoutMs) => {
          expect(timeoutMs).toBe(explicit ? 500 : undefined);
          now += 100;
          return { status: "missing" };
        });
      const run = vi
        .spyOn(await import("../process/exec.js"), "runCommandWithTimeout")
        .mockImplementation(async (argv, options) => {
          expect(argv).toEqual(["schtasks", "/Query", "/TN", "OpenClaw Gateway"]);
          expect(options).toMatchObject({
            timeoutMs: explicit ? 700 : 15_000,
            noOutputTimeoutMs: explicit ? 700 : 30_000,
          });
          now += 200;
          return {
            stdout: "",
            stderr: "missing task",
            code: 1,
            signal: null,
            killed: false,
            termination: "exit",
          };
        });
      const observe = () =>
        readGatewayServiceState(resolveGatewayService(), {
          env: { HOME: "/windows-service-proof", APPDATA: "/windows-service-proof/appdata" },
          requireEffective: true,
          requireLoadedCommand: true,
          ...(explicit ? { timeoutMs: 1_000 } : {}),
        });
      const { withGatewayServiceUpdateAuthority } = await import("./service-update-authority.js");
      const state =
        placement === "delegated serial"
          ? await withGatewayServiceUpdateAuthority(undefined, observe, {
              updateOwned: false,
              nativeCommand: async () => {
                throw new Error("Unexpected delegated command");
              },
            })
          : await observe();

      expect(state).toMatchObject({
        command: null,
        installed: false,
        loadState: { status: "not-loaded" },
        runtime: { status: "stopped", missingUnit: true },
      });
      expect(now).toBe(600);
      expect(exists).toHaveBeenCalledOnce();
      expect(runtime).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledOnce();
    },
  );

  it("does not restart Windows native inspection after schtasks exhausts the shared allowance", async () => {
    mockProcessPlatform("win32");
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
    vi.spyOn(fs, "readFile").mockRejectedValue(missing());
    vi.spyOn(fs, "lstat").mockRejectedValue(missing());
    vi.spyOn(fs, "access").mockRejectedValue(missing());
    const taskProbe = await import("./schtasks-state-probe.js");
    vi.spyOn(taskProbe, "probeScheduledTaskExists").mockImplementation(() => {
      now += 300;
      return false;
    });
    const runtime = vi.spyOn(taskProbe, "probeScheduledTaskState");
    const run = vi
      .spyOn(await import("../process/exec.js"), "runCommandWithTimeout")
      .mockImplementation(async (_argv, options) => {
        expect(options).toMatchObject({ timeoutMs: 700, noOutputTimeoutMs: 700 });
        now += 700;
        return {
          stdout: "",
          stderr: "",
          code: null,
          signal: "SIGTERM",
          killed: true,
          termination: "timeout",
        };
      });
    const { withGatewayServiceUpdateAuthority } = await import("./service-update-authority.js");
    await expect(
      withGatewayServiceUpdateAuthority(
        undefined,
        () =>
          readGatewayServiceState(resolveGatewayService(), {
            env: { HOME: "/windows-service-proof", APPDATA: "/windows-service-proof/appdata" },
            requireEffective: true,
            requireLoadedCommand: true,
            timeoutMs: 1_000,
          }),
        {
          updateOwned: false,
          nativeCommand: async () => {
            throw new Error("Unexpected delegated command");
          },
        },
      ),
    ).rejects.toThrow("Service inspection deadline expired.");
    expect(now).toBe(1_000);
    expect(run).toHaveBeenCalledOnce();
    expect(runtime).not.toHaveBeenCalled();
  });

  it.each([
    "absent",
    "system-loaded",
    "system-definition",
    "system-unavailable",
    "user-unavailable",
    "directory EACCES",
    "directory EPERM",
    "definition EACCES",
    "definition EPERM",
  ])(
    "preserves strict Linux service absence only with both scopes verified (%s)",
    async (condition) => {
      const fixture = condition.startsWith("definition ")
        ? tempDirs.make("openclaw-strict-discovery-")
        : undefined;
      if (fixture) {
        await fs.writeFile(path.join(fixture, "custom-gateway.service"), "[Service]\n");
      }
      const readdir = fs.readdir;
      mockProcessPlatform("linux");
      const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
      vi.spyOn(fs, "readFile").mockRejectedValue(missing());
      vi.spyOn(fs, "access").mockRejectedValue(missing());
      const directories = vi.spyOn(fs, "readdir").mockResolvedValue([]);
      if (condition.startsWith("directory ")) {
        directories.mockRejectedValue(
          Object.assign(new Error("unreadable"), { code: condition.split(" ")[1] }),
        );
      }
      if (fixture) {
        directories.mockImplementation(async (...args) => {
          if (String(args[0]) !== "/etc/systemd/system") {
            return [];
          }
          args[0] = fixture;
          return readdir(...args);
        });
        vi.mocked(fs.readFile).mockImplementation(async (file) => {
          if (String(file) === "/etc/systemd/system/custom-gateway.service") {
            throw Object.assign(new Error("unreadable"), { code: condition.split(" ")[1] });
          }
          throw missing();
        });
      }
      const present = await fs.lstat(process.cwd());
      vi.spyOn(fs, "lstat").mockImplementation(async (target) => {
        if (
          condition === "system-definition" &&
          String(target) === "/etc/systemd/system/openclaw-gateway.service"
        ) {
          return present;
        }
        throw missing();
      });
      const run = vi.spyOn(await import("./exec-file.js"), "execFileUtf8");
      run.mockImplementation(async (command, args) => {
        const system = args.includes("--system");
        const success = (type: string, data: unknown) => ({
          code: 0,
          termination: "exit" as const,
          stdout: JSON.stringify({ type, data }),
          stderr: "",
        });
        const failure = (stderr: string) => ({
          code: 1,
          termination: "exit" as const,
          stdout: "",
          stderr,
        });
        if (condition === (system ? "system-unavailable" : "user-unavailable")) {
          return failure("Failed to connect to bus: No such file or directory");
        }
        if (args.includes("Version")) {
          expect(command).toBe("busctl");
          expect(args).toEqual([
            "--user",
            "--auto-start=no",
            "get-property",
            "org.freedesktop.systemd1",
            "/org/freedesktop/systemd1",
            "org.freedesktop.systemd1.Manager",
            "Version",
          ]);
          return { code: 0, termination: "exit", stdout: 's "252.39"', stderr: "" };
        }
        if (args.includes("GetNameOwner")) {
          return success("s", [":1.2"]);
        }
        if (args.includes("GetUnit")) {
          return system && condition === "system-loaded"
            ? success("o", ["/org/freedesktop/systemd1/unit/openclaw_2dgateway_2eservice"])
            : failure("Call failed: Unit openclaw-gateway.service not loaded.");
        }
        if (args.includes("GetUnitFileState")) {
          return failure("Call failed: No such file or directory");
        }
        if (system && args.includes("UnitPath")) {
          return success("as", ["/etc/systemd/system"]);
        }
        return failure("Unexpected native query");
      });
      const result = readGatewayServiceState(resolveGatewayService(), {
        env: serviceEnv(condition),
        requireEffective: true,
        requireLoadedCommand: true,
      });
      if (condition === "user-unavailable") {
        await expect(result).rejects.toThrow();
      } else if (condition === "absent") {
        await expect(result).resolves.toMatchObject({
          installed: false,
          command: null,
          loadState: { status: "not-loaded" },
          runtime: { status: "stopped", missingUnit: true },
          running: false,
        });
      } else {
        expect((await result).runtime?.missingUnit).not.toBe(true);
      }
      expect(run.mock.calls.some((call) => call[1].includes("LoadUnit"))).toBe(false);
    },
  );
});
