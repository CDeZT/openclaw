import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeNodeTestGroups } from "../../scripts/lib/ci-node-test-groups-codec.mts";
import type { CiTimingRun } from "../../scripts/lib/ci-test-timings-refit.mts";
import type { CiTestTimings } from "../../scripts/lib/ci-test-timings-schema.mts";

export function timingRun(id: number, logs: CiTimingRun["logs"]): CiTimingRun {
  return { id, createdAt: `2026-08-${String(20 + id).padStart(2, "0")}T23:00:00Z`, logs };
}

export function compactLog(seconds: number, key = "core-unit-src-security-2") {
  const end = new Date(Date.parse("2026-08-27T23:00:00Z") + seconds * 1000).toISOString();
  return [
    `2026-08-27T23:00:00.0000000Z [shard:${key}] begin`,
    `${end} [shard:${key}] end (exit 0)`,
    "2026-08-27T23:00:00Z [shard:failed] begin",
    `${end} [shard:failed] end (exit 1)`,
    "2026-08-27T23:00:00Z [shard:unfinished] begin",
    `${end} [shard:orphan] end (exit 0)`,
  ].join("\n");
}

export const measuredFile = "ui/src/e2e/measured.e2e.test.ts";
export const baseline: CiTestTimings = {
  compactGroupSeconds: { blacksmith: {}, github: {} },
  compactWorkerTimings: [],
  runtimePlacementTimings: { blacksmith: [], github: [] },
  repoE2eFileSeconds: {},
  source: "median of 2 successful main CI runs: 1, 2",
  toolingFileSeconds: { blacksmith: {}, github: {} },
  uiE2e: { fileSeconds: { [measuredFile]: 100 }, perFileOverheadSeconds: 0.6 },
  updatedAt: "2026-08-22",
  version: 1,
};

export const sampleNow = "2026-08-28T12:00:00.000Z";

export function workerResources({
  cpuCount = 2,
  workers = 2,
  memoryGiB = 8,
  planConcurrency = 1,
  runnerEnvironment = "self-hosted",
  frozenTarget = "false",
} = {}) {
  return [
    `2026-08-27T23:00:00Z detected cores=${cpuCount} plan_concurrency=${planConcurrency} predicted_test_seconds=100 -> workers=${workers}`,
    `2026-08-27T23:00:00Z [shard:resources] logicalCpuCount=${cpuCount} totalMemoryBytes=${memoryGiB * 1024 ** 3} requested plans=${planConcurrency} admitted plans=${planConcurrency}`,
    `2026-08-27T23:00:00Z RUNNER_ENVIRONMENT: ${runnerEnvironment}`,
    `2026-08-27T23:00:00Z FROZEN_TARGET: ${frozenTarget}`,
  ].join("\n");
}

export const workerGroup = {
  shard_name: "agentic-commands-hosted-1",
  configs: ["test/vitest/vitest.commands.config.ts"],
  includePatterns: ["src/commands/a.test.ts", "src/commands/b.test.ts"],
  env: { FEATURE: "1" },
};

export function workerLog(
  seconds: number,
  resources: Parameters<typeof workerResources>[0] = {},
  group: Omit<typeof workerGroup, "env"> & {
    env: Record<string, string>;
    timing_key?: string;
    fallbackMaxWorkers?: number;
    minTotalMemoryBytes?: number;
  } = workerGroup,
) {
  return [
    workerResources(resources),
    `2026-08-27T23:00:00Z OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: ${encodeNodeTestGroups([group])}`,
    compactLog(seconds, group.timing_key ?? group.shard_name),
  ].join("\n");
}

export function samplerRun(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    path: ".github/workflows/ci.yml",
    run_attempt: 1,
    created_at: "2026-08-27T22:00:00Z",
    status: "completed",
    conclusion: "success",
    event: "push",
    head_branch: "main",
    head_sha: "a".repeat(40),
    ...overrides,
  };
}

export function samplerJob(id: number, runId: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    run_id: runId,
    run_attempt: 1,
    head_sha: "a".repeat(40),
    name: "checks-node-compact-small (1)",
    status: "completed",
    conclusion: "success",
    labels: ["blacksmith-4vcpu-ubuntu-2404"],
    started_at: "2026-08-27T23:00:00Z",
    completed_at: "2026-08-27T23:10:00Z",
    log: compactLog(20),
    ...overrides,
  };
}

export const toolingFile = "test/scripts/measured.test.ts";

export function samplerToolingLog(seconds: number) {
  const shard = "core-tooling-1-hosted-1";
  const [begin, end] = compactLog(seconds + 1, shard).split("\n");
  return [
    `2026-08-27T23:00:00Z OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: ${encodeNodeTestGroups([{ shard_name: shard, configs: ["test/vitest/vitest.tooling.config.ts"], includePatterns: [toolingFile] }])}`,
    begin,
    `2026-08-27T23:00:01Z [shard:${shard}] ✓ tooling ${toolingFile} (1 test) ${seconds * 1000}ms`,
    `2026-08-27T23:00:01Z [shard:${shard}] Duration ${seconds + 1}s`,
    end,
  ].join("\n");
}

