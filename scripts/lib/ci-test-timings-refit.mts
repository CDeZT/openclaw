import { stripVTControlCharacters } from "node:util";
import { decodeNodeTestGroups } from "./ci-node-test-groups-codec.mts";
import { usesMeasuredCiNodeTestWorkers } from "./ci-node-test-workers.mts";
import {
  compactWorkerTimingIdentity,
  compactWorkerTimingOwner,
  isCompactWorkerTiming,
  isRuntimePlacementTiming,
  runtimePlacementTimingIdentity,
  type CiTestTimings,
  type CompactWorkerTiming,
  type RuntimePlacementTiming,
} from "./ci-test-timings-schema.mts";
import { parseCompactSplitTimingKey } from "./vitest-shard-metadata.mts";

export type CiTimingRun = {
  id: number;
  createdAt: string;
  logs: (
    | { kind: "uiE2e" | "repoE2e"; text: string }
    | { kind: "compact" | "tooling"; text: string; labels: string[] }
  )[];
};

type Samples = Map<string, number[]>;

type RuntimeTimingGroup = {
  shard_name: string;
  timing_key?: string;
  configs: string[];
  includePatterns: string[];
  env?: Record<string, string>;
  fallbackMaxWorkers?: number;
  minTotalMemoryBytes?: number;
};

