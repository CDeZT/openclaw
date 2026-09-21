import type { NodeTestShardGroup } from "./ci-node-test-plan.mts";
import { usesMeasuredCiNodeTestWorkers } from "./ci-node-test-workers.mts";
import {
  compactWorkerTimingOwner,
  isRuntimePlacementIncludePatterns,
  type CompactWorkerTiming,
} from "./ci-test-timings-schema.mts";

export function createCompactWorkerCostResolver(workerTimings: readonly CompactWorkerTiming[]) {
  const measuredCosts = new Map<NodeTestShardGroup, Map<string, number | undefined>>();
  return (
    group: NodeTestShardGroup,
    capacity: { runner: string; planConcurrency?: number; env?: Record<string, string> },
  ): number | undefined => {
    if (!isRuntimePlacementIncludePatterns(group.includePatterns)) {
      return undefined;
    }
    const runner = capacity.runner;
    const jobPin = capacity.env?.OPENCLAW_VITEST_MAX_WORKERS;
    const capacityKey = `${runner}/${capacity.planConcurrency}/${jobPin ?? ""}`;
    const cached = measuredCosts.get(group);
    if (cached?.has(capacityKey)) {
      return cached.get(capacityKey);
    }
    const files = new Set(group.includePatterns);
    const timingOwner = compactWorkerTimingOwner(group);
    const { OPENCLAW_VITEST_MAX_WORKERS: pin, ...env } = group.env ?? {};
    const targetClasses = workerTimings.filter(
      (observation) =>
        observation.runner === runner && observation.planConcurrency === capacity.planConcurrency,
    );
    const targetWorkers = Math.min(
      Number(pin ?? Infinity),
      Number(jobPin ?? Infinity),
      ...(targetClasses.length > 0
        ? targetClasses.map((observation) =>
            Math.min(
              observation.jobWorkers,
              group.fallbackMaxWorkers !== undefined &&
                !usesMeasuredCiNodeTestWorkers({
                  hostResources: {
                    logicalCpuCount: observation.cpuCount,
                    totalMemoryBytes: observation.totalMemoryBytes,
                  },
                  concurrency: observation.planConcurrency,
                  runnerEnvironment: runner.startsWith("blacksmith-")
                    ? "self-hosted"
                    : "github-hosted",
                  frozenTarget: "false",
                  minTotalMemoryBytes: group.minTotalMemoryBytes,
                })
                ? group.fallbackMaxWorkers
                : Infinity,
            ),
          )
        : [group.fallbackMaxWorkers ?? Infinity]),
    );
    let direct: number | undefined;
    let projected: number | undefined;
    for (const observation of workerTimings) {
      if (
        observation.timingOwner !== timingOwner ||
        observation.runner.startsWith("blacksmith-") !== runner.startsWith("blacksmith-") ||
        observation.configs.length !== group.configs.length ||
        !observation.configs.every((config, index) => config === group.configs[index]) ||
        !observation.includePatterns.every((file) => files.has(file)) ||
        Object.keys(observation.env).length !== Object.keys(env).length ||
        !Object.entries(observation.env).every(([key, value]) => env[key] === value)
      ) {
        continue;
      }
      if (
        observation.includePatterns.length === files.size &&
        observation.runner === runner &&
        observation.planConcurrency === capacity.planConcurrency &&
        observation.workers <= targetWorkers
      ) {
        direct = Math.max(direct ?? 0, observation.seconds);
      }
      // Only the existing measured-worker families have a proven parallel
      // allowance. Serial groups retain their observed wall without a multiplier.
      // Moving to more workers never manufactures a speedup from an older span.
      const scale =
        group.fallbackMaxWorkers === undefined
          ? 1
          : Math.max(1, observation.workers / targetWorkers);
      // A growing child retains its contained workload's cost. Overlapping
      // observations are floors, not additive samples of independent work.
      projected = Math.max(projected ?? 0, observation.seconds * scale);
    }
    const seconds = direct ?? projected;
    const costs = cached ?? new Map<string, number | undefined>();
    costs.set(capacityKey, seconds);
    measuredCosts.set(group, costs);
    return seconds;
  };
}
