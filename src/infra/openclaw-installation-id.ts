import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const INSTALLATION_ID_LENGTH = 16;
const PROCESS_TITLE_PATTERN = /^(openclaw(?:-[a-z0-9-]+)?)@([a-f0-9]{16})$/u;

export function createOpenClawInstallationId(canonicalRoot: string): string {
  return createHash("sha256").update(canonicalRoot).digest("hex").slice(0, INSTALLATION_ID_LENGTH);
}

export function resolveOpenClawInstallationId(root: string): string {
  let canonicalRoot: string;
  try {
    canonicalRoot = fs.realpathSync.native(root);
  } catch {
    canonicalRoot = path.resolve(root);
  }
  return createOpenClawInstallationId(canonicalRoot);
}

export function formatOpenClawProcessTitle(name: string, installRoot: string): string {
  return `${name}@${resolveOpenClawInstallationId(installRoot)}`;
}

export function parseOpenClawProcessTitle(
  title: string,
): { name: string; installationId: string } | undefined {
  const match = PROCESS_TITLE_PATTERN.exec(title);
  return match ? { name: match[1]!, installationId: match[2]! } : undefined;
}

export function replaceOpenClawProcessTitleName(title: string, name: string): string {
  const parsed = parseOpenClawProcessTitle(title);
  return parsed ? `${name}@${parsed.installationId}` : name;
}
