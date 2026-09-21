import type { SpawnSyncOptions } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { resolveFallbackRuntime } from "./schtasks-runtime.js";
import type { GatewayServiceCommandConfig } from "./service-types.js";

type NativeResult = {
  pid: number;
  output: (string | null)[];
  stdout: string;
  stderr: string;
  status: number | null;
  signal: null;
  error?: Error;
};

const native = vi.hoisted(() =>
  vi.fn<(command: string, args?: readonly string[], options?: SpawnSyncOptions) => NativeResult>(),
);
vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
  spawnSync: native,
}));

let now = 0;
let processOutput = "";
let portOutput = "";
let processElapsed = 0;
let portElapsed = 0;
let portExit = 0;
let portError: Error | undefined;
let portThrow: Error | undefined;

function result(stdout: string, status = 0, error?: Error): NativeResult {
  return {
    pid: 1,
    output: [null, stdout, ""],
    stdout,
    stderr: "",
    status,
    signal: null,
    ...(error ? { error } : {}),
  };
}

function command(kind: "gateway" | "node"): GatewayServiceCommandConfig {
  return {
    programArguments: ["C:\\node.exe", "C:\\openclaw\\entry.js", kind, "run", "--port", "18789"],
  };
}

const portCalls = () =>
  native.mock.calls.filter(([, args]) => args?.join(" ").includes("Get-NetTCPConnection"));

beforeEach(() => {
  mockProcessPlatform("win32");
  vi.spyOn(performance, "now").mockImplementation(() => now);
  now = processElapsed = portElapsed = portExit = 0;
  portError = portThrow = undefined;
  processOutput = JSON.stringify([
    { ProcessId: 111, CommandLine: "powershell.exe Get-CimInstance" },
  ]);
  portOutput = "0\r\n";
  native.mockReset();
  native.mockImplementation((_executable, args) => {
    const script = args?.join(" ") ?? "";
    if (script.includes("Get-CimInstance Win32_Process")) {
      now += processElapsed;
      return result(processOutput);
    }
    if (script.includes("Get-NetTCPConnection")) {
      now += portElapsed;
      if (portThrow) {
        throw portThrow;
      }
      return result(portOutput, portExit, portError);
    }
    throw new Error("Unexpected native inspection");
  });
});
afterEach(() => vi.restoreAllMocks());

describe("bounded Startup runtime observations", () => {
  it.each(["gateway", "node"] as const)(
    "preserves observed stopped %s runtime with a deadline",
    async (kind) => {
      const runtime = await resolveFallbackRuntime(
        { OPENCLAW_SERVICE_KIND: kind },
        command(kind),
        "observe",
        100,
      );
      expect(runtime.status).toBe("stopped");
      expect(runtime.missingUnit).not.toBe(true);
      expect(portCalls()).toHaveLength(kind === "gateway" ? 1 : 0);
    },
  );

  it.each(["gateway", "node"] as const)(
    "retains exact running %s process evidence",
    async (kind) => {
      const installed = command(kind);
      processOutput = JSON.stringify([
        { ProcessId: 4242, CommandLine: installed.programArguments.join(" ") },
      ]);
      const runtime = await resolveFallbackRuntime(
        { OPENCLAW_SERVICE_KIND: kind },
        installed,
        "observe",
        100,
      );
      expect(runtime).toMatchObject({ status: "running", pid: 4242 });
      expect(portCalls()).toHaveLength(0);
    },
  );

  it.each(["", "[]", "[{}]", "not-json"])(
    "does not treat unavailable snapshot %j as stopped",
    async (output) => {
      processOutput = output;
      const runtime = await resolveFallbackRuntime({}, command("gateway"), "observe", 100);
      expect(runtime.status).toBe("unknown");
      expect(portCalls()).toHaveLength(0);
    },
  );

  it.each(["1", "2", "", "not-a-count", "-1"])(
    "keeps busy or unverifiable listener result %j unknown",
    async (output) => {
      portOutput = output;
      const runtime = await resolveFallbackRuntime({}, command("gateway"), "observe", 100);
      expect(runtime.status).toBe("unknown");
      expect(portCalls()).toHaveLength(1);
    },
  );

  it("does not collapse native listener failure into a successful empty result", async () => {
    portExit = 1;
    portError = new Error("listener inspection unavailable");
    const runtime = await resolveFallbackRuntime({}, command("gateway"), "observe", 100);
    expect(runtime.status).toBe("unknown");
  });

  it("debits process time before the listener read without fractional timeout inflation", async () => {
    processElapsed = 40.25;
    const runtime = await resolveFallbackRuntime({}, command("gateway"), "observe", 100);
    expect(runtime.status).toBe("stopped");
    expect(portCalls()[0]?.[2]?.timeout).toBe(59);
  });

  it("does not admit a listener read with a sub-millisecond remainder", async () => {
    processElapsed = 99.75;
    const runtime = await resolveFallbackRuntime({}, command("gateway"), "observe", 100);
    expect(runtime.status).toBe("unknown");
    expect(portCalls()).toHaveLength(0);
  });

  it("does not accept a free listener observation completed after the shared deadline", async () => {
    processElapsed = 30;
    portElapsed = 71;
    const runtime = await resolveFallbackRuntime({}, command("gateway"), "observe", 100);
    expect(runtime.status).toBe("unknown");
    expect(portCalls()[0]?.[2]?.timeout).toBe(70);
  });

  it("retains a listener cleanup refusal rather than reporting stopped", async () => {
    const error = new CommandProcessCleanupError();
    portThrow = error;
    await expect(resolveFallbackRuntime({}, command("gateway"), "observe", 100)).rejects.toBe(
      error,
    );
  });
});
