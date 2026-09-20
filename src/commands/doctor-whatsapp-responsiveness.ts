/** Doctor observations for Gateway pressure and local TUI clients. */
import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import {
  formatLocalTuiPidList,
  listLocalTuiProcesses,
  type LocalTuiProcess,
} from "../infra/local-tui-processes.js";
import type { StatusSummary } from "../status/summary.js";

const WHATSAPP_RESPONSIVENESS_CHECK_ID = "core/doctor/whatsapp-responsiveness";

function hasWhatsappEnabled(cfg: OpenClawConfig): boolean {
  const whatsapp = cfg.channels?.whatsapp;
  if (!whatsapp || whatsapp.enabled === false) {
    return false;
  }
  const accounts = whatsapp.accounts;
  if (accounts && Object.keys(accounts).length > 0) {
    return Object.values(accounts).some((account) => account?.enabled !== false);
  }
  return true;
}

/** Collects read-only structured findings for WhatsApp responsiveness pressure. */
export function collectWhatsappResponsivenessHealthFindings(params: {
  cfg: OpenClawConfig;
  status?: Pick<StatusSummary, "eventLoop"> | null;
  listLocalTuiProcesses?: () => LocalTuiProcess[];
}): readonly HealthFinding[] {
  if (!hasWhatsappEnabled(params.cfg)) {
    return [];
  }

  const eventLoop = params.status?.eventLoop;
  if (eventLoop?.degraded !== true) {
    return [];
  }

  const tuiProcesses = (params.listLocalTuiProcesses ?? listLocalTuiProcesses)();
  if (tuiProcesses.length === 0) {
    return [];
  }

  const pids = formatLocalTuiPidList(tuiProcesses);
  return [
    {
      checkId: WHATSAPP_RESPONSIVENESS_CHECK_ID,
      severity: "warning",
      message:
        "Gateway reports pressure, and local TUI clients were detected. This snapshot does not identify the source of the pressure.",
      path: "channels.whatsapp",
      target: pids,
      requirement: "local-tui-event-loop-pressure",
      fixHint: `Inspect Gateway diagnostics with ${formatCliCommand(
        "openclaw gateway diagnostics export",
      )} before deciding whether to close clients.`,
    },
  ];
}

/** Renders the same advisory observations as the opt-in health check. */
export function noteWhatsappResponsivenessHealth(
  params: Parameters<typeof collectWhatsappResponsivenessHealthFindings>[0],
): void {
  const findings = collectWhatsappResponsivenessHealthFindings(params);
  if (findings.length > 0) {
    note(
      findings
        .map((finding) =>
          [finding.message, `Local TUI pids: ${finding.target}`, finding.fixHint].join("\n"),
        )
        .join("\n\n"),
      "WhatsApp responsiveness",
    );
  }
}
