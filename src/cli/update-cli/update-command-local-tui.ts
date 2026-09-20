import { quiesceLocalTuiProcessesBeforeUpdate } from "../../infra/local-tui-processes.js";
import { defaultRuntime } from "../../runtime.js";

/** Acquires the installation gate and returns its transaction-lifetime cleanup. */
export async function acquireUpdateLocalTuiGate(
  root: string,
  jsonMode: boolean,
  assertCurrent: () => void,
): Promise<() => Promise<void>> {
  const gate = await quiesceLocalTuiProcessesBeforeUpdate(root, { assertCurrent });
  if (!jsonMode && gate?.stopped.length) {
    defaultRuntime.log(
      `Stopped local TUI clients before replacing runtime files: ${gate.stopped.join(", ")}`,
    );
  }
  return async () => await gate?.release();
}
