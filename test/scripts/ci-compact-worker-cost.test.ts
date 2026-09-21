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
    expect(cost(group, { runner: large, planConcurrency: 1 })).toBe(375);
    expect(cost(group, { runner: small, planConcurrency: 1 })).toBe(1500);
  });

  it("prefers a direct two-worker measurement over a projected wall", () => {
    const cost = createCompactWorkerCostResolver([
      observation(),
      { ...smallHost, includePatterns: group.includePatterns!, seconds: 600 },
    ]);
    expect(cost(group, { runner: small, planConcurrency: 1 })).toBe(600);
  });

  it("does not multiply a serial group's wall or assume a faster-worker speedup", () => {
    const serial = { ...group, env: undefined, fallbackMaxWorkers: undefined };
    expect(
      createCompactWorkerCostResolver([observation(), smallHost])(serial, {
        runner: small,
        planConcurrency: 1,
      }),
    ).toBe(375);
    const cost = createCompactWorkerCostResolver([
      { ...smallHost, includePatterns: group.includePatterns! },
      observation({ includePatterns: ["src/gateway/other.test.ts"], workers: 2 }),
    ]);
    expect(cost(group, { runner: large, planConcurrency: 1 })).toBe(375);
  });

  it("uses the job allowance before applying a different group's worker pin", () => {
    const cost = createCompactWorkerCostResolver([
      observation({ runner: "blacksmith-16vcpu-ubuntu-2404" }),
      observation({ includePatterns: ["src/gateway/other.test.ts"], workers: 2 }),
    ]);
    expect(cost(group, { runner: large, planConcurrency: 1 })).toBe(375);
    expect(
      cost(group, {
        runner: large,
        planConcurrency: 1,
        env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
      }),
    ).toBe(1500);
    expect(cost(group, { runner: large, planConcurrency: 1 })).toBe(375);
  });

  it("uses the declared fallback when a target class has no measurements", () => {
    const cost = createCompactWorkerCostResolver([observation()]);
    expect(cost(group, { runner: small, planConcurrency: 1 })).toBe(1500);
    expect(cost(group, { runner: "ubuntu-24.04", planConcurrency: 1 })).toBeUndefined();
  });
});