function isStringEnv(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function readRuntimeTimingGroups(text: string): RuntimeTimingGroup[] {
  const encoded = new Set(
    [
      ...text.matchAll(
        /\d{4}-\d\d-\d\dT[\d:.]+Z\s+OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: (\S+)$/gmu,
      ),
    ].map((match) => match[1]!),
  );
  if (encoded.size !== 1) {
    return [];
  }
  try {
    const groups = decodeNodeTestGroups([...encoded][0]!);
    const strings = (value: unknown): value is string[] =>
      Array.isArray(value) && value.every((entry) => typeof entry === "string");
    return groups.filter((group): group is RuntimeTimingGroup => {
      if (typeof group !== "object" || group === null) {
        return false;
      }
      return (
        "shard_name" in group &&
        typeof group.shard_name === "string" &&
        (!("timing_key" in group) || typeof group.timing_key === "string") &&
        "configs" in group &&
        strings(group.configs) &&
        group.configs.length > 0 &&
        "includePatterns" in group &&
        strings(group.includePatterns) &&
        group.includePatterns.length > 0 &&
        (!("fallbackMaxWorkers" in group) ||
          (typeof group.fallbackMaxWorkers === "number" &&
            Number.isSafeInteger(group.fallbackMaxWorkers) &&
            group.fallbackMaxWorkers > 0)) &&
        (!("minTotalMemoryBytes" in group) ||
          (typeof group.minTotalMemoryBytes === "number" &&
            Number.isSafeInteger(group.minTotalMemoryBytes) &&
            group.minTotalMemoryBytes > 0)) &&
        (!("env" in group) || isStringEnv(group.env))
      );
    });
  } catch {
    // Historical/malformed descriptors cannot supply a placement identity.
    return [];
  }
}

function readCompactWorkerLog(
  text: string,
  labels: string[],
  samples: Samples,
  observations: Map<string, CompactWorkerTiming>,
) {
  const unique = (values: string[]) => {
    const distinct = new Set(values);
    return distinct.size === 1 ? [...distinct][0] : undefined;
  };
  const runner = unique(labels.filter((label) => /^(?:blacksmith-|ubuntu-)/u.test(label)));
  const workersText = unique(
    [
      ...text.matchAll(/\d{4}-\d\d-\d\dT[\d:.]+Z\s+detected cores=\d+ [^\n]* -> workers=(\d+)$/gmu),
    ].map((match) => match[1]!),
  );
  const resourcesText = unique(
    [
      ...text.matchAll(
        /\d{4}-\d\d-\d\dT[\d:.]+Z\s+\[shard:resources\] (logicalCpuCount=\d+ totalMemoryBytes=\d+ requested plans=\d+ admitted plans=\d+)$/gmu,
      ),
    ].map((match) => match[1]!),
  );
  const resources =
    resourcesText &&
    /^logicalCpuCount=(\d+) totalMemoryBytes=(\d+) requested plans=\d+ admitted plans=(\d+)$/u.exec(
      resourcesText,
    );
  if (!runner || !workersText || !resources) {
    return;
  }
  const envLines = text.split("\n");
  const timestampedValue = (line: string) => /^\d{4}-\d\d-\d\dT[\d:.]+Z\s+(.*)$/u.exec(line)?.[1];
  const readEnv = (name: string) => {
    const values = new Set<string>();
    for (let index = 0; index < envLines.length; index += 1) {
      const match = new RegExp(`^${name}: (.*)$`, "u").exec(
        timestampedValue(envLines[index]!) ?? "",
      );
      if (!match) {
        continue;
      }
      let value = match[1]!.trim();
      // Actions may timestamp only the first line of toJson(matrix.env).
      // Env values are strings, so an object cannot contain a nested closing row.
      if (value === "{") {
        while (++index < envLines.length) {
          const line = timestampedValue(envLines[index]!) ?? envLines[index]!;
          value += `\n${line}`;
          if (line.trim() === "}") {
            break;
          }
        }
      }
      values.add(value);
    }
    return values;
  };
  const runnerEnvironments = readEnv("RUNNER_ENVIRONMENT");
  const frozenTargets = readEnv("FROZEN_TARGET");
  const jobEnvs = readEnv("OPENCLAW_NODE_TEST_ENV_JSON");
  if ([runnerEnvironments, frozenTargets, jobEnvs].some((values) => values.size > 1)) {
    return;
  }
  const hostResources = {
    logicalCpuCount: Number(resources[1]),
    totalMemoryBytes: Number(resources[2]),
  };
  const planConcurrency = Number(resources[3]);
  const jobWorkers = Number(workersText);
  if (
    ![
      hostResources.logicalCpuCount,
      hostResources.totalMemoryBytes,
      planConcurrency,
      jobWorkers,
    ].every((value) => Number.isSafeInteger(value) && value > 0)
  ) {
    return;
  }
  let jobEnv: Record<string, string> = {};
  const encodedJobEnv = [...jobEnvs][0];
  if (encodedJobEnv) {
    try {
      const value: unknown = JSON.parse(encodedJobEnv);
      if (value !== null) {
        if (!isStringEnv(value)) {
          return;
        }
        jobEnv = value;
      }
    } catch {
      return;
    }
  }
  const descriptors = readRuntimeTimingGroups(text);
  const starts = new Map<string, number>();
  for (const line of text.split("\n")) {
    const event =
      /(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+\[shard:([^\]]+)\] (begin|end \(exit (\d+)\))/u.exec(line);
    if (!event) {
      continue;
    }
    const key = event[2]!;
    if (event[3] === "begin") {
      starts.set(key, Date.parse(event[1]!));
      continue;
    }
    const started = starts.get(key);
    starts.delete(key);
    const matches = descriptors.filter((group) => (group.timing_key ?? group.shard_name) === key);
    if (event[4] !== "0" || started === undefined || matches.length !== 1) {
      continue;
    }
    const group = matches[0]!;
    const pins = [jobEnv.OPENCLAW_VITEST_MAX_WORKERS, group.env?.OPENCLAW_VITEST_MAX_WORKERS]
      .filter((value) => value !== undefined)
      .map(Number);
    if (!pins.every((value) => Number.isSafeInteger(value) && value > 0)) {
      continue;
    }
    const fallback =
      group.fallbackMaxWorkers !== undefined &&
      !usesMeasuredCiNodeTestWorkers({
        hostResources,
        concurrency: planConcurrency,
        runnerEnvironment: [...runnerEnvironments][0],
        frozenTarget: [...frozenTargets][0],
        minTotalMemoryBytes: group.minTotalMemoryBytes,
      })
        ? group.fallbackMaxWorkers
        : jobWorkers;
    const duration = (Date.parse(event[1]!) - started) / 1000;
    const observation = {
      timingOwner: compactWorkerTimingOwner(group),
      runner,
      cpuCount: hostResources.logicalCpuCount,
      totalMemoryBytes: hostResources.totalMemoryBytes,
      jobWorkers,
      workers: Math.min(jobWorkers, fallback, ...pins),
      planConcurrency,
      configs: group.configs,
      env: Object.fromEntries(
        Object.entries({ ...jobEnv, ...group.env })
          .filter(([name]) => name !== "OPENCLAW_VITEST_MAX_WORKERS")
          .toSorted(([a], [b]) => a.localeCompare(b)),
      ),
      includePatterns: group.includePatterns.toSorted(),
      seconds: Math.max(1, Math.round(duration)),
    };
    if (duration > 0 && isCompactWorkerTiming(observation)) {
      const identity = compactWorkerTimingIdentity(observation);
      observations.set(identity, {
        ...observation,
        totalMemoryBytes: Math.min(
          observation.totalMemoryBytes,
          observations.get(identity)?.totalMemoryBytes ?? Infinity,
        ),
      });
      recordSample(samples, identity, duration);
    }
  }
}
const MIN_PRUNE_RUNS = 3;

function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function recordSample(samples: Samples, key: string, value: number) {
  if (Number.isFinite(value) && value > 0) {
    const values = samples.get(key) ?? [];
    values.push(value);
    samples.set(key, values);
  }
}

function seconds(value: string, unit: string): number {
  return Number(value) / (unit === "ms" ? 1000 : 1);
}

function readE2eLog(text: string, samples: Samples, overhead?: number[]) {
  const files = new Map<string, number>();
  let hasParallelFiles = false;
  for (const line of text.split("\n")) {
    const file =
      /^\s*(?:\d{4}-\d\d-\d\dT[\d:.]+Z\s+)?✓\s+(?:(\|ui-e2e(?:-(?:bundled|standalone|(?:serial|real-gateway)(?:-standalone)?))?\||ui-e2e(?:-(?:bundled|standalone|(?:serial|real-gateway)(?:-standalone)?))?)\s+)?(\S+\.test\.ts)\s+\((\d+) tests?(?: \| \d+ (?:skipped|todo))*\)\s+([\d.]+)(m?s)(?:\s|$)/u.exec(
        line,
      );
    if (file) {
      files.set(file[2]!, seconds(file[4]!, file[5]!));
      hasParallelFiles ||=
        file[1]?.includes("ui-e2e-bundled") === true ||
        file[1]?.includes("ui-e2e-standalone") === true ||
        file[1]?.includes("ui-e2e-real-gateway") === true;
    }
    const summary = /\bDuration\s+([\d.]+)(m?s)(?:\s|$)/u.exec(line);
    if (summary && files.size > 0) {
      // Commit complete native file times, including suite hooks, once per invocation.
      for (const [name, duration] of files) {
        recordSample(samples, name, duration);
      }
      // V5 prints phase percentages, not absolute times. File durations include
      // suite hooks; historical v4 logs retain their explicit aggregate test time.
      const legacyTests = /\btests\s+([\d.]+)(m?s)(?:[,\s)]|$)/u.exec(line);
      const testsSeconds = legacyTests
        ? seconds(legacyTests[1]!, legacyTests[2]!)
        : [...files.values()].reduce((total, duration) => total + duration, 0);
      const value = (seconds(summary[1]!, summary[2]!) - testsSeconds) / files.size;
      // Vitest sums test time across workers, so wall-minus-tests measures
      // per-file overhead only for serial invocations.
      if (overhead && !hasParallelFiles && Number.isFinite(value)) {
        overhead.push(value);
      }
      files.clear();
      hasParallelFiles = false;
    }
  }
}

