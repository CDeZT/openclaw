#!/usr/bin/env node
// Task-only caller for #154839. Remove with its CI step after retaining the proof.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  hasUnjoinedWork,
  runManagedCommand,
  terminateManagedChild,
} from "./lib/managed-child-process.mts";
import { pnpmLockfileDocuments } from "./lib/pnpm-lockfile-documents.mjs";

const BASELINE = "a63d697549fe75890000fa1ab2e92335d120c907";
const TEST = "OpenClawUITests/ChatCatalogUITests/testGuestModelPolicyRetiresOpenChoices";
const OVERLAY = {
  "apps/ios/UITests/ChatCatalogUITests.swift":
    "d3ce5dcb992a1dd2d78377728d8b5f56862cddc98eebaff2ba179b1cb74ff8b1",
  "scripts/test-ios-shell-gateway.mjs":
    "ff4c827622db9d35844df89adc3d71e7d6338f06bb695e66b9ea784504f39912",
};
const SCREENSHOTS = [
  "guest-model-permitted-inline",
  "guest-model-permitted-actions",
  "guest-model-null-inline",
  "guest-model-null-actions",
  "guest-model-held-actions",
  "guest-model-failed-inline",
  "guest-model-failed-actions",
  "guest-model-recovered-inline",
  "guest-model-recovered-actions",
];
const POLICY_FAILURES = [
  "guest-model-policy:permitted:current-selection",
  "guest-model-policy:permitted:approved-default",
  "guest-model-policy:null:current-selection",
  "guest-model-policy:null:default-absent",
  "guest-model-policy:held:open-provider-retired",
  "guest-model-policy:held:open-choice-retired",
  "guest-model-policy:held:default-absent",
  "guest-model-policy:failed:current-selection",
  "guest-model-policy:failed:provider-retired",
  "guest-model-policy:failed:default-absent",
  "guest-model-policy:recovered:current-selection",
  "guest-model-policy:recovered:approved-default",
];
const REQUIRED_POLICY_FAILURES = [
  "guest-model-policy:null:default-absent",
  "guest-model-policy:held:open-choice-retired",
];
const EQUAL_INPUTS = [
  "apps/ios/project.yml",
  "apps/ios/.swiftlint.yml",
  "apps/shared/OpenClawKit/Package.swift",
  "apps/swabble/Package.swift",
  "apps/shared/OpenClawWatchRTC",
  "packages/mermaid-renderer",
  "packages/normalization-core",
  "scripts/prepare-apple-mermaid.mjs",
  "scripts/pnpm-runner.mts",
  "scripts/run-node-package-bin.mts",
  "scripts/ios-configure-signing.sh",
  "scripts/ios-team-id.sh",
  "scripts/ios-write-version-xcconfig.sh",
  "scripts/ios-write-swift-filelist.mts",
  "scripts/check-swift-tools.sh",
  "config/swiftformat",
];

