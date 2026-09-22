import { describe, expect, it } from "vitest";
import { createCompactWorkerCostResolver } from "../../scripts/lib/ci-compact-worker-cost.mts";
import type { NodeTestShardGroup } from "../../scripts/lib/ci-node-test-plan.mts";
import type { CompactWorkerTiming } from "../../scripts/lib/ci-test-timings-schema.mts";

const small = "blacksmith-8vcpu-ubuntu-2404";
const large = "blacksmith-32vcpu-ubuntu-2404";
const group: NodeTestShardGroup = {
  shard_name: "measured-child",
  configs: ["test/vitest/vitest.gateway-server-isolated.config.ts"],
  includePatterns: ["src/gateway/example.test.ts"],
  runner: small,
  requiresDist: false,
  env: { OPENCLAW_VITEST_MAX_WORKERS: "8" },
  fallbackMaxWorkers: 2,
  minTotalMemoryBytes: 28 * 1024 ** 3,
};
const observation = (overrides: Partial<CompactWorkerTiming> = {}): CompactWorkerTiming => ({
  timingOwner: "measured-child",
  runner: large,
  cpuCount: 8,
  totalMemoryBytes: 32 * 1024 ** 3,
  jobWorkers: 8,
  workers: 8,
  planConcurrency: 1,
  configs: group.configs,
  env: {},
  includePatterns: group.includePatterns!,
  seconds: 375,
  ...overrides,
});
const smallHost = observation({
  runner: small,
  cpuCount: 2,
  totalMemoryBytes: 8 * 1024 ** 3,
  jobWorkers: 2,
  workers: 2,
  includePatterns: ["src/gateway/other.test.ts"],
});

