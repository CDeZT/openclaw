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
import * as testTimings from "../../scripts/lib/ci-test-timings.mts";
import * as buildPrerequisites from "../../scripts/lib/vitest-build-prerequisites.mts";
import { fullSuiteVitestShards } from "../vitest/vitest.test-shards.mjs";

const files = Array.from({ length: 8 }, (_, index) => `src/commands/worker-cost-${index}.test.ts`);
const group = {
  configs: ["test/vitest/vitest.commands.config.ts"],
  includePatterns: files,
  timing_key: "commands#file-parallel-2",
};

beforeEach(() => {
  vi.spyOn(testTimings, "readCompactGroupTimings").mockReturnValue({});
  vi.spyOn(testTimings, "readRuntimePlacementTimings").mockReturnValue([]);
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
    const config = "test/vitest/vitest.commands.config.ts";
    const ownerName = "agentic-commands-doctor-auth";
    const original = fullSuiteVitestShards.slice();
    vi.spyOn(buildPrerequisites, "resolveVitestPretestBuildMode").mockReturnValue(undefined);
    fullSuiteVitestShards.splice(
      0,
      fullSuiteVitestShards.length,
      ...original
        .map((shard) => ({
          ...shard,
          projects: shard.projects.filter((project) => project === config),
        }))
        .filter((shard) => shard.projects.length > 0),
    );
    try {
      const owners = createNodeTestShards();
      const owner = owners.find((shard) => shard.shardName === ownerName)!;
      expect(owner.includePatterns).toBeDefined();
      const timings: Record<string, number> = Object.fromEntries(
        owners.map((shard) => [shard.shardName, 1]),
      );
      vi.mocked(testTimings.readCompactGroupTimings).mockReturnValue(timings);
      vi.spyOn(testTimings, "readCompactWorkerTimings").mockReturnValue([
        {
          timingOwner: ownerName,
          runner: "blacksmith-8vcpu-ubuntu-2404",
          cpuCount: 2,
          totalMemoryBytes: 8 * 1024 ** 3,
          jobWorkers: 2,
          workers: 2,
          planConcurrency: 1,
          configs: [config],
          env: {},
          includePatterns: owner.includePatterns!,
          seconds: 160,
        },
      ]);
      const options = {
        compactMode: "push" as const,
        runnerBackend: "hybrid",
        includeReleaseOnlyPluginShards: false,
      };
      const baseline = createNodeTestShardBundles(options);
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
      expect(predictions(createNodeTestShardBundles(options))).toEqual(predictions(baseline));
    } finally {
      fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...original);
    }
  });
});
