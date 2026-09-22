import { render } from "lit";
import { expect } from "vitest";
import type { CronJob } from "../../api/types.ts";
import { createInitialCronState } from "../../lib/cron/index.ts";
import { DEFAULT_CRON_FORM } from "../../test-helpers/cron.ts";
import type { CronProps } from "./view-types.ts";
import { renderCron } from "./view.ts";

export function createCronViewJob(id: string, overrides: Partial<CronJob> = {}): CronJob {
  return {
    id,
    name: "Daily ping",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "cron", expr: "0 9 * * *" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "ping" },
    ...overrides,
  } as CronJob;
}

type CronTestOverrides = Record<string, unknown>;

function createCronViewProps<T extends CronTestOverrides>(overrides: T): CronProps & T;
function createCronViewProps(): CronProps;
function createCronViewProps(overrides: CronTestOverrides = {}): CronProps {
  const legacy = {
    basePath: "",
    agentId: "main",
    loading: false,
    hasLoaded: true,
    listError: null,
    canManage: true,
    jobsLoadingMore: false,
    status: {
      enabled: true,
      triggersEnabled: true,
      jobs: 0,
    },
    jobs: [],
    jobsTotal: 0,
    jobsHasMore: false,
    jobsQuery: "",
    jobsEnabledFilter: "all",
    jobsScheduleKindFilter: "all",
    jobsLastStatusFilter: "all",
    jobsTriggerFilter: "all",
    jobsSortBy: "nextRunAtMs",
    jobsSortDir: "asc",
    error: null,
    busy: false,
    form: { ...DEFAULT_CRON_FORM },
    heartbeatScratch: "",
    fieldErrors: {},
    canSubmit: true,
    editingJob: null,
    createOpen: false,
    listTab: "tasks",
    detailTab: "settings",
    channels: [],
    channelLabels: {},
    channelMeta: [] as NonNullable<CronProps["channels"]["channelsSnapshot"]>["channelMeta"],
    runs: [],
    runsState: "ready",
    runsTotal: 0,
    runsHasMore: false,
    runsLoadingMore: false,
    runsStatuses: [],
    runsDeliveryStatuses: [],
    runsQuery: "",
    runsSortDir: "desc",
    agentSuggestions: [],
    modelSuggestions: [],
    thinkingSuggestions: [],
    timezoneSuggestions: [],
    deliveryToSuggestions: [],
    accountSuggestions: [],
    onListTabChange: () => undefined,
    onDetailTabChange: () => undefined,
    onFormChange: () => undefined,
    onRefresh: () => undefined,
    onSubmit: () => undefined,
    onSubmitRunNow: () => undefined,
    onSelectJob: () => undefined,
    onOpenCreate: () => undefined,
    onClosePanel: () => undefined,
    onClone: () => undefined,
    onToggle: () => undefined,
    onRun: () => undefined,
    onRemove: () => undefined,
    onLoadMoreJobs: () => undefined,
    onJobsFiltersChange: () => undefined,
    onJobsFiltersReset: () => undefined,
    onLoadMoreRuns: () => undefined,
    onRunsFiltersChange: () => undefined,
    ...overrides,
  };
  const state = createInitialCronState();
  Object.assign(state, {
    cronLoading: legacy.loading,
    cronJobsError: legacy.listError,
    cronJobsLoadingMore: legacy.jobsLoadingMore,
    cronStatus: legacy.status,
    cronJobs: legacy.jobs,
    cronJobsTotal: legacy.jobsTotal,
    cronJobsHasMore: legacy.jobsHasMore,
    cronJobsSnapshotRevision: legacy.hasLoaded ? "test" : null,
    cronJobsQuery: legacy.jobsQuery,
    cronJobsEnabledFilter: legacy.jobsEnabledFilter,
    cronJobsScheduleKindFilter: legacy.jobsScheduleKindFilter,
    cronJobsLastStatusFilter: legacy.jobsLastStatusFilter,
    cronJobsTriggerFilter: legacy.jobsTriggerFilter,
    cronJobsSortBy: legacy.jobsSortBy,
    cronJobsSortDir: legacy.jobsSortDir,
    cronError: legacy.error,
    cronBusy: legacy.busy,
    cronForm: legacy.form,
    cronFieldErrors: legacy.fieldErrors,
    cronEditingJob: legacy.editingJob,
    cronCreateOpen: legacy.createOpen,
    cronRuns: legacy.runs,
    cronRunsTotal: legacy.runsTotal,
    cronRunsHasMore: legacy.runsHasMore,
    cronRunsLoadingMore: legacy.runsLoadingMore,
    cronRunsStatuses: legacy.runsStatuses,
    cronRunsDeliveryStatuses: legacy.runsDeliveryStatuses,
    cronRunsQuery: legacy.runsQuery,
    cronRunsSortDir: legacy.runsSortDir,
    ...(overrides.state as Partial<CronProps["state"]> | undefined),
  });
  const channels = {
    channelsSnapshot: {
      channelOrder: legacy.channels,
      channelLabels: legacy.channelLabels,
      channelMeta: legacy.channelMeta ?? [],
    },
  } as unknown as CronProps["channels"];
  const suggestions: CronProps["suggestions"] = {
    agentSuggestions: legacy.agentSuggestions,
    modelSuggestions: legacy.modelSuggestions,
    timezoneSuggestions: legacy.timezoneSuggestions,
    deliveryToSuggestions: legacy.deliveryToSuggestions,
    accountTargets: legacy.accountSuggestions,
  };
  return { ...legacy, state, channels, suggestions } as CronProps;
}

export function renderCronView(overrides: CronTestOverrides): HTMLDivElement;
export function renderCronView(): HTMLDivElement;
export function renderCronView(overrides: CronTestOverrides = {}) {
  const container = document.createElement("div");
  render(renderCron(createCronViewProps(overrides)), container);
  return container;
}

export function getButtonByText(container: Element, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (btn) => btn.textContent?.replace(/\s+/g, " ").trim() === text,
  );
  expect(button).toBeInstanceOf(HTMLButtonElement);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected button with text "${text}"`);
  }
  return button;
}

export function getElement<T extends Element>(
  container: Element,
  selector: string,
  constructor: new () => T,
): T {
  const element = container.querySelector<T>(selector);
  expect(element).toBeInstanceOf(constructor);
  if (!(element instanceof constructor)) {
    throw new Error(`Expected ${selector} to match ${constructor.name}`);
  }
  return element;
}

export function selectSegmented(control: HTMLElement) {
  const group = control.closest<HTMLElement & { value: string }>("wa-radio-group");
  expect(group).not.toBeNull();
  if (!group) {
    return;
  }
  group.value = control.getAttribute("value") ?? "";
  group.dispatchEvent(new Event("change", { bubbles: true }));
}

export function findToggleByLabel(container: Element, label: string) {
  return (
    Array.from(container.querySelectorAll("wa-switch.settings-toggle")).find((toggle) =>
      toggle.textContent?.includes(label),
    ) ?? null
  );
}
