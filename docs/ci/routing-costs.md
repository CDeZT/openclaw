---
summary: "Measured CI provider costs, routing decisions, and the 15-minute qualification"
title: "CI routing costs"
read_when:
  - You are changing CI provider placement or packing budgets
  - You need to distinguish measured workflow walls from planner estimates
---

## Routing from measured wall time

Use GitHub-hosted runners for independent checks that fit the workflow's remaining time. Retain Blacksmith where the measured job tail threatens completion. Qualify RunsOn by workload before assigning it a production tier. Requested Blacksmith 8/16/32 labels delivered 2/4/8 CPUs in the capacity probe; labels are not worker counts.

The table compares eleven successful B1/R1 main runs with five later successful main runs: `35679872894`, `35679457587`, `35678156129`, `35677164460`, and `35675497006`. These are longitudinal observations with different source revisions, not controlled provider comparisons. Values are median [maximum] complete job seconds; a dash means unmeasured. Existing trust, retry, and [hosted assignment admission](/ci/runners#hybrid-hosted-assignment-guard) still apply.

| Job family                                                 |            Blacksmith |                               GitHub-hosted | Hybrid placement               |
| ---------------------------------------------------------- | --------------------: | ------------------------------------------: | ------------------------------ |
| `preflight`                                                |               46 [48] |                                           — | Blacksmith; starts the graph   |
| `security-fast`                                            |                     — |                                     45 [66] | Hosted when admitted           |
| `build-artifacts`                                          |             280 [314] |                                   599 [898] | Blacksmith 16-class            |
| `check-lint`                                               |             461 [499] |                                   624 [631] | Hosted on admitted main pushes |
| `check-lint-core-1` / `-2`                                 |                     — |                       311 [377] / 332 [358] | Hosted                         |
| `check-prod-types`                                         |                     — |                                   240 [282] | Hosted                         |
| `check-test-types`                                         |             358 [387] |                                   608 [664] | Hosted on admitted main pushes |
| `check-test-types-core-1` / `-2`                           | 281 [321] / 257 [329] |                       521 [572] / 496 [524] | Hosted when admitted           |
| `check-dependencies`                                       |             228 [260] |                                   434 [476] | Hosted when admitted           |
| `check-additional-extension-package-boundary`              |             200 [221] |                                   287 [377] | Hosted when admitted           |
| `check-additional-runtime-topology-architecture`           |             133 [161] |                                   289 [320] | Hosted when admitted           |
| `check-additional-boundaries`                              |                     — |                                   217 [232] | Hosted                         |
| `check-bundled-channel-config-metadata`                    |                     — |                                   107 [140] | Hosted                         |
| `check-guards` / `check-npm-lock`                          |                     — |                         148 [192] / 72 [82] | Hosted                         |
| `check-prompt-snapshots` / `check-source-contracts`        |                     — |                        76 [108] / 100 [104] | Hosted                         |
| Fast baseline / Bun launcher / bundled protocol / coercion |                     — | 158 [167] / 110 [147] / 211 [223] / 64 [89] | Hosted                         |
| Fast channel / plugin contracts                            |                     — |                       322 [325] / 225 [248] | Hosted                         |
| `control-ui-performance`                                   |                     — |                                   120 [130] | Hosted                         |
| Docs / Python skills / native and Control UI i18n          |                     — |                        No comparable sample | Retain existing hosted routes  |
| `openclaw/ci-gate`                                         |                     — |                                       3 [6] | Hosted                         |

Independent hosted checks reached at most 664 seconds in this sample. Artifact builds reached 898 seconds before the shared preflight and gate; they retain Blacksmith. Only the gate depends on `build-artifacts`: the workflow does not contain a serial build-to-test job dependency.

| Test family                               | Available complete-job evidence                                                    | Placement and remaining measurement                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Compact large, baseline bin 13            | Blacksmith 932 [967]s across five runs                                             | Retain Blacksmith; correct underestimated serial packing                                   |
| Other compact large bins                  | Blacksmith 57–616s                                                                 | No hosted comparator for the exact inventories                                             |
| Compact small bins                        | Blacksmith 70–731s; bin 23 median 668s                                             | No hosted comparator for the exact inventories                                             |
| Whole agents-support historical benchmark | Blacksmith 706s; hosted 1909s                                                      | Retain Blacksmith for this parallel-heavy workload; do not apply its ratio to every family |
| Changed-extension envelopes               | Recent 47-row PR sample: median 281s, maximum 473s; another sample has a 982s tail | Retain current runner and process boundaries; combined jobs need native proof              |
| UI unit shards                            | Hosted 296/411/317s, one run                                                       | Hosted when admitted                                                                       |
| Control UI E2E shards 1–12                | Blacksmith 269–526s, one run                                                       | Retain 16-class; hosted comparison missing                                                 |
| Browser-extension E2E                     | Hosted 232s, one run                                                               | Hosted when admitted                                                                       |
| Real-Gateway UI E2E                       | Blacksmith 712s, one run                                                           | Retain 32-class                                                                            |
| Windows                                   | Historical Blacksmith 676/797s on the old two-row inventory                        | Retain native route; current five-row and hosted comparison missing                        |
| macOS Node / Swift                        | No successful sample in these receipts                                             | Retain native routes; no latency claim                                                     |

Numbered compact bins change when membership changes. A matching suffix does not establish a matching workload. Full manual native qualification, including iOS and Android, is not proven within fifteen minutes by these Linux measurements.

## RunsOn remains unqualified

The [on-demand pilot](https://github.com/openclaw/openclaw/actions/runs/35549787290) measured the two critical compact jobs at 561/816 seconds on Blacksmith versus 755/1259 seconds on `c8i.4xlarge`: 35%/54% slower. Full Gateway-core failed on AWS at every tested worker count. Cron scaled from 156 to 138 seconds on `c8i.8xlarge` and 126 to 110 seconds on `c8a.8xlarge` at 8 versus 16 workers, but lacks a matching Blacksmith control. Checks, artifact builds, extensions, and UI have no pilot comparison.

The third tier must be Spot-first, with `spot=true` and automatic on-demand fallback when Spot capacity is unavailable. The [provider's fallback documentation](https://runs-on.com/docs/costs/spot-pricing/) describes an additional 2–3 seconds for no-capacity fallback, not a complete assignment SLA. The on-demand pilot does not qualify a Spot route.

Historical `c8i.4xlarge` Spot quotes ranged from $0.3461 to $0.6712 per hour across availability zones; the benchmark used $0.3941/hour ($0.006568/minute), versus $0.74968/hour on-demand. Price the first allocation at Spot and any no-capacity or interruption recovery allocation at its actual on-demand rate. For illustration, 300 job seconds plus 31 allocation seconds cost about $0.0362 Spot compute or $0.0689 on-demand compute, before teardown, storage, networking, and control-plane cost. The earlier $0.09 sample is neither a flat job price nor an on-demand tariff.

| `c8i.4xlarge` allocation       | Historical compute rate | Illustrative 331-second allocation |
| ------------------------------ | ----------------------: | ---------------------------------: |
| Spot first attempt             |            $0.3941/hour |                            $0.0362 |
| On-demand fallback or recovery |           $0.74968/hour |                            $0.0689 |

These September 17 quotes are not current bids. No expected blended rate is claimed without observed fallback and interruption frequencies. The illustrative job is not qualified for the recovery wall.

Interruption recovery belongs in the original 900-second workflow wall. RunsOn [v3.3 permits two automatic reruns](https://runs-on.com/changelog/v3.3.0/) with `retry=when-interrupted`: it waits for the entire workflow attempt to finish, then reruns failed jobs and dependents. A shard-only doubled duration misses that wait. The unmodified recovery contract therefore requires `first-attempt completion + retry delays + both failed/dependent replays <= 900s`.

A proposed bounded policy computes labels directly from `github.run_attempt`, outside the retained preflight matrix: first attempt uses `spot=true/retry=when-interrupted`; subsequent attempts use `spot=false/retry=false`. Every RunsOn job must use the policy so a sibling cannot trigger another automatic rerun. This needs live proof of failed-job-only reevaluation, on-demand assignment, and no third attempt before use. With that behavior proven, admission becomes `first-attempt completion + recovery delay + one full recovery replay <= 900s`. A 720-second first attempt leaves only 180 seconds; 31 seconds of assignment plus 60 seconds of setup leaves 89 seconds for tests, retry dispatch, dependents, and the gate. Only off-critical-path jobs fitting that remaining window qualify.

No production family has the required Spot and recovery evidence yet. A third tier needs verified access to the existing stack, a real backend/profile route with compatible recovery behavior, and a bounded dispatch for the selected medium workload. Public endpoint health alone does not establish administration or cleanup access. Keep the two-tier route while that qualification is unavailable; do not silently use the hybrid hosted retry path as RunsOn recovery proof.

## Packing and cost arithmetic

The 300-second changed-extension budget combines the same 119 child envelopes into 40 jobs instead of 47 on the September 22 counting inventory. Estimated work remains 10,140 seconds. At 45–60 seconds of fixed setup per job, the extension slice changes from 204.25–216 to 199–209 machine-minutes: a 5.25–7 minute saving. At the historical 8-class list rate of $0.016/minute, that is $0.084–0.112 per broad PR. Public hosted execution has no metered Linux runner charge; this saving is capacity there, not a cash saving.

The [capacity-pricing correction](https://github.com/openclaw/openclaw/pull/155277) owns compact estimates. Replaying its committed `47b18faa725` inventory with only the extension budget changed gives the following conditional counts. That dependency was still under review when sampled; this table is not qualification of its candidate or proof of the final combined branch.

| Profile    | Broad PR Node rows, 240s → 300s | Unchanged core Node rows | Largest predicted core / extension job |
| ---------- | ------------------------------: | -----------------------: | -------------------------------------: |
| Blacksmith |                       132 → 125 |                       85 |                             595 / 300s |
| Hybrid     |                       130 → 123 |                       83 |                             518 / 300s |
| GitHub     |                       112 → 105 |                       65 |                             330 / 300s |

Each profile also has two dist descriptors outside the Node matrix. Main does not append these extension envelopes. Compact/PR/push/plugin caps stay 90/130/70/50. Worker counts, assertions, test deadlines, runtime-build ownership, and native-worker file ceilings remain unchanged. The workflow no longer promotes extension bundle numbers 16 and 25 to the 16-class: those positions now contain different work and follow their planner-owned 8-class route. Native proof must measure this capacity change too.

Predictions can be wrong. The old 982-second extension job included database-worker, Codex, and Matrix children taking 351/354/125 seconds; the candidate places their corresponding envelopes in separate bundles. Only the Matrix selector is identical. Its 27-second estimate substantially understates the observed 125 seconds. Applying that observation conservatively to all four Matrix children in their candidate bundle gives about 725 seconds including 60 seconds of setup, with uncertainty in the other children still requiring native proof.

## Whole-run acceptance

[Baseline run 35679872894](https://github.com/openclaw/openclaw/actions/runs/35679872894) took 21m18s: 5m20s before preflight creation and 15m58s from preflight creation through the gate. Blacksmith class median assignment was 8/8/3 seconds for 32/16/8-class. Workflow admission and runner assignment are different waits; include both in whole-run latency.

The baseline allocated 29/2/10 active Blacksmith 32/16/8-class jobs and 25 hosted Ubuntu jobs. Skipped placeholders consumed no runners. That is 258.15 Blacksmith machine-minutes; historical label rates imply $13.84, while the campaign's supplied estimate was $18–20. These are pricing assumptions, not an invoice. Moving artifact builds back adds one Blacksmith job and approximately 4.67 Blacksmith minutes using the older build median; extension compaction applies to PRs only.

Completion requires measured main-shaped and broad-fallback PR-shaped runs for each changed profile at or below 900 seconds, with every Blacksmith class median assignment below 60 seconds. Record actual job and step walls, total workflow wall, class counts, and cost against the same baseline. Planner estimates, reduced rows, and a successful test result alone do not establish this performance gate. The routing and packing changes remain unqualified until those exact-head observations exist.
