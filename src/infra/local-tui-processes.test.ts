import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  discoverLocalTuiProcesses,
  listLocalTuiProcesses,
  quiesceLocalTuiProcessesBeforeUpdate,
  terminateLocalTuiProcesses,
  type LocalTuiProcess,
  waitForLocalTuiUpdate,
} from "./local-tui-processes.js";
import { formatOpenClawProcessTitle } from "./openclaw-installation-id.js";

describe("local TUI processes", () => {
  afterEach(() => vi.restoreAllMocks());

  function stopChild(child: ChildProcess): void {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }

  it("lists only verified local TUI processes from ps output", () => {
    const targetRoot = "/usr/lib/node_modules/openclaw";
    const spawnSync = vi.fn().mockReturnValue({
      status: 0,
      stdout: [
        " 501 101 Thu Aug 20 19:00:00 2026 /usr/local/bin/openclaw tui",
        " 501 106 Thu Aug 20 19:00:00 2026 /usr/bin/node /usr/lib/node_modules/openclaw/openclaw.mjs tui",
        " 501 107 Thu Aug 20 19:00:00 2026 /opt/other/bin/openclaw chat",
        " 501 108 Thu Aug 20 19:00:00 2026 openclaw tui",
        " 501 109 Thu Aug 20 19:00:00 2026 helper --note openclaw",
        " 501 999 Thu Aug 20 19:00:00 2026 openclaw tui",
      ].join("\n"),
    });
    vi.spyOn(fs.realpathSync, "native").mockImplementation((value) =>
      value === "/usr/local/bin/openclaw" ? `${targetRoot}/bin/openclaw` : String(value),
    );

    expect(
      listLocalTuiProcesses({
        targetRoot,
        platform: "darwin",
        currentUid: 501,
        currentPid: 999,
        spawnSync,
        readPosixInstanceId: (pid) => `linux:${pid}:start`,
      }),
    ).toEqual([
      {
        pid: 101,
        command: "/usr/local/bin/openclaw tui",
        instanceId: "linux:101:start",
        instanceIdentity: "strong",
        ownership: "target",
      },
      {
        pid: 106,
        command: "/usr/bin/node /usr/lib/node_modules/openclaw/openclaw.mjs tui",
        instanceId: "linux:106:start",
        instanceIdentity: "strong",
        ownership: "target",
      },
      {
        pid: 108,
        command: "openclaw tui",
        instanceId: "linux:108:start",
        instanceIdentity: "strong",
        ownership: "ambiguous",
      },
    ]);
    expect(spawnSync).toHaveBeenCalledWith("ps", ["-axo", "uid=,pid=,lstart=,command="], {
      encoding: "utf8",
      killSignal: "SIGKILL",
      timeout: 1_000,
    });
  });

  it("lists verified TUI processes on Windows", () => {
    const spawnSync = vi.fn().mockReturnValue({
      status: 0,
      stdout: JSON.stringify([
        { ProcessId: 101, CommandLine: "C:\\openclaw.exe tui", OwnerSid: "S-1", CurrentSid: "S-1" },
        {
          ProcessId: 102,
          CommandLine: "C:\\openclaw.exe gateway",
          OwnerSid: "S-1",
          CurrentSid: "S-1",
        },
        {
          ProcessId: 103,
          CommandLine: '"C:\\Program Files\\OpenClaw\\openclaw.exe" chat',
          OwnerSid: "S-1",
          CurrentSid: "S-1",
        },
        {
          ProcessId: 104,
          CommandLine:
            '"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\OpenClaw\\openclaw.mjs" terminal',
          OwnerSid: "S-1",
          CurrentSid: "S-1",
        },
        { ProcessId: 105, CommandLine: "C:\\openclaw.exe tui", OwnerSid: "S-2", CurrentSid: "S-1" },
        { ProcessId: 106, CommandLine: "C:\\openclaw.exe tui", OwnerSid: null, CurrentSid: "S-1" },
      ]),
    });
    vi.spyOn(fs.realpathSync, "native").mockImplementation((value) => String(value));

    expect(
      listLocalTuiProcesses({
        targetRoot: "C:\\Program Files\\OpenClaw",
        platform: "win32",
        currentPid: 999,
        spawnSync,
        readWindowsStartTime: () => 123,
      }),
    ).toEqual([
      {
        pid: 103,
        command: '"C:\\Program Files\\OpenClaw\\openclaw.exe" chat',
        instanceId: "123",
        instanceIdentity: "strong",
        ownership: "target",
      },
      {
        pid: 104,
        command:
          '"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\OpenClaw\\openclaw.mjs" terminal',
        instanceId: "123",
        instanceIdentity: "strong",
        ownership: "target",
      },
    ]);
    expect(spawnSync).toHaveBeenCalledOnce();
  });

  it("binds rewritten process titles to their installation", () => {
    const targetRoot = "/opt/openclaw";
    const otherRoot = "/opt/other-openclaw";
    vi.spyOn(fs.realpathSync, "native").mockImplementation((value) => String(value));
    const targetTitle = formatOpenClawProcessTitle("openclaw-tui", targetRoot);
    const otherTitle = formatOpenClawProcessTitle("openclaw-tui", otherRoot);
    const spawnSync = vi.fn().mockReturnValue({
      status: 0,
      stdout: [
        `501 101 Thu Aug 20 19:00:00 2026 ${targetTitle}`,
        `501 102 Thu Aug 20 19:00:00 2026 ${otherTitle}`,
        "501 103 Thu Aug 20 19:00:00 2026 openclaw-tui",
      ].join("\n"),
    });

    expect(
      listLocalTuiProcesses({
        targetRoot,
        platform: "linux",
        currentUid: 501,
        currentPid: 999,
        spawnSync,
        readPosixInstanceId: (pid) => `linux:${pid}:start`,
      }),
    ).toEqual([
      {
        pid: 101,
        command: targetTitle,
        instanceId: "linux:101:start",
        instanceIdentity: "strong",
        ownership: "target",
      },
      {
        pid: 103,
        command: "openclaw-tui",
        instanceId: "linux:103:start",
        instanceIdentity: "strong",
        ownership: "ambiguous",
      },
    ]);
  });

  it("preserves process discovery failure separately from an empty list", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 1, stdout: "" });

    expect(discoverLocalTuiProcesses({ platform: "linux", currentUid: 501, spawnSync })).toEqual({
      ok: false,
      error: "POSIX process discovery failed.",
    });
    expect(listLocalTuiProcesses({ platform: "linux", currentUid: 501, spawnSync })).toEqual([]);
  });

  it("terminates stale local TUI processes with a kill fallback", async () => {
    const alive = new Set([101]);
    const signals: Array<[number, string | number]> = [];
    const controller = {
      kill: vi.fn((pid: number, signal: string | number) => {
        signals.push([pid, signal]);
        if (signal === "SIGKILL") {
          alive.delete(pid);
          return true;
        }
        if (signal === 0) {
          if (alive.has(pid)) {
            return true;
          }
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        }
        return true;
      }),
    };

    await expect(
      terminateLocalTuiProcesses({
        processes: [
          { pid: 101, command: "openclaw-tui", instanceId: "start", ownership: "target" },
        ],
        targetRoot: "/target",
        controller,
        graceMs: 0,
        killGraceMs: 0,
        readCurrentProcess: () => ({
          pid: 101,
          command: "/target/openclaw tui",
          instanceId: "start",
          ownership: "target",
        }),
      }),
    ).resolves.toEqual({ stopped: [101], failed: [] });
    expect(signals).toEqual([
      [101, "SIGTERM"],
      [101, 0],
      [101, "SIGKILL"],
      [101, 0],
    ]);
  });

  it.runIf(process.platform === "linux")(
    "signals a live rewritten-title target without signaling another installation",
    async () =>
      withTestDir({ prefix: "local-tui-processes-live-" }, async (dir) => {
        const targetRoot = path.join(dir, "target");
        const otherRoot = path.join(dir, "other");
        fs.mkdirSync(targetRoot);
        fs.mkdirSync(otherRoot);
        const source = "process.title=process.argv[1];setInterval(()=>{},1000);";
        const target = spawn(
          process.execPath,
          ["-e", source, formatOpenClawProcessTitle("openclaw-tui", targetRoot)],
          { stdio: "ignore" },
        );
        const other = spawn(
          process.execPath,
          ["-e", source, formatOpenClawProcessTitle("openclaw-tui", otherRoot)],
          { stdio: "ignore" },
        );

        try {
          let discovered: ReturnType<typeof listLocalTuiProcesses> = [];
          await vi.waitFor(
            () => {
              discovered = listLocalTuiProcesses({ targetRoot });
              expect(discovered.map((entry) => entry.pid)).toEqual([target.pid]);
            },
            { timeout: 5_000, interval: 50 },
          );

          await expect(
            terminateLocalTuiProcesses({
              processes: discovered,
              targetRoot,
              graceMs: 100,
              killGraceMs: 100,
            }),
          ).resolves.toEqual({ stopped: [target.pid], failed: [] });
          expect(() => process.kill(other.pid!, 0)).not.toThrow();
        } finally {
          stopChild(target);
          stopChild(other);
        }
      }),
  );

  it.runIf(process.platform === "linux")(
    "does not send a real kill signal after update authority is revoked",
    async () =>
      withTestDir({ prefix: "local-tui-authority-live-" }, async (targetRoot) => {
        const title = formatOpenClawProcessTitle("openclaw-tui", targetRoot);
        const source =
          "process.title=process.argv[1];process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000);";
        const target = spawn(process.execPath, ["-e", source, title], {
          stdio: ["ignore", "pipe", "ignore"],
        });

        try {
          await new Promise<void>((resolve) => target.stdout!.once("data", () => resolve()));
          let discovered: LocalTuiProcess[] = [];
          await vi.waitFor(
            () => {
              discovered = listLocalTuiProcesses({ targetRoot });
              expect(discovered.map((entry) => entry.pid)).toEqual([target.pid]);
            },
            { timeout: 5_000, interval: 50 },
          );
          let assertions = 0;
          await expect(
            terminateLocalTuiProcesses({
              processes: discovered,
              targetRoot,
              graceMs: 50,
              killGraceMs: 50,
              assertCurrent: () => {
                assertions += 1;
                if (assertions > 1) {
                  throw new Error("requester revoked");
                }
              },
            }),
          ).rejects.toThrow("requester revoked");
          expect(() => process.kill(target.pid!, 0)).not.toThrow();
        } finally {
          stopChild(target);
        }
      }),
  );

  it("does not signal a target process without a kernel-backed instance identity", async () => {
    const controller = { kill: vi.fn(() => true) };

    await expect(
      terminateLocalTuiProcesses({
        processes: [{ pid: 101, command: "/target/openclaw tui", ownership: "target" }],
        targetRoot: "/target",
        controller,
        graceMs: 0,
        killGraceMs: 0,
        readCurrentProcess: () => ({
          pid: 101,
          command: "/target/openclaw tui",
          ownership: "target",
        }),
      }),
    ).resolves.toEqual({ stopped: [], failed: [101] });
    expect(controller.kill).not.toHaveBeenCalled();
  });

  it("does not signal a macOS process with a coarse identity", async () => {
    const controller = { kill: vi.fn(() => true) };
    const process = {
      pid: 101,
      command: "/target/openclaw tui",
      instanceId: "Thu Aug 20 19:00:00 2026",
      instanceIdentity: "coarse" as const,
      ownership: "target" as const,
    };

    await expect(
      terminateLocalTuiProcesses({
        processes: [process],
        targetRoot: "/target",
        controller,
        graceMs: 0,
        killGraceMs: 0,
        readCurrentProcess: () => process,
      }),
    ).resolves.toEqual({ stopped: [], failed: [101] });
    expect(controller.kill).not.toHaveBeenCalled();
  });

  it("reports local TUI processes that survive the kill fallback", async () => {
    const controller = {
      kill: vi.fn(() => true),
    };

    await expect(
      terminateLocalTuiProcesses({
        processes: [
          { pid: 101, command: "openclaw-tui", instanceId: "start", ownership: "target" },
        ],
        targetRoot: "/target",
        controller,
        graceMs: 0,
        killGraceMs: 0,
        readCurrentProcess: () => ({
          pid: 101,
          command: "/target/openclaw tui",
          instanceId: "start",
          ownership: "target",
        }),
      }),
    ).resolves.toEqual({ stopped: [], failed: [101] });
  });

  it("fails closed when a live process identity can no longer be read", async () => {
    const controller = { kill: vi.fn(() => true) };
    let reads = 0;

    await expect(
      terminateLocalTuiProcesses({
        processes: [
          { pid: 101, command: "openclaw-tui", instanceId: "start", ownership: "target" },
        ],
        targetRoot: "/target",
        controller,
        graceMs: 0,
        killGraceMs: 0,
        readCurrentProcess: () =>
          ++reads === 1
            ? {
                pid: 101,
                command: "/target/openclaw tui",
                instanceId: "start",
                ownership: "target",
              }
            : undefined,
      }),
    ).resolves.toEqual({ stopped: [], failed: [101] });
    expect(controller.kill).not.toHaveBeenCalledWith(101, "SIGKILL");
  });

  it("revalidates target ownership immediately before the kill fallback", async () => {
    const controller = { kill: vi.fn(() => true) };
    const readCurrentProcess = vi
      .fn()
      .mockReturnValueOnce({
        pid: 101,
        command: "/target/openclaw tui",
        instanceId: "start",
        ownership: "target",
      })
      .mockReturnValueOnce({
        pid: 101,
        command: "openclaw tui",
        instanceId: "start",
        ownership: "ambiguous",
      });

    await expect(
      terminateLocalTuiProcesses({
        processes: [
          { pid: 101, command: "/target/openclaw tui", instanceId: "start", ownership: "target" },
        ],
        targetRoot: "/target",
        controller,
        graceMs: 0,
        killGraceMs: 0,
        readCurrentProcess,
      }),
    ).resolves.toEqual({ stopped: [], failed: [101] });
    expect(controller.kill).toHaveBeenCalledWith(101, "SIGTERM");
    expect(controller.kill).not.toHaveBeenCalledWith(101, "SIGKILL");
  });

  it("revalidates update authority immediately before kill escalation", async () => {
    const controller = { kill: vi.fn(() => true) };
    const assertCurrent = vi
      .fn()
      .mockReturnValueOnce(undefined)
      .mockImplementationOnce(() => {
        throw new Error("requester revoked");
      });

    await expect(
      terminateLocalTuiProcesses({
        processes: [
          { pid: 101, command: "/target/openclaw tui", instanceId: "start", ownership: "target" },
        ],
        targetRoot: "/target",
        controller,
        graceMs: 0,
        killGraceMs: 0,
        assertCurrent,
        readCurrentProcess: () => ({
          pid: 101,
          command: "/target/openclaw tui",
          instanceId: "start",
          ownership: "target",
        }),
      }),
    ).rejects.toThrow("requester revoked");
    expect(controller.kill).toHaveBeenCalledWith(101, "SIGTERM");
    expect(controller.kill).not.toHaveBeenCalledWith(101, "SIGKILL");
  });

  it("refuses shared update mutation when a matched client survives", async () => {
    const processes = [{ pid: 101, command: "/target/openclaw tui", ownership: "target" as const }];

    await expect(
      quiesceLocalTuiProcessesBeforeUpdate("/target", {
        list: () => processes,
        terminate: async () => ({ stopped: [], failed: [101] }),
      }),
    ).rejects.toThrow(
      "Update refused: could not stop local TUI clients 101. Close them and retry the update.",
    );
  });

  it("releases the gate without discovery or signaling when authority expires in contention", async () => {
    const release = vi.fn(async () => {});
    const discover = vi.fn();
    const terminate = vi.fn();

    await expect(
      quiesceLocalTuiProcessesBeforeUpdate("/target", {
        acquireLock: vi.fn(async () => ({ lockPath: "test", release })),
        assertCurrent: () => {
          throw new Error("requester revoked");
        },
        discover,
        terminate,
      }),
    ).rejects.toThrow("requester revoked");
    expect(release).toHaveBeenCalledOnce();
    expect(discover).not.toHaveBeenCalled();
    expect(terminate).not.toHaveBeenCalled();
  });

  it("fails closed and releases the gate when process discovery fails", async () => {
    const release = vi.fn(async () => {});

    await expect(
      quiesceLocalTuiProcessesBeforeUpdate("/target", {
        acquireLock: vi.fn(async () => ({ lockPath: "test", release })),
        discover: () => ({ ok: false, error: "fixture probe failed." }),
      }),
    ).rejects.toThrow("could not inspect local TUI clients. fixture probe failed");
    expect(release).toHaveBeenCalledOnce();
  });

  it("holds the startup gate after discovery until the update owner releases it", async () => {
    const release = vi.fn(async () => {});
    const lock = await quiesceLocalTuiProcessesBeforeUpdate("/target", {
      list: () => [],
      acquireLock: vi.fn(async () => ({ lockPath: "test", release })),
    });

    expect(release).not.toHaveBeenCalled();
    expect(lock?.stopped).toEqual([]);
    await lock?.release();
    expect(release).toHaveBeenCalledOnce();
  });

  it("uses the same update gate for profiles targeting one installation", async () => {
    const lockPaths: string[] = [];
    const acquireLock = vi.fn(async (lockPath: string) => {
      lockPaths.push(lockPath);
      return { lockPath, release: async () => {} };
    });
    vi.spyOn(fs.realpathSync, "native").mockReturnValue("/canonical/openclaw");

    const first = await quiesceLocalTuiProcessesBeforeUpdate("/profile-a/openclaw", {
      list: () => [],
      acquireLock,
    });
    await first?.release();
    const second = await quiesceLocalTuiProcessesBeforeUpdate("/profile-b/openclaw", {
      list: () => [],
      acquireLock,
    });
    await second?.release();

    expect(lockPaths).toHaveLength(2);
    expect(lockPaths[0]).toBe(lockPaths[1]);
  });

  it("rechecks authority after waiting on the real installation gate", async () => {
    await withTestDir({ prefix: "local-tui-gate-authority-" }, async (targetRoot) => {
      const first = await quiesceLocalTuiProcessesBeforeUpdate(targetRoot, { list: () => [] });
      let current = true;
      const contending = quiesceLocalTuiProcessesBeforeUpdate(targetRoot, {
        list: () => [],
        assertCurrent: () => {
          if (!current) {
            throw new Error("requester revoked");
          }
        },
      });

      current = false;
      await first?.release();
      await expect(contending).rejects.toThrow("requester revoked");
    });
  });

  it("returns stopped clients to the update owner", async () => {
    const release = vi.fn(async () => {});
    const gate = await quiesceLocalTuiProcessesBeforeUpdate("/target", {
      list: () => [{ pid: 101, command: "/target/openclaw tui", ownership: "target" }],
      terminate: async () => ({ stopped: [101], failed: [] }),
      acquireLock: vi.fn(async () => ({ lockPath: "test", release })),
    });

    expect(gate?.stopped).toEqual([101]);
    await gate?.release();
  });

  it("refuses mutation before signaling an ambiguous TUI", async () => {
    const terminate = vi.fn();
    await expect(
      quiesceLocalTuiProcessesBeforeUpdate("/target", {
        list: () => [{ pid: 101, command: "openclaw tui", ownership: "ambiguous" }],
        terminate,
      }),
    ).rejects.toThrow("could not bind local TUI clients 101 to this installation");
    expect(terminate).not.toHaveBeenCalled();
  });

  it("waits for the update gate before TUI startup", async () => {
    const release = vi.fn(async () => {});
    await waitForLocalTuiUpdate(
      "/target",
      vi.fn(async () => ({ lockPath: "test", release })),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps waiting after the bounded lock attempt while an update is still running", async () => {
    const release = vi.fn(async () => {});
    const timeout = Object.assign(new Error("busy"), { code: "file_lock_timeout" });
    const acquireLock = vi
      .fn()
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce({ lockPath: "test", release });

    await waitForLocalTuiUpdate("/target", acquireLock);

    expect(acquireLock).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledOnce();
  });
});
