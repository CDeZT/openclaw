import { waitForLocalTuiUpdate } from "../infra/local-tui-processes.js";
import { replaceOpenClawProcessTitleName } from "../infra/openclaw-installation-id.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";

/** Loads the TUI graph only after this installation is no longer being replaced. */
export async function loadTuiAfterUpdateGate(
  deps: {
    resolveRoot?: typeof resolveOpenClawPackageRootSync;
    wait?: typeof waitForLocalTuiUpdate;
    load?: () => Promise<typeof import("./tui.js")>;
  } = {},
): Promise<typeof import("./tui.js")> {
  // Bare-root and resume paths do not pass through the `tui` Commander action.
  // Mark them before waiting so a contending updater can bind and stop this client.
  process.title = replaceOpenClawProcessTitleName(process.title, "openclaw-tui");
  const targetRoot = (deps.resolveRoot ?? resolveOpenClawPackageRootSync)({
    argv1: process.argv[1],
    moduleUrl: import.meta.url,
  });
  if (!targetRoot) {
    throw new Error("Unable to identify this OpenClaw installation before TUI startup.");
  }
  await (deps.wait ?? waitForLocalTuiUpdate)(targetRoot);
  return await (deps.load ?? (async () => await import("./tui.js")))();
}

export async function runTuiAfterUpdateGate(
  options: Parameters<typeof import("./tui.js").runTui>[0],
): Promise<void> {
  const { runTui } = await loadTuiAfterUpdateGate();
  await runTui(options);
}