assert.equal(process.platform, "darwin", "This capture runs only in the existing macOS CI job");
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.GITHUB_EVENT_NAME, "pull_request");
assert.equal(process.env.GITHUB_REPOSITORY, "openclaw/openclaw");
assert.equal(process.env.GITHUB_RUN_ATTEMPT, "1");
assert.equal(process.env.GITHUB_REF, "refs/pull/154839/merge");
assert.equal(process.env.IOS_GUEST_POLICY_PHASE, "smoke");
assert.equal(process.env.HISTORICAL_TARGET, "false");
assert.equal(process.argv.length, 2, "This task caller has no selectable inputs");
const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
const pullRequest = event.pull_request;
assert.equal(event.number, 154839);
assert.equal(pullRequest.number, event.number);
for (const repository of [event.repository, pullRequest.head.repo, pullRequest.base.repo]) {
  assert.equal(repository.full_name, "openclaw/openclaw");
}
assert.equal(pullRequest.head.ref, "feat/guest-model-discovery");
assert.equal(pullRequest.base.ref, "main");
for (const sha of [pullRequest.head.sha, pullRequest.base.sha, pullRequest.merge_commit_sha]) {
  assert.match(sha, /^[a-f0-9]{40}$/u);
}
assert.equal(process.env.IOS_GUEST_POLICY_PUBLIC_HEAD, pullRequest.head.sha);
assert.equal(process.env.GITHUB_SHA, pullRequest.merge_commit_sha);
assert.match(process.env.IOS_GUEST_POLICY_BASE_SHA ?? "", /^[a-f0-9]{40}$/u);
const root = fileURLToPath(new URL("../", import.meta.url));
const simulator = process.env.IOS_GUEST_POLICY_SIMULATOR;
assert.match(simulator ?? "", /^[A-Fa-f0-9-]{36}$/u);
assert.match(process.env.IOS_GUEST_POLICY_CHECKOUT_SHA ?? "", /^[a-f0-9]{40}$/u);
assert.ok(process.env.RUNNER_TEMP);
const output = path.join(root, "apps/ios/build/LifecycleTestResults/GuestModelPolicyPR154839");
fs.mkdirSync(output);
const temporary = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, "pr-154839-ios-"));
const baselineRoot = path.join(temporary, "baseline");
const receipt = {
  baseline: BASELINE,
  publicHead: pullRequest.head.sha,
  eventBase: pullRequest.base.sha,
  workflowSha: process.env.GITHUB_WORKFLOW_SHA,
  runId: process.env.GITHUB_RUN_ID,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  job: process.env.GITHUB_JOB,
  test: TEST,
  simulator,
  appearance: "light",
  language: "en",
  region: "US",
  overlay: OVERLAY,
  startedAt: new Date().toISOString(),
  commands: [],
  revisions: {},
  cleanup: {},
};
let interrupted;
let unjoined = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    interrupted = signal;
  });
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function start(
  label,
  bin,
  args,
  { cwd = root, env = process.env, readyText, cleanup = false } = {},
) {
  assert.ok(cleanup || !interrupted, `Capture interrupted by ${interrupted}`);
  const command = { label, bin, args, cwd, startedAt: new Date().toISOString() };
  receipt.commands.push(command);
  const prefix = path.join(output, "logs", label);
  fs.mkdirSync(path.dirname(prefix), { recursive: true });
  const descriptors = ["stdout", "stderr"].map((stream) =>
    fs.openSync(`${prefix}.${stream}.log`, "wx"),
  );
  const controller = new AbortController();
  const ready = Promise.withResolvers();
  let child;
  let settled = false;
  let readinessOutput = "";
  let logError;
  const done = runManagedCommand({
    bin,
    args,
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    requireProcessTreeExit: true,
    signal: controller.signal,
    onReady(processChild) {
      child = processChild;
      command.pid = child.pid;
      for (const [index, stream] of [child.stdout, child.stderr].entries()) {
        stream.on("data", (chunk) => {
          try {
            fs.writeSync(descriptors[index], chunk);
            if (readyText && !readinessOutput.includes(readyText)) {
              readinessOutput = `${readinessOutput}${chunk.toString()}`.slice(-4096);
              if (readinessOutput.includes(readyText)) {
                ready.resolve();
              }
            }
          } catch (error) {
            logError = error;
            controller.abort();
          }
        });
      }
      if (!readyText) {
        ready.resolve();
      }
    },
  })
    .then(
      (code) => {
        command.exitCode = code;
        command.processTree = "terminated";
        if (logError) {
          throw logError;
        }
        return code;
      },
      (error) => {
        unjoined ||= hasUnjoinedWork(error);
        command.error = String(error);
        command.processTree = hasUnjoinedWork(error) ? "unconfirmed" : "terminated";
        throw error;
      },
    )
    .finally(() => {
      settled = true;
      command.finishedAt = new Date().toISOString();
      descriptors.forEach((descriptor) => fs.closeSync(descriptor));
      ready.reject(new Error(`${label} exited before its readiness message`));
    });
  // Observe background failures immediately; their owner still awaits completion.
  void done.catch(() => {});
  void ready.promise.catch(() => {});
  return {
    ready: ready.promise,
    done,
    stdout: `${prefix}.stdout.log`,
    async stop() {
      const exitedBeforeStop = settled;
      if (!settled && child) {
        terminateManagedChild(child, "SIGINT");
      }
      const forceCleanup = setTimeout(() => controller.abort(), 5_000);
      try {
        const code = await done;
        assert.ok(!exitedBeforeStop, `${label} exited before capture cleanup`);
        assert.ok(code === 0 || code === 130, `${label} failed with exit ${code}`);
        return code;
      } finally {
        clearTimeout(forceCleanup);
      }
    },
  };
}

