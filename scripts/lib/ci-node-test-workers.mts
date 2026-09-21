import { isConstrainedCiCheckHost } from "./local-check-runtime.mts";

export function usesMeasuredCiNodeTestWorkers(options: {
  hostResources: { logicalCpuCount: number; totalMemoryBytes: number } | null;
  concurrency: number;
  runnerEnvironment: string | undefined;
  frozenTarget: string | undefined;
  minTotalMemoryBytes?: number;
}): boolean {
  return (
    options.hostResources !== null &&
    !isConstrainedCiCheckHost(options.hostResources) &&
    options.concurrency === 1 &&
    options.runnerEnvironment === "self-hosted" &&
    options.frozenTarget !== "true" &&
    options.hostResources.totalMemoryBytes >= (options.minTotalMemoryBytes ?? 0)
  );
}
