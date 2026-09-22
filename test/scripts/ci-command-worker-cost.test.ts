import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAgenticCommandSplitShards,
  estimateCommandWorkerSeconds,
  estimateLegacyCommandStripeSeconds,
  estimateSerialCommandSeconds,
} from "../../scripts/lib/ci-command-test-plan.mts";
import {
  createNodeTestShardBundles,
  createNodeTestShards,
} from "../../scripts/lib/ci-node-test-plan.mts";
import type { CompactWorkerTiming } from "../../scripts/lib/ci-test-timings-schema.mts";
import * as testTimings from "../../scripts/lib/ci-test-timings.mts";
import * as buildPrerequisites from "../../scripts/lib/vitest-build-prerequisites.mts";
import * as shardMetadata from "../../scripts/lib/vitest-shard-metadata.mts";
import { fullSuiteVitestShards } from "../vitest/vitest.test-shards.mjs";

const files = Array.from({ length: 8 }, (_, index) => `src/commands/worker-cost-${index}.test.ts`);
const group = {
  configs: ["test/vitest/vitest.commands.config.ts"],
  includePatterns: files,
  timing_key: "commands#file-parallel-2",
};
const commandConfig = "test/vitest/vitest.commands.config.ts";
const ownerName = "agentic-commands-doctor-auth";
const plannerOptions = {
  compactMode: "push" as const,
  runnerBackend: "hybrid",
  includeReleaseOnlyPluginShards: false,
};

function withCommandPlanner(
  check: (
    owner: ReturnType<typeof createNodeTestShards>[number],
    timings: Record<string, number>,
  ) => void,
) {
  const original = fullSuiteVitestShards.slice();
  vi.spyOn(buildPrerequisites, "resolveVitestPretestBuildMode").mockReturnValue(undefined);
  fullSuiteVitestShards.splice(
    0,
    fullSuiteVitestShards.length,
    ...original
      .map((shard) => ({
        ...shard,
        projects: shard.projects.filter((project) => project === commandConfig),
      }))
      .filter((shard) => shard.projects.length > 0),
  );
  try {
    const owners = createNodeTestShards();
    const owner = owners.find((shard) => shard.shardName === ownerName)!;
    expect(owner.includePatterns).toBeDefined();
    const timings = Object.fromEntries(owners.map((shard) => [shard.shardName, 1]));
    vi.mocked(testTimings.readCompactGroupTimings).mockReturnValue(timings);
    check(owner, timings);
  } finally {
    fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...original);
  }
}

function workerObservation(
  includePatterns: string[],
  overrides: Partial<CompactWorkerTiming> = {},
): CompactWorkerTiming {
  return {
    timingOwner: ownerName,
    runner: "blacksmith-8vcpu-ubuntu-2404",
    cpuCount: 2,
    totalMemoryBytes: 8 * 1024 ** 3,
    jobWorkers: 2,
    workers: 2,
    planConcurrency: 1,
    configs: [commandConfig],
    env: {},
    includePatterns,
    seconds: 160,
    ...overrides,
  };
}

function parallelObservations(includePatterns: string[], seconds: number): CompactWorkerTiming[] {
  return [
    workerObservation(includePatterns, { timingOwner: `${ownerName}#file-parallel-2`, seconds }),
    workerObservation(includePatterns, {
      timingOwner: `${ownerName}#file-parallel-2`,
      runner: "blacksmith-32vcpu-ubuntu-2404",
      cpuCount: 8,
      totalMemoryBytes: 32 * 1024 ** 3,
      planConcurrency: 2,
      seconds,
    }),
    workerObservation(includePatterns, {
      timingOwner: `${ownerName}#file-parallel-8`,
      runner: "blacksmith-32vcpu-ubuntu-2404",
      cpuCount: 8,
      totalMemoryBytes: 32 * 1024 ** 3,
      jobWorkers: 8,
      workers: 8,
      seconds,
    }),
  ];
}