function readCompactLog(
  text: string,
  labels: string[],
  samples: { blacksmith: Samples; github: Samples },
  runtimeSamples: { blacksmith: Samples; github: Samples },
  runtimeDescriptors: Map<string, RuntimePlacementTiming>,
) {
  const profile = labels.some((label) => label.startsWith("blacksmith-")) ? "blacksmith" : "github";
  const starts = new Map<string, number>();
  const descriptors = readRuntimeTimingGroups(text);
  const runtimeModes = new Map<string, "runtime" | "private-qa">();
  for (const line of text.split("\n")) {
    const readiness =
      /\[shard:([^\]]+)\] \[test\] preparing (runtime|private-qa) runtime before Vitest workers/u.exec(
        line,
      );
    if (readiness) {
      const matches = descriptors.filter((group) => group.shard_name === readiness[1]);
      if (matches.length === 1) {
        const group = matches[0]!;
        const key = group.timing_key ?? group.shard_name;
        if (starts.has(key)) {
          runtimeModes.set(key, readiness[2] === "private-qa" ? "private-qa" : "runtime");
        }
      }
    }
    const event =
      /(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+.*?\[shard:([^\]]+)\] (begin|end \(exit (\d+)\))/u.exec(line);
    if (!event) {
      continue;
    }
    const timestamp = event[1]!;
    const key = event[2]!;
    const action = event[3]!;
    const exitCode = event[4];
    if (action === "begin") {
      starts.set(key, Date.parse(timestamp));
      runtimeModes.delete(key);
      continue;
    }
    const started = starts.get(key);
    if (exitCode === "0" && started !== undefined) {
      // Preserve the workload as executed. Packed plans may be serial or
      // concurrent, and admission must use the wrapper span it actually ran.
      recordSample(samples[profile], key, (Date.parse(timestamp) - started) / 1000);
      const matches = descriptors.filter((group) => (group.timing_key ?? group.shard_name) === key);
      if (matches.length === 1) {
        const group = matches[0]!;
        const observation = {
          configs: group.configs,
          env: Object.fromEntries(
            Object.entries(group.env ?? {}).toSorted(([a], [b]) => a.localeCompare(b)),
          ),
          includePatterns: group.includePatterns.toSorted(),
          pretestBuildMode: runtimeModes.get(key),
          seconds: Math.max(1, Math.round((Date.parse(timestamp) - started) / 1000)),
        };
        if (isRuntimePlacementTiming(observation)) {
          const identity = runtimePlacementTimingIdentity(observation);
          runtimeDescriptors.set(identity, observation);
          recordSample(runtimeSamples[profile], identity, (Date.parse(timestamp) - started) / 1000);
        }
      }
    }
    starts.delete(key);
  }
}

