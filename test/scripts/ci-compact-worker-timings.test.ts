import { describe, expect, it } from "vitest";
import { refitTestTimings, type CiTimingRun } from "../../scripts/lib/ci-test-timings-refit.mts";
import {
  ciTestTimingsSchema,
  type CiTestTimings,
  type CompactWorkerTiming,
} from "../../scripts/lib/ci-test-timings-schema.mts";
import { createCompactSplitTimingGeneration } from "../../scripts/lib/vitest-shard-metadata.mts";
import {
  baseline,
  samplerJob,
  samplerRun,
  timingRun,
  toolingFile,
  withSamplerFixture,
  workerGroup,
  workerLog,
} from "./ci-test-timings.test-support.js";

describe("compact worker timing refit", () => {
  const runner = "blacksmith-8vcpu-ubuntu-2404";
  it("retains timing epochs across split generations for otherwise identical workloads", () => {
    const runs = [1, 2].map((id) =>
      timingRun(
        id,
        [1, 2].map((epoch) => {
          const generation = createCompactSplitTimingGeneration({
            ...workerGroup,
            parentShardName: `agentic-commands-runtime#file-parallel-${epoch}`,
            stripes: [workerGroup.includePatterns, [`src/commands/sibling-${id}.test.ts`]],
          });
          return {
            kind: "compact" as const,
            labels: [runner],
            text: workerLog(
              epoch === 1 ? 480 : 120,
              {},
              {
                ...workerGroup,
                timing_key: generation.timingKeys[0]!,
              },
            ),
          };
        }),
      ),
    );
    expect(
      refitTestTimings(runs).timings.compactWorkerTimings.map(({ timingOwner, seconds }) => [
        timingOwner,
        seconds,
      ]),
    ).toEqual([
      ["agentic-commands-runtime#file-parallel-1", 480],
      ["agentic-commands-runtime#file-parallel-2", 120],
    ]);
  });
  it("keeps observed execution classes separate even when the requested runner label is identical", () => {
    const logs: CiTimingRun["logs"] = [
      { kind: "compact", labels: [runner], text: workerLog(480) },
      {
        kind: "compact",
        labels: [runner],
        text: workerLog(120, { cpuCount: 8, workers: 8, memoryGiB: 32 }),
      },
      {
        kind: "compact",
        labels: [runner],
        text: workerLog(200, { cpuCount: 8, workers: 2, memoryGiB: 32, planConcurrency: 2 }),
      },
      {
        kind: "compact",
        labels: [runner],
        text: workerLog(
          240,
          { cpuCount: 8, workers: 8, memoryGiB: 32, planConcurrency: 2 },
          {
            ...workerGroup,
            env: { ...workerGroup.env, OPENCLAW_VITEST_MAX_WORKERS: "2" },
          },
        ),
      },
    ];
    const result = refitTestTimings([timingRun(1, logs), timingRun(2, logs)]);
    expect(
      result.timings.compactWorkerTimings.map(
        ({ cpuCount, jobWorkers, workers, planConcurrency, seconds }) => [
          cpuCount,
          jobWorkers,
          workers,
          planConcurrency,
          seconds,
        ],
      ),
    ).toEqual([
      [2, 2, 2, 1, 480],
      [8, 2, 2, 2, 200],
      [8, 8, 2, 2, 240],
      [8, 8, 8, 1, 120],
    ]);
    expect(result.contributingRunIds.compactWorkers).toEqual([1, 2]);
    expect(ciTestTimingsSchema.parse(result.timings)).toEqual(result.timings);
  });

  it.each([
    [{}, 2],
    [{ cpuCount: 8, workers: 8, memoryGiB: 32 }, 6],
    [{ cpuCount: 8, workers: 8, memoryGiB: 24 }, 2],
    [{ cpuCount: 8, workers: 8, memoryGiB: 32, planConcurrency: 2 }, 2],
    [{ cpuCount: 8, workers: 8, memoryGiB: 32, runnerEnvironment: "github-hosted" }, 2],
    [{ cpuCount: 8, workers: 8, memoryGiB: 32, frozenTarget: "true" }, 2],
  ] as const)("records the admitted group worker ceiling for %j", (resources, workers) => {
    const text = workerLog(80, resources, {
      ...workerGroup,
      env: { ...workerGroup.env, OPENCLAW_VITEST_MAX_WORKERS: "6" },
      fallbackMaxWorkers: 2,
      minTotalMemoryBytes: 28 * 1024 ** 3,
    });
    const result = refitTestTimings(
      [1, 2].map((id) => timingRun(id, [{ kind: "compact", labels: [runner], text }])),
    );
    expect(result.timings.compactWorkerTimings).toEqual([
      expect.objectContaining({ workers, seconds: 80, env: { FEATURE: "1" } }),
    ]);
  });

  it.each(["timestamped", "untimestamped"])(
    "merges %s job env continuations while preserving the lowest worker pin",
    (continuation) => {
      const jobEnv = { FEATURE: "job-value", JOB_ONLY: "kept", OPENCLAW_VITEST_MAX_WORKERS: "1" };
      const runs = [false, true].map((pretty, index) => {
        const encodedEnv = JSON.stringify(jobEnv, null, pretty ? 2 : undefined)
          .split("\n")
          .map((line, row) =>
            pretty && row > 0 && continuation === "untimestamped"
              ? line
              : `2026-08-27T23:00:00Z ${row === 0 ? "OPENCLAW_NODE_TEST_ENV_JSON: " : ""}${line}`,
          )
          .join("\n");
        return timingRun(index + 1, [
          {
            kind: pretty ? "tooling" : "compact",
            labels: [runner],
            text: `${encodedEnv}\n${workerLog(80, {}, { ...workerGroup, env: { ...workerGroup.env, OPENCLAW_VITEST_MAX_WORKERS: "6" } })}`,
          },
        ]);
      });
      const result = refitTestTimings(runs);
      expect(result.timings.compactWorkerTimings).toEqual([
        expect.objectContaining({
          workers: 1,
          env: { FEATURE: "1", JOB_ONLY: "kept" },
          seconds: 80,
        }),
      ]);
      expect(result.timings.source).toContain("main CI runs: 1;");
      expect(result.timings.source).toContain(
        "pull_request CI merge-ref runs (tooling files and exact compact worker observations): 2",
      );
    },
  );

  it("requires two independent completed exact workloads and retains absent classes across PR subsets", () => {
    const log = { kind: "tooling" as const, labels: [runner], text: workerLog(480) };
    const duplicate = timingRun(1, [log, log]);
    expect(refitTestTimings([duplicate, duplicate]).timings.compactWorkerTimings).toEqual([]);
    const measured = refitTestTimings([duplicate, timingRun(2, [log])]);
    expect(measured.timings.compactWorkerTimings).toHaveLength(1);
    expect(measured.timings.compactGroupSeconds).toEqual(baseline.compactGroupSeconds);
    expect(measured.timings.runtimePlacementTimings).toEqual(baseline.runtimePlacementTimings);
    const partial = [3, 4, 5].map((id) =>
      timingRun(id, [
        {
          ...log,
          text: workerLog(
            90,
            {},
            { ...workerGroup, includePatterns: ["src/commands/other.test.ts"] },
          ),
        },
      ]),
    );
    const result = refitTestTimings(partial, measured.timings);
    expect(
      result.timings.compactWorkerTimings.map(({ seconds }) => seconds).toSorted((a, b) => a - b),
    ).toEqual([90, 480]);
    const withinThreshold = [3, 4].map((id) => timingRun(id, [{ ...log, text: workerLog(500) }]));
    expect(refitTestTimings(withinThreshold, measured.timings).changes).toEqual([]);
    expect(
      refitTestTimings([duplicate, timingRun(2, [log])], baseline, { seedTooling: true }).timings
        .compactWorkerTimings,
    ).toEqual([]);
  });

  it.each([
    workerLog(80).replace(/.*\[shard:resources\].*\n/u, ""),
    workerLog(80).replace("end (exit 0)", "end (exit 1)"),
    workerLog(80, {}, { ...workerGroup, includePatterns: ["src/commands/*.test.ts"] }),
    `${workerLog(80)}\n2026-08-27T23:00:00Z OPENCLAW_NODE_TEST_ENV_JSON: {\n2026-08-27T23:00:00Z "OPENCLAW_VITEST_MAX_WORKERS": 2\n2026-08-27T23:00:00Z }`,
  ])("ignores logs without successful spans, observed capacity or explicit files", (text) => {
    const result = refitTestTimings(
      [1, 2].map((id) => timingRun(id, [{ kind: "compact", labels: [runner], text }])),
    );
    expect(result.timings.compactWorkerTimings).toEqual([]);
    expect(result.contributingRunIds.compactWorkers).toEqual([]);
  });
});

