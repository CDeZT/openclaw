import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayEventLoopHealth } from "../gateway/server/event-loop-health.js";

const noteMock = vi.hoisted(() => vi.fn());

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: noteMock }));

const { collectWhatsappResponsivenessHealthFindings, noteWhatsappResponsivenessHealth } =
  await import("./doctor-whatsapp-responsiveness.js");

const cfg: OpenClawConfig = { channels: { whatsapp: { enabled: true } } };
const cpuPressure: GatewayEventLoopHealth = {
  degraded: true,
  degradedSinceMs: 0,
  reasons: ["cpu"],
  intervalMs: 1_000,
  delayP99Ms: 40,
  delayMaxMs: 40,
  utilization: 0.04,
  cpuCoreRatio: 2,
};
const localTuis = () => [
  { pid: 101, command: "openclaw-tui --profile another-profile", ownership: "ambiguous" as const },
];

describe("doctor WhatsApp responsiveness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each<GatewayEventLoopHealth>([
    cpuPressure,
    { ...cpuPressure, reasons: ["event_loop_delay"], delayMaxMs: 1_200, cpuCoreRatio: 0.2 },
    { ...cpuPressure, reasons: ["event_loop_utilization"], utilization: 0.98, cpuCoreRatio: 0.2 },
  ])("keeps $reasons advice factual and shared with the note", (eventLoop) => {
    const params = { cfg, status: { eventLoop }, listLocalTuiProcesses: localTuis };
    const findings = collectWhatsappResponsivenessHealthFindings(params);
    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/whatsapp-responsiveness",
        severity: "warning",
        path: "channels.whatsapp",
        target: "101",
        requirement: "local-tui-event-loop-pressure",
        message:
          "Gateway reports pressure, and local TUI clients were detected. This snapshot does not identify the source of the pressure.",
        fixHint:
          "Inspect Gateway diagnostics with openclaw gateway diagnostics export before deciding whether to close clients.",
      }),
    ]);
    noteWhatsappResponsivenessHealth(params);
    expect(noteMock).toHaveBeenCalledWith(
      [findings[0]?.message, "Local TUI pids: 101", findings[0]?.fixHint].join("\n"),
      "WhatsApp responsiveness",
    );
  });

  it.each([
    { name: "missing status during maintenance", cfg, status: undefined, tuis: localTuis },
    {
      name: "healthy Gateway",
      cfg,
      status: { eventLoop: { ...cpuPressure, degraded: false, reasons: [] } },
      tuis: localTuis,
    },
    {
      name: "WhatsApp disabled",
      cfg: { channels: { whatsapp: { enabled: false } } },
      status: { eventLoop: cpuPressure },
      tuis: localTuis,
    },
    { name: "no local TUI", cfg, status: { eventLoop: cpuPressure }, tuis: () => [] },
  ])("stays quiet with $name", ({ cfg: caseConfig, status, tuis }) => {
    const params = { cfg: caseConfig, status, listLocalTuiProcesses: tuis };
    expect(collectWhatsappResponsivenessHealthFindings(params)).toEqual([]);
    noteWhatsappResponsivenessHealth(params);
    expect(noteMock).not.toHaveBeenCalled();
  });
});