function readToolingLog(text: string, samples: Samples) {
  const descriptors = readRuntimeTimingGroups(text);
  const active = new Map<
    string,
    {
      cases: Map<string, number>;
      files: Map<string, number>;
      complete: boolean;
      declaredFiles: Set<string>;
    }
  >();
  for (const line of text.split("\n")) {
    const event = /\[shard:([^\]]+)\] (begin|end \(exit (\d+)\))/u.exec(line);
    if (event) {
      const matches = descriptors.filter(
        (group) => (group.timing_key ?? group.shard_name) === event[1],
      );
      const descriptor = matches.length === 1 ? matches[0] : undefined;
      if (!descriptor || !/^core-tooling-\d+(?:-hosted-\d+)?$/u.test(descriptor.shard_name)) {
        continue;
      }
      const shard = descriptor.shard_name;
      if (event[2] === "begin") {
        active.set(shard, {
          cases: new Map(),
          files: new Map(),
          complete: false,
          declaredFiles: new Set(descriptor.includePatterns),
        });
      } else {
        const invocation = active.get(shard);
        if (event[3] === "0" && invocation?.complete) {
          // Native file summaries include hooks. Older verbose-only logs supply
          // case-cost sums, which can exceed wall time for concurrent cases.
          for (const [file, duration] of new Map([...invocation.cases, ...invocation.files])) {
            // Tooling fixtures print nested reporters. Only this shard's
            // declared inventory can supply measurements for its real files.
            if (invocation.declaredFiles.has(file)) {
              recordSample(samples, file, Math.max(0.001, duration));
            }
          }
        }
        active.delete(shard);
      }
      continue;
    }
    const row = /\[shard:([^\]]+)\]\s+(.*)$/u.exec(line);
    const invocation = row && active.get(row[1]!);
    if (!invocation) {
      continue;
    }
    const file =
      /^✓\s+(?:\|tooling\||tooling)\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\s+\(\d+ tests?(?: \| \d+ (?:skipped|todo))*\)\s+([\d.]+)(m?s)(?:\s|$)/u.exec(
        row[2]!,
      );
    if (file) {
      invocation.files.set(file[1]!, seconds(file[2]!, file[3]!));
    } else {
      const test =
        /^✓\s+(?:\|tooling\||tooling)\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\s+> .+\s([\d.]+)(m?s)$/u.exec(
          row[2]!,
        );
      if (test) {
        invocation.cases.set(
          test[1]!,
          (invocation.cases.get(test[1]!) ?? 0) + seconds(test[2]!, test[3]!),
        );
      }
    }
    if (/^Duration\s+[\d.]+m?s(?:\s|$)/u.test(row[2]!)) {
      invocation.complete = true;
    }
  }
}

