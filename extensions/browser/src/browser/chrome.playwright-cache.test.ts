import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import {
  resolveBrowserExecutableForPlatform,
  resolveGoogleChromeExecutableForPlatform,
} from "./chrome.executables.js";
import { findPlaywrightChromiumExecutable } from "./chrome.playwright-cache.js";
import { resolveBrowserConfig } from "./config.js";

vi.mock("./chrome.executable-probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chrome.executable-probe.js")>()),
  execBrowserProbe: () => null,
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  {
    platform: "linux",
    arch: "x64",
    suffix: ["chrome-headless-shell-linux64", "chrome-headless-shell"],
  },
  {
    platform: "linux",
    arch: "arm64",
    suffix: ["chrome-headless-shell-linux-arm64", "chrome-headless-shell"],
  },
  {
    platform: "darwin",
    arch: "x64",
    suffix: ["chrome-headless-shell-mac-x64", "chrome-headless-shell"],
  },
  {
    platform: "darwin",
    arch: "arm64",
    suffix: ["chrome-headless-shell-mac-arm64", "chrome-headless-shell"],
  },
  {
    platform: "win32",
    arch: "x64",
    suffix: ["chrome-headless-shell-win64", "chrome-headless-shell.exe"],
  },
] as const)(
  "discovers shell-only $platform/$arch installs only where process ownership is supported",
  ({ platform, arch, suffix }) => {
    const cache = platform === "win32" ? "C:\\browsers" : "/browsers";
    const join = platform === "win32" ? path.win32.join : path.join;
    const executablePath = join(cache, "chromium_headless_shell-100", ...suffix);
    let installedExecutable = executablePath;
    vi.spyOn(process, "arch", "get").mockReturnValue(arch);
    vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", cache);
    vi.spyOn(fs, "readdirSync").mockReturnValue([
      "chromium_headless_shell-100",
      "chromium-100",
    ] as never);
    vi.spyOn(fs, "statSync").mockImplementation((candidate) => {
      if (String(candidate) !== installedExecutable) {
        throw new Error("ENOENT");
      }
      return { isFile: () => true } as fs.Stats;
    });
    vi.spyOn(fs, "accessSync").mockImplementation(() => {});
    expect(resolveBrowserExecutableForPlatform(resolveBrowserConfig({}), platform)).toEqual(
      platform === "win32" ? null : { kind: "chromium", path: executablePath },
    );
    expect(findPlaywrightChromiumExecutable(platform, false)).toBeNull();
    expect(resolveGoogleChromeExecutableForPlatform(platform)).toBeNull();
    if (platform === "win32") {
      installedExecutable = join(cache, "chromium-100", "chrome-win64", "chrome.exe");
      for (const headless of [false, true]) {
        expect(findPlaywrightChromiumExecutable(platform, headless)).toEqual({
          kind: "chromium",
          path: installedExecutable,
        });
      }
    }
  },
);

it("skips incomplete cache entries and chooses the newest executable revision", () => {
  const cache = tempDirs.make("openclaw-browser-cache-");
  vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", cache);
  for (const revision of ["99", "100", "101"]) {
    const directory = path.join(
      cache,
      `chromium_headless_shell-${revision}`,
      `chrome-headless-shell-${process.arch === "arm64" ? "linux-arm64" : "linux64"}`,
    );
    fs.mkdirSync(directory, { recursive: true });
    if (revision !== "101") {
      fs.writeFileSync(path.join(directory, "chrome-headless-shell"), "", { mode: 0o755 });
    }
  }
  expect(findPlaywrightChromiumExecutable("linux", true)?.path).toContain(
    "chromium_headless_shell-100",
  );
  const installed = path.join(cache, "explicit-chrome");
  fs.writeFileSync(installed, "");
  expect(
    resolveBrowserExecutableForPlatform(
      resolveBrowserConfig({ executablePath: installed }),
      "linux",
    ),
  ).toEqual({ kind: "custom", path: installed });
});

it("finds the macOS default cache without a configured browser path", () => {
  vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", "");
  vi.spyOn(os, "homedir").mockReturnValue("/Users/test");
  const read = vi.spyOn(fs, "readdirSync").mockReturnValue([] as never);
  expect(findPlaywrightChromiumExecutable("darwin", true)).toBeNull();
  expect(read).toHaveBeenCalledWith("/Users/test/Library/Caches/ms-playwright");
});

it("keeps explicit shell identity discoverable independently of configured launch mode", () => {
  vi.spyOn(fs, "existsSync").mockReturnValue(true);
  expect(
    resolveBrowserExecutableForPlatform(
      resolveBrowserConfig({
        executablePath: "/browsers/chrome-headless-shell",
        headless: false,
      }),
      "linux",
    ),
  ).toEqual({ kind: "custom", path: "/browsers/chrome-headless-shell" });
});