describe("compact worker timing schema", () => {
  const workerObservation: CompactWorkerTiming = {
    timingOwner: "reader",
    runner: "blacksmith-8vcpu-ubuntu-2404",
    cpuCount: 2,
    totalMemoryBytes: 8 * 1024 ** 3,
    jobWorkers: 2,
    workers: 2,
    planConcurrency: 1,
    configs: ["reader.config.ts"],
    env: {},
    includePatterns: ["src/reader.test.ts"],
    seconds: 80,
  };
  it.each([
    [{ ...workerObservation, timingOwner: "" }],
    [{ ...workerObservation, timingOwner: 1 }],
    [{ ...workerObservation, workers: 0 }],
    [{ ...workerObservation, jobWorkers: 0 }],
    [{ ...workerObservation, jobWorkers: 1.5 }],
    [{ ...workerObservation, workers: 3 }],
    [{ ...workerObservation, cpuCount: 1.5 }],
    [{ ...workerObservation, totalMemoryBytes: 0 }],
    [{ ...workerObservation, planConcurrency: -1 }],
    [{ ...workerObservation, env: { OPENCLAW_VITEST_MAX_WORKERS: "2" } }],
    [{ ...workerObservation, includePatterns: ["src/*.test.ts"] }],
    [workerObservation, { ...workerObservation, totalMemoryBytes: 7 * 1024 ** 3 }],
  ])("rejects invalid or duplicate compact worker observations %j", (...observations) => {
    expect(() =>
      ciTestTimingsSchema.parse({ ...baseline, compactWorkerTimings: observations }),
    ).toThrow("Invalid CI test timings");
  });
});