describe("compact worker costs", () => {
  it("keeps measured work when losing a packing partner lowers the worker class", () => {
    const cost = createCompactWorkerCostResolver([observation(), smallHost]);
    expect(cost.childSeconds(group, { runner: large, planConcurrency: 1 })).toBe(375);
    expect(cost.childSeconds(group, { runner: small, planConcurrency: 1 })).toBe(1500);
  });

  it("prefers a direct two-worker measurement over a projected wall", () => {
    const cost = createCompactWorkerCostResolver([
      observation(),
      { ...smallHost, includePatterns: group.includePatterns!, seconds: 600 },
    ]);
    expect(cost.childSeconds(group, { runner: small, planConcurrency: 1 })).toBe(600);
  });

  it("does not multiply a serial group's wall or assume a faster-worker speedup", () => {
    const serial = { ...group, env: undefined, fallbackMaxWorkers: undefined };
    expect(
      createCompactWorkerCostResolver([observation(), smallHost]).childSeconds(serial, {
        runner: small,
        planConcurrency: 1,
      }),
    ).toBe(375);
    const cost = createCompactWorkerCostResolver([
      { ...smallHost, includePatterns: group.includePatterns! },
      observation({ includePatterns: ["src/gateway/other.test.ts"], workers: 2 }),
    ]);
    expect(cost.childSeconds(group, { runner: large, planConcurrency: 1 })).toBe(375);
  });

  it("uses the job allowance before applying a different group's worker pin", () => {
    const cost = createCompactWorkerCostResolver([
      observation({ runner: "blacksmith-16vcpu-ubuntu-2404" }),
      observation({ includePatterns: ["src/gateway/other.test.ts"], workers: 2 }),
    ]);
    expect(cost.childSeconds(group, { runner: large, planConcurrency: 1 })).toBe(375);
    expect(
      cost.childSeconds(group, {
        runner: large,
        planConcurrency: 1,
        env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
      }),
    ).toBe(1500);
    expect(cost.childSeconds(group, { runner: large, planConcurrency: 1 })).toBe(375);
  });

  it("uses the declared fallback when a target class has no measurements", () => {
    const cost = createCompactWorkerCostResolver([observation()]);
    expect(cost.childSeconds(group, { runner: small, planConcurrency: 1 })).toBe(1500);
    expect(
      cost.childSeconds(group, { runner: "ubuntu-24.04", planConcurrency: 1 }),
    ).toBeUndefined();
  });

  it("retains the largest contained workload when files are added without summing overlaps", () => {
    const addedFile = "src/gateway/added.test.ts";
    const cost = createCompactWorkerCostResolver([
      observation(),
      observation({ includePatterns: [...group.includePatterns!, addedFile], seconds: 400 }),
    ]);
    expect(
      cost.childSeconds(
        {
          ...group,
          includePatterns: [...group.includePatterns!, addedFile, "src/gateway/new.test.ts"],
        },
        { runner: large, planConcurrency: 1 },
      ),
    ).toBe(400);
    expect(
      cost.childSeconds(
        { ...group, includePatterns: [addedFile] },
        { runner: large, planConcurrency: 1 },
      ),
    ).toBeUndefined();
  });

  it("does not reuse costs from an earlier timing family", () => {
    const cost = createCompactWorkerCostResolver([observation()]);
    expect(
      cost.childSeconds(
        { ...group, timing_key: "measured-child#file-parallel-2" },
        { runner: large, planConcurrency: 1 },
      ),
    ).toBeUndefined();
  });

  it("retains disjoint measured work across repartition without changing child cost queries", () => {
    const a = "src/gateway/a.test.ts";
    const b = "src/gateway/b.test.ts";
    const family = { ...group, includePatterns: [a, b, "src/gateway/new.test.ts"] };
    const capacity = { runner: large, planConcurrency: 1 };
    const cost = createCompactWorkerCostResolver([
      observation({ includePatterns: [a], seconds: 400 }),
      observation({ includePatterns: [b], seconds: 350 }),
    ]);
    expect(cost.childSeconds(family, capacity)).toBe(400);
    expect(cost.familyCost(family, capacity)).toEqual({ seconds: 750, files: [a, b] });
    expect(cost.childSeconds(family, capacity)).toBe(400);
    expect(cost.exactSeconds(family, capacity)).toBeUndefined();
  });

  it("finds a disjoint partition without adding repeated or overlapping snapshots", () => {
    const [a, b, c, d, e, added] = ["a", "b", "c", "d", "e", "new"].map(
      (name) => `src/gateway/${name}.test.ts`,
    );
    const observations = [
      observation({ includePatterns: [a!, b!], seconds: 500 }),
      observation({ includePatterns: [a!, c!], seconds: 350 }),
      observation({ includePatterns: [b!, d!], seconds: 350 }),
      observation({ includePatterns: [e!], seconds: 50 }),
      observation({ includePatterns: [c!, a!], seconds: 350 }),
    ];
    const family = { ...group, includePatterns: [a!, b!, c!, d!, e!, added!] };
    for (const samples of [observations, observations.toReversed()]) {
      const cost = createCompactWorkerCostResolver(samples);
      expect(cost.familyCost(family, { runner: large, planConcurrency: 1 })).toEqual({
        seconds: 750,
        files: [a, b, c, d, e],
      });
      expect(
        cost.projectFamilyCost(family, { runner: large, planConcurrency: 1 }, [a!, d!], 200),
      ).toBe(350);
    }
  });

  it("prefers direct class measurements per workload and an exact whole-family observation", () => {
    const a = "src/gateway/a.test.ts";
    const b = "src/gateway/b.test.ts";
    const family = { ...group, includePatterns: [a, b] };
    const capacity = { runner: small, planConcurrency: 1 };
    const observations = [
      observation({ includePatterns: [a], seconds: 100 }),
      observation({ includePatterns: [b], seconds: 30 }),
      { ...smallHost, includePatterns: [a], seconds: 150 },
      { ...smallHost, includePatterns: [b], seconds: 40 },
    ];
    expect(
      createCompactWorkerCostResolver(observations).familyCost(family, capacity)?.seconds,
    ).toBe(190);
    expect(
      createCompactWorkerCostResolver([
        ...observations,
        { ...smallHost, includePatterns: [a, b], seconds: 180 },
      ]).familyCost(family, capacity),
    ).toEqual({ seconds: 180, files: [a, b] });
  });

  it("combines only measurements from the current timing epoch", () => {
    const a = "src/gateway/a.test.ts";
    const b = "src/gateway/b.test.ts";
    const timingOwner = "measured-child#file-parallel-2";
    const family = { ...group, timing_key: timingOwner, includePatterns: [a, b] };
    const cost = createCompactWorkerCostResolver([
      observation({ timingOwner, includePatterns: [a], seconds: 100 }),
      observation({ includePatterns: [b], seconds: 900 }),
    ]);
    expect(cost.familyCost(family, { runner: large, planConcurrency: 1 })).toEqual({
      seconds: 100,
      files: [a],
    });
  });

  it("uses a measured faster-worker wall only for the corresponding allocation", () => {
    const capacity = { runner: large, planConcurrency: 1 };
    const slow = observation({ workers: 2, seconds: 400 });
    const fast = observation({ workers: 8, seconds: 100 });
    const cost = createCompactWorkerCostResolver([slow, fast]);
    expect(cost.childSeconds(group, capacity)).toBe(400);
    expect(cost.exactSeconds(group, capacity)).toBe(100);
    expect(cost.familyCost(group, capacity)).toEqual({
      seconds: 100,
      files: group.includePatterns,
    });

    const pinned = { ...capacity, env: { OPENCLAW_VITEST_MAX_WORKERS: "2" } };
    expect(cost.exactSeconds(group, pinned)).toBe(400);
    expect(cost.familyCost(group, pinned)).toEqual({ seconds: 400, files: group.includePatterns });
    expect(cost.exactSeconds(group, { ...capacity, runner: small })).toBeUndefined();
    expect(cost.exactSeconds(group, { ...capacity, planConcurrency: 2 })).toBeUndefined();
    expect(createCompactWorkerCostResolver([slow]).exactSeconds(group, capacity)).toBeUndefined();

    const grown = {
      ...group,
      includePatterns: [...group.includePatterns!, "src/gateway/new.test.ts"],
    };
    expect(cost.exactSeconds(grown, capacity)).toBeUndefined();
    expect(cost.familyCost(grown, capacity)).toEqual({
      seconds: 100,
      files: group.includePatterns,
    });
    expect(cost.projectFamilyCost(grown, capacity, group.includePatterns!, 200)).toBe(100);
    expect(cost.projectFamilyCost(grown, pinned, group.includePatterns!, 200)).toBe(400);
  });

  it("projects each measured workload separately and retains fallback for unobserved files", () => {
    const a = "src/gateway/a.test.ts";
    const b = "src/gateway/b.test.ts";
    const c = "src/gateway/c.test.ts";
    const d = "src/gateway/d.test.ts";
    const added = "src/gateway/new.test.ts";
    const family = { ...group, includePatterns: [a, b, c, d, added] };
    const capacity = { runner: large, planConcurrency: 1 };
    const cost = createCompactWorkerCostResolver([
      observation({ includePatterns: [a, b], seconds: 400 }),
      observation({ includePatterns: [c, d], seconds: 350 }),
    ]);
    expect(cost.projectFamilyCost(family, capacity, [a, c], 200)).toBe(375);
    expect(cost.projectFamilyCost(family, capacity, [a, added], 200)).toBe(300);
    expect(cost.projectFamilyCost(family, capacity, [a], 200)).toBe(200);
    expect(cost.projectFamilyCost(family, capacity, [added], 200)).toBe(200);
    expect(cost.projectFamilyCost(family, capacity, [], 200)).toBe(200);
    expect(
      cost.projectFamilyCost(family, { runner: "ubuntu-24.04", planConcurrency: 1 }, [a], 200),
    ).toBe(200);
  });

  it("uses canonical nonuniform file weights within a measured workload", () => {
    const heavy = "src/gateway/server.sessions.fixture-lifecycle.test.ts";
    const light = "src/gateway/light.test.ts";
    const family = { ...group, includePatterns: [heavy, light, "src/gateway/new.test.ts"] };
    const capacity = { runner: large, planConcurrency: 1 };
    const cost = createCompactWorkerCostResolver([
      observation({ includePatterns: [heavy, light], seconds: 330 }),
    ]);
    const heavyCost = cost.projectFamilyCost(family, capacity, [heavy], 200)!;
    const lightCost = cost.projectFamilyCost(family, capacity, [light], 200)!;
    expect(heavyCost).toBeGreaterThan(lightCost);
    expect(heavyCost + lightCost).toBeCloseTo(330);
  });
});