function runtimePlacementSecondsMap(observations: readonly RuntimePlacementTiming[] = []) {
  return Object.fromEntries(
    observations.map((observation) => [
      runtimePlacementTimingIdentity(observation),
      observation.seconds,
    ]),
  );
}

function compactWorkerValueMap(
  observations: readonly CompactWorkerTiming[] | undefined,
  field: "seconds" | "totalMemoryBytes",
) {
  return Object.fromEntries(
    (observations ?? []).map((observation) => [
      compactWorkerTimingIdentity(observation),
      observation[field],
    ]),
  );
}

function recordCompleteParentSamples(samples: Samples, observedParents: Set<string>) {
  const generations = new Map<
    string,
    { parent: string; expected: number; parts: Map<number, number> }
  >();
  for (const [key, values] of samples) {
    const parsed = parseCompactSplitTimingKey(key);
    if (!parsed) {
      continue;
    }
    observedParents.add(parsed.parentShardName);
    const generation = generations.get(parsed.generationKey) ?? {
      parent: parsed.parentShardName,
      expected: parsed.expectedParts,
      parts: new Map<number, number>(),
    };
    generation.parts.set(parsed.part, median(values));
    generations.set(parsed.generationKey, generation);
  }
  for (const { parent, expected, parts } of generations.values()) {
    if (parts.size !== expected) {
      continue;
    }
    // Inventory-specific child keys expire when files move. Retain the full
    // measured cost at its parent so the next inventory has a measured floor.
    // One run/profile supplies one sample, even after retries or repartitioning.
    const total = [...parts.values()].reduce((sum, duration) => sum + duration, 0);
    const direct = samples.get(parent);
    samples.set(parent, [Math.max(total, direct ? median(direct) : 0)]);
  }
}

