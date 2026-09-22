import type { NodeTestShardGroup } from "./ci-node-test-plan.mts";
import { usesMeasuredCiNodeTestWorkers } from "./ci-node-test-workers.mts";
import {
  compactWorkerTimingOwner,
  isRuntimePlacementIncludePatterns,
  type CompactWorkerTiming,
} from "./ci-test-timings-schema.mts";
import { estimateVitestTestFileSeconds } from "./vitest-shard-metadata.mts";

type MeasuredWorkload = {
  files: readonly string[];
  exact?: number;
  direct?: number;
  projected: number;
};

type WorkerCapacity = {
  runner: string;
  planConcurrency?: number;
  env?: Record<string, string>;
};

type FamilyCost = { seconds: number; files: readonly string[] };
type SelectedFamilyCost = FamilyCost & { workloads: readonly FamilyCost[] };
type ResolvedCosts = {
  childSeconds: number | undefined;
  exactSeconds: number | undefined;
  familyCost: FamilyCost | undefined;
  familyWorkloads: readonly (FamilyCost & { weight: number })[];
};

function disjointWorkloadFloor(
  workloads: ReadonlyMap<string, MeasuredWorkload>,
): SelectedFamilyCost | undefined {
  const candidates = [...workloads]
    .map(([key, workload]) => ({
      key,
      files: workload.files,
      seconds: workload.exact ?? workload.direct ?? workload.projected,
    }))
    .toSorted((a, b) => b.seconds - a.seconds || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  let floor: SelectedFamilyCost | undefined;
  // Seed every candidate so one large overlapping snapshot cannot hide a
  // complete disjoint partition. This bounded greedy search may underestimate
  // the best partition, but never adds overlapping invocations twice.
  for (const first of candidates) {
    const selectedFiles = new Set(first.files);
    const selectedWorkloads = [first];
    let seconds = first.seconds;
    for (const candidate of candidates) {
      if (candidate.files.some((file) => selectedFiles.has(file))) {
        continue;
      }
      seconds += candidate.seconds;
      selectedWorkloads.push(candidate);
      for (const file of candidate.files) {
        selectedFiles.add(file);
      }
    }
    if (floor === undefined || seconds > floor.seconds) {
      floor = { seconds, files: [...selectedFiles].toSorted(), workloads: selectedWorkloads };
    }
  }
  return floor;
}

export function createCompactWorkerCostResolver(workerTimings: readonly CompactWorkerTiming[]) {
  const measuredCosts = new Map<NodeTestShardGroup, Map<string, ResolvedCosts>>();
  const resolve = (
    group: NodeTestShardGroup,
    capacity: WorkerCapacity,
  ): ResolvedCosts | undefined => {
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
    let exact: number | undefined;
    let projected: number | undefined;
    const workloads = new Map<string, MeasuredWorkload>();
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
      const isDirectClass =
        observation.runner === runner &&
        observation.planConcurrency === capacity.planConcurrency &&
        observation.workers <= targetWorkers;
      const isExactClass = isDirectClass && observation.workers === targetWorkers;
      if (observation.includePatterns.length === files.size && isDirectClass) {
        direct = Math.max(direct ?? 0, observation.seconds);
        if (isExactClass) {
          exact = Math.max(exact ?? 0, observation.seconds);
        }
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
      const key = JSON.stringify(observation.includePatterns.toSorted());
      const workload = workloads.get(key) ?? { files: observation.includePatterns, projected: 0 };
      if (isExactClass) {
        workload.exact = Math.max(workload.exact ?? 0, observation.seconds);
      }
      if (isDirectClass) {
        workload.direct = Math.max(workload.direct ?? 0, observation.seconds);
      }
      workload.projected = Math.max(workload.projected, observation.seconds * scale);
      workloads.set(key, workload);
    }
    const wholeFamilySeconds = exact ?? direct;
    const family =
      wholeFamilySeconds === undefined
        ? disjointWorkloadFloor(workloads)
        : {
            seconds: wholeFamilySeconds,
            files: [...files].toSorted(),
            workloads: [{ seconds: wholeFamilySeconds, files: [...files].toSorted() }],
          };
    const resolved = {
      childSeconds: direct ?? projected,
      exactSeconds: exact,
      familyCost: family ? { seconds: family.seconds, files: family.files } : undefined,
      familyWorkloads: (family?.workloads ?? []).map((workload) => ({
        seconds: workload.seconds,
        files: workload.files,
        weight: workload.files.reduce((sum, file) => sum + estimateVitestTestFileSeconds(file), 0),
      })),
    };
    const costs = cached ?? new Map<string, ResolvedCosts>();
    costs.set(capacityKey, resolved);
    measuredCosts.set(group, costs);
    return resolved;
  };
  return {
    childSeconds: (group: NodeTestShardGroup, capacity: WorkerCapacity) =>
      resolve(group, capacity)?.childSeconds,
    familyCost: (group: NodeTestShardGroup, capacity: WorkerCapacity) =>
      resolve(group, capacity)?.familyCost,
    exactSeconds: (group: NodeTestShardGroup, capacity: WorkerCapacity) =>
      resolve(group, capacity)?.exactSeconds,
    projectFamilyCost: (
      parent: NodeTestShardGroup,
      capacity: WorkerCapacity,
      childFiles: readonly string[],
      fallbackSeconds: number,
    ): number => {
      const files = new Set(childFiles);
      const totalWeight = [...files].reduce(
        (sum, file) => sum + estimateVitestTestFileSeconds(file),
        0,
      );
      if (totalWeight === 0) {
        return fallbackSeconds;
      }
      const unobserved = new Set(files);
      let measuredSeconds = 0;
      // Preserve each measured stripe's cost density; averaging the family can
      // erase a slow workload when its files move to a newly generated child.
      for (const workload of resolve(parent, capacity)?.familyWorkloads ?? []) {
        let coveredWeight = 0;
        for (const file of workload.files) {
          if (files.has(file)) {
            coveredWeight += estimateVitestTestFileSeconds(file);
            unobserved.delete(file);
          }
        }
        measuredSeconds += (workload.seconds * coveredWeight) / workload.weight;
      }
      const unobservedWeight = [...unobserved].reduce(
        (sum, file) => sum + estimateVitestTestFileSeconds(file),
        0,
      );
      return measuredSeconds + (fallbackSeconds * unobservedWeight) / totalWeight;
    },
  };
}
