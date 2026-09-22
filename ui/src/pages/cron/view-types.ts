import type {
  CronJob,
  CronRunLogEntry,
  CronDeliveryStatus,
  CronJobsEnabledFilter,
  CronJobsScheduleKindFilter,
  CronJobsTriggerFilter,
  CronRunsStatusValue,
  CronJobsSortBy,
  CronSortDir,
} from "../../api/types.ts";
import type { ChannelsState } from "../../lib/channels/index.ts";
import type { CronRunsViewState } from "../../lib/cron/runs.ts";
import type { CronFormState, CronJobsLastStatusFilter, CronState } from "../../lib/cron/types.ts";
import type { buildCronSuggestions } from "./form-suggestions.ts";

export type CronListTab = "tasks" | "activity";
export type CronDetailTab = "settings" | "history";
export type CronProps = {
  state: CronState;
  /** Canonical gateway capability for every mutation-capable cron control. */
  canManage: boolean;
  error: string | null;
  heartbeatScratch: string;
  listTab: CronListTab;
  detailTab: CronDetailTab;
  channels: ChannelsState;
  runsState: CronRunsViewState;
  highlightedRunId?: string | null;
  suggestions: ReturnType<typeof buildCronSuggestions>;
  onListTabChange: (tab: CronListTab) => void;
  onDetailTabChange: (tab: CronDetailTab) => void;
  onFormChange: (patch: Partial<CronFormState>) => void;
  onRefresh: () => void;
  onSubmit: () => void;
  onSubmitRunNow: () => void;
  onSelectJob: (job: CronJob) => void;
  onOpenCreate: (patch?: Partial<CronFormState>) => void;
  onClosePanel: () => void;
  onClone: (job: CronJob) => void;
  onToggle: (job: CronJob, enabled: boolean) => void;
  onRun: (job: CronJob, mode?: "force" | "due") => void;
  onRemove: (job: CronJob) => void;
  onLoadMoreJobs: () => void;
  onJobsFiltersChange: (patch: {
    cronJobsQuery?: string;
    cronJobsEnabledFilter?: CronJobsEnabledFilter;
    cronJobsScheduleKindFilter?: CronJobsScheduleKindFilter;
    cronJobsLastStatusFilter?: CronJobsLastStatusFilter;
    cronJobsTriggerFilter?: CronJobsTriggerFilter;
    cronJobsSortBy?: CronJobsSortBy;
    cronJobsSortDir?: CronSortDir;
  }) => void | Promise<void>;
  onJobsFiltersReset: () => void | Promise<void>;
  onLoadMoreRuns: () => void;
  onRunsFiltersChange: (patch: {
    cronRunsStatuses?: CronRunsStatusValue[];
    cronRunsDeliveryStatuses?: CronDeliveryStatus[];
    cronRunsQuery?: string;
    cronRunsSortDir?: CronSortDir;
  }) => void | Promise<void>;
  onViewRunTranscript?: (entry: CronRunLogEntry) => void;
};