type SamplerFixture = {
  runs: ReturnType<typeof samplerRun>[];
  jobs: ReturnType<typeof samplerJob>[];
  releaseRuns?: ReturnType<typeof samplerRun>[];
  toolingRuns?: ReturnType<typeof samplerRun>[];
  seedRuns?: Record<string, ReturnType<typeof samplerRun>>;
  runPages?: ReturnType<typeof samplerRun>[][];
  jobPages?: Record<string, ReturnType<typeof samplerJob>[][]>;
  jobTotals?: Record<string, number>;
  baseline?: CiTestTimings;
};

export function withSamplerFixture(
  fixture: SamplerFixture,
  check: (context: {
    invoke: (
      dryRun?: boolean,
      count?: number,
      toolingRunIds?: number[],
    ) => SpawnSyncReturns<string>;
    contents: () => string;
    requests: () => string[][];
    original: string;
  }) => void,
) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "openclaw-ci-refit-")));
  const fakeGh = path.join(directory, "gh");
  const output = path.join(directory, "timings.json");
  const requests = path.join(directory, "requests.jsonl");
  const clock = path.join(directory, "clock.cjs");
  const original = `${JSON.stringify(fixture.baseline ?? baseline, null, 2)}\n`;
  try {
    writeFileSync(output, original);
    writeFileSync(requests, "");
    writeFileSync(
      clock,
      `const OriginalDate = Date;
global.Date = class extends OriginalDate {
  constructor(...args) { super(...(args.length ? args : [${JSON.stringify(sampleNow)}])); }
  static now() { return OriginalDate.parse(${JSON.stringify(sampleNow)}); }
};\n`,
    );
    writeFileSync(
      fakeGh,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify(args) + "\\n");
const fixture = ${JSON.stringify(fixture)};
const endpoint = new URL(args[1], "https://api.github.com/");
const page = Number(endpoint.searchParams.get("page") || 1);
const size = Number(endpoint.searchParams.get("per_page") || 100);
const slice = rows => rows.slice((page - 1) * size, page * size);
if (args[1] === "--help") {
  console.log("--allow-escape-sequences");
} else if (endpoint.pathname.includes("/workflows/")) {
  const ci = endpoint.pathname.includes("/ci.yml/");
  const tooling = ci && endpoint.searchParams.get("event") === "pull_request";
  const main = ci && !tooling;
  const rows = tooling ? fixture.toolingRuns || [] : main ? fixture.runs : endpoint.pathname.includes("/openclaw-release-checks.yml/") ? fixture.releaseRuns || [] : [];
  const selected = main && fixture.runPages ? fixture.runPages[page - 1] || [] : slice(rows);
  console.log(JSON.stringify(args.at(-1).startsWith("[.workflow_runs") ? selected : {total_count: rows.length, workflow_runs: selected}));
} else if (endpoint.pathname.endsWith("/jobs")) {
  const match = endpoint.pathname.match(/\\/runs\\/(\\d+)(?:\\/attempts\\/(\\d+))?\\/jobs$/);
  if (!match) process.exit(2);
  const key = match[1] + ":" + (match[2] || "all");
  const rows = fixture.jobs.filter(job => job.run_id === Number(match[1]) && (!match[2] || job.run_attempt === Number(match[2])));
  const pages = fixture.jobPages?.[key];
  console.log(JSON.stringify({total_count: fixture.jobTotals?.[key] ?? rows.length, jobs: pages ? pages[page - 1] || [] : slice(rows)}));
} else if (endpoint.pathname.endsWith("/logs")) {
  const id = Number(endpoint.pathname.split("/").at(-2));
  const job = fixture.jobs.find(job => job.id === id);
  if (!job) process.exit(2);
  console.log(job.log);
} else if (/\\/actions\\/runs\\/\\d+$/.test(endpoint.pathname)) {
  const id = endpoint.pathname.split("/").at(-1);
  const run = fixture.seedRuns?.[id] || (fixture.toolingRuns || []).find(run => run.id === Number(id));
  if (!run) process.exit(2);
  console.log(JSON.stringify(run));
} else {
  console.error("Unexpected gh request", args);
  process.exit(2);
}\n`,
    );
    chmodSync(fakeGh, 0o755);
    check({
      original,
      contents: () => readFileSync(output, "utf8"),
      requests: () =>
        readFileSync(requests, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as string[]),
      invoke: (dryRun = false, count = 2, toolingRunIds = []) =>
        spawnSync(
          process.execPath,
          [
            "--require",
            clock,
            "--import",
            "tsx",
            "scripts/ci-refit-test-timings.mts",
            "--runs",
            String(count),
            "--repo",
            "fixture/repo",
            "--out",
            output,
            ...toolingRunIds.flatMap((id) => ["--tooling-run", String(id)]),
            ...(dryRun ? ["--dry-run"] : []),
          ],
          {
            cwd: fileURLToPath(new URL("../../", import.meta.url)),
            encoding: "utf8",
            timeout: 30_000,
            env: { ...process.env, OPENCLAW_GH_BIN: fakeGh, GH_TOKEN: "fixture-token" },
          },
        ),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