describe("compact worker sampler provenance", () => {
  const retained: CiTestTimings = {
    ...baseline,
    compactGroupSeconds: {
      blacksmith: { "core-unit-src-security-2": 20 },
      github: { retained: 90 },
    },
    runtimePlacementTimings: {
      blacksmith: [
        {
          configs: ["test/vitest/reader.config.ts"],
          env: {},
          includePatterns: ["src/reader.test.ts"],
          pretestBuildMode: "runtime",
          seconds: 80,
        },
      ],
      github: [],
    },
    repoE2eFileSeconds: { "test/retained.e2e.test.ts": 50 },
    toolingFileSeconds: {
      blacksmith: { [toolingFile]: 10, "test/scripts/unselected.test.ts": 70 },
      github: { [toolingFile]: 90 },
    },
  };

  it("samples PR capacity observations when the selected workload contains no tooling files", () => {
    withSamplerFixture(
      {
        baseline: retained,
        runs: [samplerRun(1), samplerRun(2)],
        toolingRuns: [3, 4].map((id) =>
          samplerRun(id, { event: "pull_request", head_branch: "feature" }),
        ),
        jobs: [
          samplerJob(11, 1),
          samplerJob(21, 2),
          ...[3, 4].map((id) => samplerJob(id * 10, id, { log: workerLog(480) })),
        ],
      },
      (fixture) => {
        const result = fixture.invoke();
        expect(result.status, result.stderr).toBe(0);
        const timings = ciTestTimingsSchema.parse(JSON.parse(fixture.contents()));
        expect(timings.compactWorkerTimings).toEqual([
          expect.objectContaining({ workers: 2, seconds: 480 }),
        ]);
        expect(timings.compactGroupSeconds).toEqual(retained.compactGroupSeconds);
        expect(timings.runtimePlacementTimings).toEqual(retained.runtimePlacementTimings);
        expect(timings.toolingFileSeconds).toEqual(retained.toolingFileSeconds);
        expect(result.stdout).toContain("Independent compact worker contributors: 2.");
        expect(timings.source).toContain("main CI runs: 1, 2;");
        expect(timings.source).toContain(
          "pull_request CI merge-ref runs (tooling files and exact compact worker observations): 3, 4",
        );
      },
    );
  });
});