function refitMap(
  samples: Samples,
  previous: Record<string, number> = {},
  contributingRuns = 0,
  observedParents?: Set<string>,
  minimumSamples = 2,
) {
  const next = Object.fromEntries(
    Object.entries(previous).filter(
      ([key]) => contributingRuns < MIN_PRUNE_RUNS || samples.has(key) || observedParents?.has(key),
    ),
  );
  for (const [key, values] of samples) {
    const center = median(values);
    const retained = values.filter((value) => value <= center * 2.5);
    if (retained.length >= minimumSamples) {
      const measured = median(retained);
      if (
        previous[key] === undefined ||
        Math.abs(measured - previous[key]) > previous[key] * 0.15
      ) {
        next[key] = Math.max(1, Math.round(measured));
      }
    }
  }
  return Object.fromEntries(
    Object.entries(next).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

export function refitTestTimings(
  runs: CiTimingRun[],
  previous?: CiTestTimings,
  options: { seedTooling?: boolean } = {},
) {
  const samples = {
    uiE2e: new Map<string, number[]>(),
    repoE2e: new Map<string, number[]>(),
    blacksmith: new Map<string, number[]>(),
    github: new Map<string, number[]>(),
    toolingBlacksmith: new Map<string, number[]>(),
    toolingGithub: new Map<string, number[]>(),
    compactWorkers: new Map<string, number[]>(),
  };
  const contributingRuns = {
    uiE2e: new Set<number>(),
    repoE2e: new Set<number>(),
    blacksmith: new Set<number>(),
    github: new Set<number>(),
    toolingBlacksmith: new Set<number>(),
    toolingGithub: new Set<number>(),
    compactWorkers: new Set<number>(),
  };
  const overhead: number[] = [];
  const observedParents = { blacksmith: new Set<string>(), github: new Set<string>() };
  const runtimeSamples = {
    blacksmith: new Map<string, number[]>(),
    github: new Map<string, number[]>(),
  };
  const runtimeDescriptors = new Map<string, RuntimePlacementTiming>(
    Object.values(previous?.runtimePlacementTimings ?? {})
      .flat()
      .map((observation) => [runtimePlacementTimingIdentity(observation), observation]),
  );
  const previousCompactWorkers = new Map<string, CompactWorkerTiming>(
    (previous?.compactWorkerTimings ?? []).map((observation) => [
      compactWorkerTimingIdentity(observation),
      observation,
    ]),
  );
  const compactWorkerDescriptors = new Map(previousCompactWorkers);
  const uniqueRuns = new Map<number, CiTimingRun>();
  for (const run of runs) {
    const retained = uniqueRuns.get(run.id);
    if (retained) {
      retained.logs.push(...run.logs);
    } else {
      uniqueRuns.set(run.id, { ...run, logs: [...run.logs] });
    }
  }
  for (const run of uniqueRuns.values()) {
    const current = {
      uiE2e: new Map<string, number[]>(),
      repoE2e: new Map<string, number[]>(),
      blacksmith: new Map<string, number[]>(),
      github: new Map<string, number[]>(),
      toolingBlacksmith: new Map<string, number[]>(),
      toolingGithub: new Map<string, number[]>(),
      compactWorkers: new Map<string, number[]>(),
    };
    const currentRuntime = {
      blacksmith: new Map<string, number[]>(),
      github: new Map<string, number[]>(),
    };
    for (const log of run.logs) {
      const text = stripVTControlCharacters(log.text);
      if (!options.seedTooling && (log.kind === "tooling" || log.kind === "compact")) {
        readCompactWorkerLog(text, log.labels, current.compactWorkers, compactWorkerDescriptors);
      }
      if (log.kind === "tooling") {
        const profile = log.labels.some((label) => label.startsWith("blacksmith-"))
          ? "toolingBlacksmith"
          : "toolingGithub";
        readToolingLog(text, current[profile]);
      } else if (log.kind === "compact") {
        readCompactLog(text, log.labels, current, currentRuntime, runtimeDescriptors);
      } else {
        readE2eLog(text, current[log.kind], log.kind === "uiE2e" ? overhead : undefined);
      }
    }
    for (const profile of ["blacksmith", "github"] as const) {
      recordCompleteParentSamples(current[profile], observedParents[profile]);
      for (const [identity, values] of currentRuntime[profile]) {
        recordSample(runtimeSamples[profile], identity, median(values));
      }
    }
    // Retries or duplicate reporter lines in one run must not satisfy the two-run minimum.
    for (const profile of [
      "uiE2e",
      "repoE2e",
      "blacksmith",
      "github",
      "toolingBlacksmith",
      "toolingGithub",
      "compactWorkers",
    ] as const) {
      // Missing or unparseable profile logs are not evidence that its keys disappeared.
      if (current[profile].size > 0) {
        contributingRuns[profile].add(run.id);
      }
      for (const [key, values] of current[profile]) {
        recordSample(samples[profile], key, median(values));
      }
    }
  }

  const measuredOverhead =
    overhead.length >= 2 ? Math.max(0, Math.min(5, median(overhead))) : undefined;
  const oldOverhead = previous?.uiE2e.perFileOverheadSeconds;
  const keepOverhead =
    measuredOverhead === undefined ||
    (oldOverhead !== undefined && Math.abs(measuredOverhead - oldOverhead) <= oldOverhead * 0.15);
  const runIds = [...new Set(runs.map((run) => run.id))].toSorted((a, b) => a - b);
  const sourceRunIds = (kinds: CiTimingRun["logs"][number]["kind"][]) =>
    [...uniqueRuns.values()]
      .filter((run) => run.logs.some((log) => kinds.includes(log.kind)))
      .map((run) => run.id)
      .toSorted((a, b) => a - b)
      .join(", ") || "none";
  function refitRuntime(profile: "blacksmith" | "github"): RuntimePlacementTiming[] {
    return Object.entries(
      refitMap(
        runtimeSamples[profile],
        runtimePlacementSecondsMap(previous?.runtimePlacementTimings[profile]),
        contributingRuns[profile].size,
      ),
    ).map(([identity, measuredSeconds]) =>
      Object.assign({}, runtimeDescriptors.get(identity)!, { seconds: measuredSeconds }),
    );
  }
  const timings: CiTestTimings = {
    compactGroupSeconds: {
      blacksmith: refitMap(
        samples.blacksmith,
        previous?.compactGroupSeconds.blacksmith,
        contributingRuns.blacksmith.size,
        observedParents.blacksmith,
      ),
      github: refitMap(
        samples.github,
        previous?.compactGroupSeconds.github,
        contributingRuns.github.size,
        observedParents.github,
      ),
    },
    // PRs can select arbitrary subsets. Keep unobserved classes and workloads;
    // one run, including retries, cannot establish a new class measurement.
    compactWorkerTimings: Object.entries(
      refitMap(
        samples.compactWorkers,
        compactWorkerValueMap(previous?.compactWorkerTimings, "seconds"),
        0,
      ),
    ).map(([identity, measuredSeconds]) =>
      // Capacity evidence remains conservative even when the duration stays inside
      // the retention threshold; the descriptor already holds the observed minimum.
      Object.assign({}, compactWorkerDescriptors.get(identity)!, { seconds: measuredSeconds }),
    ),
    repoE2eFileSeconds: refitMap(
      samples.repoE2e,
      previous?.repoE2eFileSeconds,
      contributingRuns.repoE2e.size,
    ),
    runtimePlacementTimings: {
      blacksmith: refitRuntime("blacksmith"),
      github: refitRuntime("github"),
    },
    source: options.seedTooling
      ? `tooling seed from successful pull_request CI merge-ref runs: ${runIds.join(", ")}; retained other timings: ${previous?.source ?? "none"}`
      : `medians from successful main CI runs: ${sourceRunIds(["compact", "uiE2e"])}; release-check runs: ${sourceRunIds(["repoE2e"])}; pull_request CI merge-ref runs (tooling files and exact compact worker observations): ${sourceRunIds(["tooling"])}`,
    // PR plans may select only part of tooling. Absence is not evidence that
    // a file disappeared; preserve unobserved measurements across those windows.
    toolingFileSeconds: {
      blacksmith: refitMap(
        samples.toolingBlacksmith,
        previous?.toolingFileSeconds.blacksmith,
        0,
        undefined,
        options.seedTooling ? 1 : 2,
      ),
      github: refitMap(
        samples.toolingGithub,
        previous?.toolingFileSeconds.github,
        0,
        undefined,
        options.seedTooling ? 1 : 2,
      ),
    },
    uiE2e: {
      fileSeconds: refitMap(
        samples.uiE2e,
        previous?.uiE2e.fileSeconds,
        contributingRuns.uiE2e.size,
      ),
      perFileOverheadSeconds: keepOverhead
        ? (oldOverhead ?? 0)
        : Math.round(measuredOverhead * 10) / 10,
    },
    updatedAt:
      runs
        .map((run) => run.createdAt.slice(0, 10))
        .toSorted()
        .at(-1) ??
      previous?.updatedAt ??
      new Date().toISOString().slice(0, 10),
    version: 1,
  };
  const changes: { key: string; old: number | undefined; next: number | undefined }[] = [];
  const comparedMaps: [string, Record<string, number>, Record<string, number> | undefined][] = [
    [
      "compactWorkerTimings",
      compactWorkerValueMap(timings.compactWorkerTimings, "seconds"),
      compactWorkerValueMap(previous?.compactWorkerTimings, "seconds"),
    ],
    [
      "compactWorkerTimings.totalMemoryBytes",
      compactWorkerValueMap(timings.compactWorkerTimings, "totalMemoryBytes"),
      compactWorkerValueMap(previous?.compactWorkerTimings, "totalMemoryBytes"),
    ],
    ...(["blacksmith", "github"] as const).map(
      (profile): [string, Record<string, number>, Record<string, number>] => [
        `runtimePlacementTimings.${profile}`,
        runtimePlacementSecondsMap(timings.runtimePlacementTimings[profile]),
        runtimePlacementSecondsMap(previous?.runtimePlacementTimings[profile]),
      ],
    ),
    [
      "compactGroupSeconds.blacksmith",
      timings.compactGroupSeconds.blacksmith,
      previous?.compactGroupSeconds.blacksmith,
    ],
    [
      "compactGroupSeconds.github",
      timings.compactGroupSeconds.github,
      previous?.compactGroupSeconds.github,
    ],
    ["uiE2e.fileSeconds", timings.uiE2e.fileSeconds, previous?.uiE2e.fileSeconds],
    ["repoE2eFileSeconds", timings.repoE2eFileSeconds, previous?.repoE2eFileSeconds],
    [
      "toolingFileSeconds.blacksmith",
      timings.toolingFileSeconds.blacksmith,
      previous?.toolingFileSeconds.blacksmith,
    ],
    [
      "toolingFileSeconds.github",
      timings.toolingFileSeconds.github,
      previous?.toolingFileSeconds.github,
    ],
    [
      "uiE2e",
      { perFileOverheadSeconds: timings.uiE2e.perFileOverheadSeconds },
      oldOverhead === undefined ? undefined : { perFileOverheadSeconds: oldOverhead },
    ],
  ];
  for (const [prefix, next, old] of comparedMaps) {
    for (const key of new Set([...Object.keys(next), ...Object.keys(old ?? {})])) {
      const value = next[key];
      const oldValue = old?.[key];
      if (value !== oldValue) {
        changes.push({ key: `${prefix}.${key}`, old: oldValue, next: value });
      }
    }
  }
  if (previous && changes.length === 0) {
    timings.source = previous.source;
    timings.updatedAt = previous.updatedAt;
  }
  return {
    timings,
    changes: changes.toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    runIds,
    contributingRunIds: {
      blacksmith: [...contributingRuns.blacksmith].toSorted((a, b) => a - b),
      github: [...contributingRuns.github].toSorted((a, b) => a - b),
      repoE2e: [...contributingRuns.repoE2e].toSorted((a, b) => a - b),
      uiE2e: [...contributingRuns.uiE2e].toSorted((a, b) => a - b),
      toolingBlacksmith: [...contributingRuns.toolingBlacksmith].toSorted((a, b) => a - b),
      toolingGithub: [...contributingRuns.toolingGithub].toSorted((a, b) => a - b),
      compactWorkers: [...contributingRuns.compactWorkers].toSorted((a, b) => a - b),
    },
  };
}
