import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";

const fixture = vi.hoisted(() => ({
  root: "",
  alive: true,
  execFileSync: vi.fn(),
  spawn: vi.fn(),
  portProbe: vi.fn(),
  diagnose: vi.fn(),
}));
vi.mock("../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils.js")>()),
  get CONFIG_DIR() {
    return fixture.root;
  },
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: fixture.execFileSync,
  spawn: fixture.spawn,
}));
vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>()),
  isPidAlive: (pid: number) => pid === 4321 && fixture.alive,
  getFileLockProcessStartTime: () => 123,
}));

vi.mock("./paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./paths.js")>()),
  get DEFAULT_DOWNLOAD_DIR() {
    return path.join(fixture.root, "downloads");
  },
}));
vi.mock("../infra/ports.js", () => ({ ensurePortAvailable: fixture.portProbe }));
vi.mock("./chrome.diagnostics.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chrome.diagnostics.js")>()),
  diagnoseChromeCdp: fixture.diagnose,
}));

import { resolveBrowserExecutableForPlatform } from "./chrome.executables.js";
import {
  launchOpenClawChrome,
  resolveOpenClawUserDataDir,
  stopOwnedOpenClawChrome,
} from "./chrome.js";
import { resolveBrowserConfig, resolveProfile } from "./config.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  fixture.root = tempDirs.make("openclaw-headless-cleanup-");
  fixture.alive = true;
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("CDP is unavailable")));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fixture.execFileSync.mockReset();
  fixture.spawn.mockReset();
  fixture.portProbe.mockReset();
  fixture.diagnose.mockReset();
});

function setupOwnedBrowser(
  mode: "explicit" | "cache",
  ownsProfile: boolean,
  configuredHeadless = false,
) {
  const cache = path.join(fixture.root, "browsers");
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const shell = path.join(
    cache,
    "chromium_headless_shell-100",
    `chrome-headless-shell-mac-${arch}`,
    "chrome-headless-shell",
  );
  const chrome = path.join(
    cache,
    "chromium-100",
    `chrome-mac-${arch}`,
    "Google Chrome for Testing.app",
    "Contents",
    "MacOS",
    "Google Chrome for Testing",
  );
  for (const executable of [shell, chrome]) {
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, "", { mode: 0o755 });
  }
  vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", cache);
  const statSync = fs.statSync.bind(fs);
  vi.spyOn(fs, "statSync").mockImplementation((candidate) => {
    if (!String(candidate).startsWith(fixture.root)) {
      throw new Error("ENOENT");
    }
    return statSync(candidate);
  });
  const existsSync = fs.existsSync.bind(fs);
  vi.spyOn(fs, "existsSync").mockImplementation(
    (candidate) => String(candidate).startsWith(fixture.root) && existsSync(candidate),
  );
  const resolved = resolveBrowserConfig({
    headless: configuredHeadless,
    ...(mode === "explicit" ? { executablePath: shell } : {}),
  });
  const profile = resolveProfile(resolved, "openclaw")!;
  const userDataDir = resolveOpenClawUserDataDir(profile.name);
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.symlinkSync(`${os.hostname()}-4321`, path.join(userDataDir, "SingletonLock"));
  fixture.execFileSync.mockImplementation((command: string) => {
    if (command === "ps") {
      return `${configuredHeadless ? chrome : shell} --remote-debugging-port=${profile.cdpPort} --user-data-dir=${userDataDir}${ownsProfile ? "" : "-other"} --headless=new`;
    }
    return command === "lsof" ? "p4321\n" : "";
  });
  const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    expect(pid).toBe(4321);
    expect(signal).toBe("SIGTERM");
    fixture.alive = false;
    return true;
  });
  return { resolved, profile, kill, chrome, shell };
}

it.each([
  { mode: "explicit", ownsProfile: true },
  { mode: "cache", ownsProfile: true },
  { mode: "explicit", ownsProfile: false },
  { mode: "cache", ownsProfile: false },
] as const)(
  "cleans up a one-shot $mode shell only when ownsProfile=$ownsProfile",
  async ({ mode, ownsProfile }) => {
    const { resolved, profile, kill, chrome, shell } = setupOwnedBrowser(mode, ownsProfile);
    expect(resolveBrowserExecutableForPlatform(resolved, "darwin")?.path).toBe(
      mode === "cache" ? chrome : shell,
    );
    await expect(stopOwnedOpenClawChrome(resolved, profile, 100)).resolves.toMatchObject({
      status: ownsProfile ? "stopped" : "unverified",
    });
    expect(kill).toHaveBeenCalledTimes(ownsProfile ? 1 : 0);
  },
);

it.each([
  {
    configuredHeadless: false,
    ownsProfile: true,
    code: "websocket_health_command_timeout",
    recovers: true,
  },
  {
    configuredHeadless: true,
    ownsProfile: true,
    code: "websocket_health_command_timeout",
    recovers: true,
  },
  {
    configuredHeadless: false,
    ownsProfile: false,
    code: "websocket_health_command_timeout",
    recovers: false,
  },
  {
    configuredHeadless: false,
    ownsProfile: true,
    code: "websocket_health_command_failed",
    recovers: false,
  },
])(
  "recovers stale cache browser with configuredHeadless=$configuredHeadless, ownsProfile=$ownsProfile, code=$code",
  async ({ configuredHeadless, ownsProfile, code, recovers }) => {
    const { resolved, profile, kill, shell } = setupOwnedBrowser(
      "cache",
      ownsProfile,
      configuredHeadless,
    );
    const portBusy = Object.assign(new Error("Port is already in use."), {
      name: "PortInUseError",
    });
    fixture.portProbe.mockRejectedValueOnce(portBusy).mockResolvedValue(undefined);
    fixture.diagnose.mockResolvedValue({ ok: false, code, cdpUrl: profile.cdpUrl });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ Browser: "Chrome/Test" }))),
    );
    const proc = Object.assign(new EventEmitter(), {
      pid: 5432,
      exitCode: null,
      signalCode: null,
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    fixture.spawn.mockReturnValue(proc);
    const launch = launchOpenClawChrome(resolved, profile, {
      headlessOverride: true,
      platform: "darwin",
      env: {},
    });
    if (recovers) {
      await expect(launch).resolves.toMatchObject({ exe: { path: shell }, proc });
      expect(fixture.portProbe).toHaveBeenCalledTimes(2);
      expect(fixture.spawn).toHaveBeenCalledTimes(1);
    } else {
      await expect(launch).rejects.toBe(portBusy);
      expect(fixture.spawn).not.toHaveBeenCalled();
    }
    expect(kill).toHaveBeenCalledTimes(recovers ? 1 : 0);
  },
);