async function checked(label, bin, args, options) {
  const command = start(label, bin, args, options);
  assert.equal(await command.done, 0, `${label} failed; see retained command logs`);
  return fs.readFileSync(command.stdout, "utf8").trim();
}

async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function deviceState(label) {
  const inventory = JSON.parse(
    await checked(label, "xcrun", ["simctl", "list", "devices", "available", "--json"]),
  );
  const [runtime, device] =
    Object.entries(inventory.devices)
      .flatMap(([runtimeId, devices]) => devices.map((item) => [runtimeId, item]))
      .find(([, item]) => item.udid === simulator) ?? [];
  assert.ok(
    device?.isAvailable && device.name.startsWith("iPhone"),
    "The voice-test iPhone must remain available",
  );
  return { runtime, ...device };
}

async function extractRevision(name, directory, code) {
  const bundle = path.join(directory, "test.xcresult");
  const summary = JSON.parse(
    await checked(`${name}-summary`, "xcrun", [
      "xcresulttool",
      "get",
      "test-results",
      "summary",
      "--path",
      bundle,
      "--compact",
    ]),
  );
  writeJson(path.join(directory, "summary.json"), summary);
  const attachments = path.join(directory, "attachments");
  await checked(`${name}-export`, "xcrun", [
    "xcresulttool",
    "export",
    "attachments",
    "--path",
    bundle,
    "--output-path",
    attachments,
  ]);
  const manifest = JSON.parse(fs.readFileSync(path.join(attachments, "manifest.json"), "utf8"));
  const entries = manifest.flatMap((test) => test.attachments);
  const selected = [
    ...SCREENSHOTS.map((screenshot) => {
      const matches = entries.filter((entry) =>
        entry.suggestedHumanReadableName.startsWith(screenshot),
      );
      assert.equal(matches.length, 1, `Expected exactly one ${screenshot} PNG`);
      matches[0].kind = "png";
      return matches[0];
    }),
    ...entries
      .filter((entry) => entry.suggestedHumanReadableName.startsWith("guest-model-wire-"))
      .map((entry) => {
        entry.kind = "json";
        return entry;
      }),
  ];
  assert.equal(
    selected.filter((entry) => entry.kind === "json").length,
    8,
    "Expected all eight wire attachments",
  );
  for (const entry of selected) {
    assert.equal(path.basename(entry.exportedFileName), entry.exportedFileName);
    const file = path.join(attachments, entry.exportedFileName);
    const bytes = fs.readFileSync(file);
    if (entry.kind === "png") {
      assert.ok(bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")), "Invalid PNG");
    } else {
      JSON.parse(bytes.toString("utf8"));
    }
    entry.sha256 = await hashFile(file);
  }
  writeJson(path.join(directory, "selected-attachments.json"), selected);
  assert.equal(summary.skippedTests, 0, "The selected test must execute");
  assert.equal(summary.expectedFailures, 0, "No expected-failure waiver is used");
  if (name === "baseline") {
    assert.notEqual(code, 0, "The true baseline must retain its failing exit");
    assert.equal(summary.result, "Failed");
    assert.equal(summary.failedTests, 1);
    assert.ok(Array.isArray(summary.testFailures) && summary.testFailures.length > 0);
    const classified = summary.testFailures.map((failure) => ({
      failure,
      ids:
        typeof failure.failureText === "string"
          ? (failure.failureText.match(/guest-model-policy:[a-z-]+:[a-z-]+/gu) ?? [])
          : [],
    }));
    writeJson(path.join(directory, "policy-failures.json"), {
      classified,
      allowed: POLICY_FAILURES,
      required: REQUIRED_POLICY_FAILURES,
    });
    const observed = new Set();
    for (const { ids } of classified) {
      assert.equal(ids.length, 1, "Every baseline failure must name exactly one policy assertion");
      assert.ok(POLICY_FAILURES.includes(ids[0]), `Unexpected baseline failure: ${ids[0]}`);
      observed.add(ids[0]);
    }
    for (const required of REQUIRED_POLICY_FAILURES) {
      assert.ok(observed.has(required), `Baseline did not prove ${required}`);
    }
  } else {
    assert.equal(code, 0, "Candidate test failed");
    assert.equal(summary.result, "Passed");
    assert.equal(summary.failedTests, 0);
    assert.equal(summary.passedTests, 1);
  }
}

async function capture(name, cwd, revision) {
  const directory = path.join(output, name);
  const result = (receipt.revisions[name] = { revision, directory, stage: "prepare" });
  fs.mkdirSync(directory);
  const env = {
    ...process.env,
    GIT_COMMIT: revision,
    OPENCLAW_BUILD_TIMESTAMP: receipt.startedAt,
    TEST_RUNNER_OPENCLAW_IOS_GUEST_MODEL_POLICY_PROOF: "1",
    TEST_RUNNER_OPENCLAW_IOS_LIVE_SETUP_CODE:
      '{"url":"ws://127.0.0.1:19876","token":"synthetic-navigation-token"}',
    TEST_RUNNER_OPENCLAW_IOS_MODEL_POLICY_FIXTURE_URL: "http://127.0.0.1:19876",
  };
  let fixture;
  let video;
  const errors = [];
  try {
    for (const script of ["ios-configure-signing.sh", "ios-write-version-xcconfig.sh"]) {
      await checked(`${name}-${script}`, "/bin/bash", [`scripts/${script}`], { cwd, env });
    }
    await checked(`${name}-filelist`, process.execPath, ["scripts/ios-write-swift-filelist.mjs"], {
      cwd,
      env,
    });
    await checked(
      `${name}-project`,
      "xcodegen",
      ["generate", "--spec", "apps/ios/project.yml", "--project", "apps/ios"],
      { cwd, env },
    );
    const args = [
      "-project",
      "apps/ios/OpenClaw.xcodeproj",
      "-scheme",
      "OpenClawUITests",
      "-configuration",
      "Debug",
      "-destination",
      `platform=iOS Simulator,id=${simulator}`,
      // Candidate reuses the products from this job's app/voice build. Baseline
      // has its own products and cannot overwrite or qualify the candidate.
      ...(name === "baseline"
        ? ["-derivedDataPath", path.join(temporary, "baseline-derived-data")]
        : []),
      "-jobs",
      "4",
      "-parallel-testing-enabled",
      "NO",
      `-only-testing:${TEST}`,
      "-testLanguage",
      "en",
      "-testRegion",
      "US",
    ];
    result.stage = "build";
    const settings = JSON.parse(
      await checked(
        `${name}-build-settings`,
        "xcodebuild",
        [...args, "-showBuildSettings", "-json"],
        { cwd, env },
      ),
    );
    const testSettings = settings.filter((target) => target.target === "OpenClawUITests");
    assert.equal(testSettings.length, 1, "Expected the real UI-test target's build settings");
    result.buildProducts = testSettings[0].buildSettings.BUILD_DIR;
    assert.ok(path.isAbsolute(result.buildProducts));
    await checked(
      `${name}-build`,
      "xcodebuild",
      [...args, "-resultBundlePath", path.join(directory, "build.xcresult"), "build-for-testing"],
      { cwd, env },
    );
    const resolved = JSON.parse(
      fs.readFileSync(
        path.join(
          cwd,
          "apps/ios/OpenClaw.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved",
        ),
        "utf8",
      ),
    );
    writeJson(path.join(directory, "Package.resolved.json"), resolved);
    result.packagePins = resolved.pins;
    const device = await deviceState(`${name}-device-before`);
    assert.ok(["Booted", "Shutdown"].includes(device.state));
    if (device.state === "Booted") {
      await checked(`${name}-shutdown`, "xcrun", ["simctl", "shutdown", simulator]);
    }
    await checked(`${name}-erase`, "xcrun", ["simctl", "erase", simulator]);
    await checked(`${name}-boot`, "xcrun", ["simctl", "boot", simulator]);
    await checked(`${name}-boot-ready`, "xcrun", ["simctl", "bootstatus", simulator, "-b"]);
    await checked(`${name}-appearance`, "xcrun", [
      "simctl",
      "ui",
      simulator,
      "appearance",
      "light",
    ]);
    result.device = await deviceState(`${name}-device-ready`);
    result.stage = "test";
    fixture = start(
      `${name}-fixture`,
      process.execPath,
      ["scripts/test-ios-shell-gateway.mjs", "--guest-model-policy"],
      { cwd, env, readyText: "Synthetic Gateway listening on loopback:19876" },
    );
    await fixture.ready;
    video = start(
      `${name}-video`,
      "xcrun",
      [
        "simctl",
        "io",
        simulator,
        "recordVideo",
        "--codec",
        "h264",
        path.join(directory, "screen.mp4"),
      ],
      { readyText: "Recording started" },
    );
    await video.ready;
    result.testExitCode = await start(
      `${name}-test`,
      "xcodebuild",
      [
        ...args,
        "-resultBundlePath",
        path.join(directory, "test.xcresult"),
        "test-without-building",
      ],
      { cwd, env },
    ).done;
    const finalWire = await fetch("http://127.0.0.1:19876/model-policy", {
      signal: AbortSignal.timeout(3_000),
    });
    assert.equal(finalWire.status, 200);
    writeJson(path.join(directory, "fixture-final.json"), await finalWire.json());
  } catch (error) {
    errors.push(error);
  } finally {
    const stopped = await Promise.allSettled([video?.stop(), fixture?.stop()]);
    result.cleanup = stopped.map((stop, index) => ({
      process: index === 0 ? "video" : "fixture",
      result: stop.status === "fulfilled" ? (stop.value ?? "not-started") : String(stop.reason),
    }));
    writeJson(path.join(directory, "result.json"), result);
    errors.push(...stopped.filter((stop) => stop.status === "rejected").map((stop) => stop.reason));
  }
  if (errors.length) {
    result.errors = errors.map(String);
    throw new AggregateError(
      errors,
      `${name} capture failed; original and cleanup errors retained`,
    );
  }
  result.stage = "extract";
  const recording = path.join(directory, "screen.mp4");
  result.recording = { bytes: fs.statSync(recording).size, sha256: await hashFile(recording) };
  assert.ok(result.recording.bytes > 0, "Recording is empty");
  await extractRevision(name, directory, result.testExitCode);
  result.status = name === "baseline" ? "failed-model-policy-assertions" : "passed";
  result.stage = "complete";
  writeJson(path.join(directory, "result.json"), result);
  console.log(`${name}: xcodebuild exit ${result.testExitCode}; ${result.status}`);
}

try {
  receipt.candidate = await checked("candidate-sha", "git", ["rev-parse", "HEAD"]);
  assert.equal(receipt.candidate, process.env.IOS_GUEST_POLICY_CHECKOUT_SHA);
  assert.equal(receipt.candidate, pullRequest.merge_commit_sha);
  const commit = await checked("candidate-commit", "git", [
    "--no-replace-objects",
    "cat-file",
    "commit",
    receipt.candidate,
  ]);
  // Raw headers retain both parents even when the checkout is shallow.
  const headers = commit.split("\n\n", 1)[0].split("\n");
  const parents = headers.filter((line) => line.startsWith("parent ")).map((line) => line.slice(7));
  // Preflight resolves the pinned merge's base; a PR event may retain an older base.
  assert.deepEqual(parents, [process.env.IOS_GUEST_POLICY_BASE_SHA, pullRequest.head.sha]);
  assert.match(headers[0], /^tree [a-f0-9]{40}$/u);
  receipt.candidateTree = headers[0].slice(5);
  receipt.integratedMerge = {
    sha: receipt.candidate,
    tree: receipt.candidateTree,
    baseParent: parents[0],
    headParent: parents[1],
  };
  await checked("baseline-fetch", "git", [
    "fetch",
    "--no-tags",
    "--no-recurse-submodules",
    "--depth=1",
    "origin",
    BASELINE,
  ]);
  receipt.baselineTree = await checked("baseline-tree", "git", ["rev-parse", `${BASELINE}^{tree}`]);
  const baselineInputs = await checked("baseline-inputs", "git", [
    "ls-tree",
    BASELINE,
    "--",
    ...EQUAL_INPUTS,
  ]);
  const candidateInputs = await checked("candidate-inputs", "git", [
    "ls-tree",
    "HEAD",
    "--",
    ...EQUAL_INPUTS,
  ]);
  assert.equal(
    baselineInputs.split("\n").length,
    EQUAL_INPUTS.length,
    "Every native input must exist",
  );
  assert.equal(
    candidateInputs,
    baselineInputs,
    "Native dependencies and build inputs must match the actual baseline",
  );
  await checked("native-source-diff", "git", [
    "diff",
    BASELINE,
    "HEAD",
    "--",
    "apps/ios",
    "apps/shared/OpenClawKit",
    "apps/swabble",
  ]);
  for (const [file, expected] of Object.entries(OVERLAY)) {
    assert.equal(
      await hashFile(path.join(root, file)),
      expected,
      `Frozen overlay changed: ${file}`,
    );
    fs.mkdirSync(path.dirname(path.join(output, "overlay", file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(output, "overlay", file));
  }
  await checked("baseline-worktree", "git", [
    "worktree",
    "add",
    "--detach",
    baselineRoot,
    BASELINE,
  ]);
  for (const [file, expected] of Object.entries(OVERLAY)) {
    fs.copyFileSync(path.join(root, file), path.join(baselineRoot, file));
    assert.equal(await hashFile(path.join(baselineRoot, file)), expected);
  }
  const overlayPaths = await checked(
    "baseline-overlay-paths",
    "git",
    ["diff", "--name-only", "HEAD"],
    { cwd: baselineRoot },
  );
  assert.deepEqual(overlayPaths.split("\n").toSorted(), Object.keys(OVERLAY).toSorted());
  await checked("baseline-overlay", "git", ["diff", "--binary", "HEAD"], { cwd: baselineRoot });
  const [candidateDocuments, baselineDocuments] = [root, baselineRoot].map((cwd) =>
    pnpmLockfileDocuments(fs.readFileSync(path.join(cwd, "pnpm-lock.yaml"), "utf8")),
  );
  const [candidateLock, baselineLock] = [candidateDocuments, baselineDocuments].map((documents) =>
    parseYaml(documents.dependencies),
  );
  const environments = [candidateDocuments, baselineDocuments].map((documents) =>
    documents.environment === null ? null : parseYaml(documents.environment),
  );
  assert.deepEqual(
    environments[0],
    environments[1],
    "The locked preparation environment must match across the pair",
  );
  assert.deepEqual(
    candidateLock.importers["packages/mermaid-renderer"],
    baselineLock.importers["packages/mermaid-renderer"],
  );
  for (const [group, dependency] of [
    ["dependencies", "ws"],
    ["devDependencies", "tsx"],
  ]) {
    assert.deepEqual(
      candidateLock.importers["."][group][dependency],
      baselineLock.importers["."][group][dependency],
    );
  }
  receipt.nodeDependencies = {
    baselineLock: await hashFile(path.join(baselineRoot, "pnpm-lock.yaml")),
    candidateLock: await hashFile(path.join(root, "pnpm-lock.yaml")),
    environmentDocuments: {
      baseline: baselineDocuments.environment,
      candidate: candidateDocuments.environment,
    },
    mermaid: candidateLock.importers["packages/mermaid-renderer"],
    ws: candidateLock.importers["."].dependencies.ws,
    tsx: candidateLock.importers["."].devDependencies.tsx,
    reuse:
      "Both revisions use the same installed dependency directories; no install or reconciliation",
  };
  for (const directory of ["node_modules", "packages/mermaid-renderer/node_modules"]) {
    assert.ok(fs.statSync(path.join(root, directory)).isDirectory());
    fs.symlinkSync(path.join(root, directory), path.join(baselineRoot, directory));
  }
  receipt.node = process.version;
  receipt.xcode = await checked("xcode-version", "xcodebuild", ["-version"]);
  receipt.swift = await checked("swift-version", "swift", ["--version"]);
  receipt.xcodegen = await checked("xcodegen-version", "xcodegen", ["--version"]);
  receipt.runtimes = JSON.parse(
    await checked("simulator-runtimes", "xcrun", ["simctl", "list", "runtimes", "--json"]),
  );
  receipt.initialDevice = await deviceState("simulator-initial-device");
  await checked("xcresult-export-help", "xcrun", [
    "xcresulttool",
    "export",
    "attachments",
    "--help",
  ]);
  const failures = [];
  for (const [name, cwd, revision] of [
    ["baseline", baselineRoot, BASELINE],
    ["candidate", root, receipt.candidate],
  ]) {
    try {
      await capture(name, cwd, revision);
    } catch (error) {
      unjoined ||= hasUnjoinedWork(error);
      receipt.revisions[name].error = String(error);
      writeJson(path.join(output, name, "result.json"), receipt.revisions[name]);
      failures.push(error);
      if (interrupted || unjoined) {
        break;
      }
    }
  }
  if (failures.length) {
    throw new AggregateError(
      failures,
      "The before/after pair is incomplete; setup errors are not regression proof",
    );
  }
  assert.notEqual(
    receipt.revisions.candidate.buildProducts,
    receipt.revisions.baseline.buildProducts,
  );
  assert.deepEqual(
    receipt.revisions.candidate.packagePins,
    receipt.revisions.baseline.packagePins,
    "Resolved Swift packages changed across the pair",
  );
  assert.equal(
    receipt.revisions.candidate.device.runtime,
    receipt.revisions.baseline.device.runtime,
  );
  receipt.status = "captured-baseline-failure-and-candidate-pass; media inspection still required";
} catch (error) {
  unjoined ||= hasUnjoinedWork(error);
  receipt.status = "failed";
  receipt.error = String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  writeJson(path.join(output, "receipt.json"), receipt);
  if (!unjoined) {
    try {
      const before = await checked(
        "cleanup-worktrees",
        "git",
        ["worktree", "list", "--porcelain"],
        { cleanup: true },
      );
      if (before.includes(`worktree ${baselineRoot}\n`)) {
        await checked(
          "remove-owned-baseline",
          "git",
          ["worktree", "remove", "--force", baselineRoot],
          { cleanup: true },
        );
        assert.ok(!fs.existsSync(baselineRoot));
      }
      const worktrees = await checked(
        "remaining-worktrees",
        "git",
        ["worktree", "list", "--porcelain"],
        { cleanup: true },
      );
      assert.ok(!worktrees.includes(`worktree ${baselineRoot}\n`));
      receipt.cleanup.baselineWorktree = "removed-and-verified";
      fs.rmSync(temporary, { recursive: true });
      receipt.cleanup.derivedData = "removed-owned-builds";
    } catch (error) {
      receipt.cleanup.error = String(error);
      receipt.status = "failed";
      process.exitCode = 1;
    }
  } else {
    receipt.cleanup.baselineWorktree = "retained: process cleanup unconfirmed";
  }
  receipt.finishedAt = new Date().toISOString();
  writeJson(path.join(output, "receipt.json"), receipt);
}