beforeEach(() => {
  vi.spyOn(testTimings, "readCompactGroupTimings").mockReturnValue({});
  vi.spyOn(testTimings, "readRuntimePlacementTimings").mockReturnValue([]);
  vi.spyOn(testTimings, "readCompactWorkerTimings").mockReturnValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("command worker costs", () => {
  it("retains a serial owner's complete wall before parallel samples exist", () => {
    const owner = createAgenticCommandSplitShards(() => undefined).find(
      (shard) => shard.shardName === "agentic-commands-doctor-auth",
    );
    expect(owner).toBeDefined();
    expect(estimateSerialCommandSeconds(owner!, "blacksmith", () => 80)).toBe(80);
  });

  it("retains a legacy stripe wall instead of dividing it by the file worker count", () => {
    vi.mocked(testTimings.readCompactGroupTimings).mockReturnValue({ "legacy-stripe": 80 });
    expect(estimateLegacyCommandStripeSeconds("legacy-stripe", "blacksmith")).toBe(80);
  });

  it.each([2, 8])("retains an 80-second fallback at %i workers", (workers) => {
    vi.mocked(testTimings.readCompactGroupTimings).mockReturnValue({
      [`commands#file-parallel-${workers === 2 ? 8 : 2}`]: 20,
    });
    expect(estimateCommandWorkerSeconds(group, 80, workers, "hybrid")).toEqual({
      seconds: 80,
      timingKey: `commands#file-parallel-${workers}`,
    });
  });

  it.each([2, 8])("uses the raw target measurement at %i workers", (workers) => {
    vi.mocked(testTimings.readCompactGroupTimings).mockReturnValue({
      [`commands#file-parallel-${workers}`]: 30,
    });
    expect(estimateCommandWorkerSeconds(group, 80, workers, "hybrid")).toEqual({
      seconds: 30,
      timingKey: `commands#file-parallel-${workers}`,
    });
  });

  it("preserves class-aware planner costs when a lower scalar lacks matching workload evidence", () => {
    withCommandPlanner((owner, timings) => {
      vi.mocked(testTimings.readCompactWorkerTimings).mockReturnValue([
        workerObservation(owner.includePatterns!),
      ]);
      const baseline = createNodeTestShardBundles(plannerOptions);
      const children = baseline
        .flatMap((job) => job.groups)
        .filter((child) => child.shard_name.startsWith(`${ownerName}-hosted-`));
      expect(children.length).toBeGreaterThan(1);
      expect(children.flatMap((child) => child.includePatterns!).toSorted()).toEqual(
        owner.includePatterns!.toSorted(),
      );
      for (const child of children) {
        expect(child.includePatterns!.length).toBeLessThan(owner.includePatterns!.length);
        expect(child.timing_key).toBeDefined();
        timings[child.timing_key!] = 1;
      }
      const predictions = (plan: typeof baseline) =>
        plan.map(({ checkName, predictedSeconds }) => ({ checkName, predictedSeconds }));
      expect(predictions(createNodeTestShardBundles(plannerOptions))).toEqual(
        predictions(baseline),
      );
    });
  });

  it.each(["backend", "files"] as const)(
    "retains compatible serial costs when parallel evidence has unrelated %s",
    (unrelated) => {
      withCommandPlanner((owner) => {
        const serial = workerObservation(owner.includePatterns!);
        vi.mocked(testTimings.readCompactWorkerTimings).mockReturnValue([serial]);
        const baseline = createNodeTestShardBundles(plannerOptions);
        const parallel = workerObservation(owner.includePatterns!, {
          timingOwner: `${ownerName}#file-parallel-2`,
          seconds: 1,
          ...(unrelated === "backend"
            ? { runner: "ubuntu-24.04" }
            : { includePatterns: ["src/commands/retired-worker-cost.test.ts"] }),
        });
        vi.mocked(testTimings.readCompactWorkerTimings).mockReturnValue([serial, parallel]);
        expect(createNodeTestShardBundles(plannerOptions)).toEqual(baseline);
      });
    },
  );

  it("retains the serial floor for a file uncovered by partial parallel observations", () => {
    withCommandPlanner((owner) => {
      const [covered, uncovered] = owner.includePatterns!;
      expect(uncovered).toBeDefined();
      vi.mocked(testTimings.readCompactWorkerTimings).mockReturnValue([
        workerObservation([uncovered!], { seconds: 1000 }),
        ...parallelObservations([covered!], 1),
      ]);
      const plan = createNodeTestShardBundles(plannerOptions);
      const ownerGroups = plan
        .flatMap((job) => job.groups)
        .filter(
          (child) =>
            child.shard_name === ownerName || child.shard_name.startsWith(`${ownerName}-hosted-`),
        );
      expect(ownerGroups.flatMap((child) => child.includePatterns!).toSorted()).toEqual(
        owner.includePatterns!.toSorted(),
      );
      const job = plan.find((entry) =>
        entry.groups.some((child) => child.includePatterns?.includes(uncovered!)),
      );
      expect(job?.predictedSeconds).toBeGreaterThanOrEqual(1000);
    });
  });

  it("keeps the indivisible command file floor during admission and final pricing", () => {
    withCommandPlanner((owner) => {
      const heavy = owner.includePatterns![0]!;
      const estimate = shardMetadata.estimateVitestTestFileSeconds;
      vi.spyOn(shardMetadata, "estimateVitestTestFileSeconds").mockImplementation((file) =>
        file === heavy ? 300 : estimate(file),
      );
      vi.mocked(testTimings.readCompactWorkerTimings).mockReturnValue(
        parallelObservations([heavy], 1),
      );
      const plan = createNodeTestShardBundles({ ...plannerOptions, runnerBackend: "blacksmith" });
      const jobs = plan.filter((entry) =>
        entry.groups.some((child) => child.includePatterns?.includes(heavy)),
      );
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.groups).toEqual([expect.objectContaining({ includePatterns: [heavy] })]);
      expect(jobs[0]!.planConcurrency).toBe(1);
      expect(jobs[0]!.predictedSeconds).toBe(300);
    });
  });
});
