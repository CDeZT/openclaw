import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
import type { DeliveryContext } from "../../../utils/delivery-context.types.js";
import type { SubagentProgressOrigin, SwarmQueuedLaunch } from "./subagent-registry.types.js";

export type RegisterSubagentRunParams = {
  runId: string;
  requesterTurnRunId?: string;
  childSessionKey: string;
  controllerSessionKey?: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  progressOrigin?: SubagentProgressOrigin;
  requesterDisplayKey: string;
  task: string;
  taskName?: string;
  agentId?: string;
  requesterAgentId?: string;
  cleanup: "delete" | "keep";
  label?: string;
  model?: string;
  agentDir?: string;
  workspaceDir?: string;
  runTimeoutSeconds?: number;
  expectsCompletionMessage?: boolean;
  completionTarget?: "parent";
  completionRequesterSessionId?: string;
  spawnMode?: "run" | "session";
  attachmentId?: string;
  attachmentsDir?: string;
  attachmentsRootDir?: string;
  retainAttachmentsOnKeep?: boolean;
  collect?: boolean;
  swarmRequesterSessionKey?: string;
  swarmLaunchIdempotencyKey?: string;
  swarmLaunchReplayKey?: string;
  swarmLaunchRequestFingerprint?: string;
  groupId?: string;
  outputSchema?: Record<string, unknown>;
  queuedLaunch?: SwarmQueuedLaunch;
  queued?: boolean;
  /** Required when direct dispatch suppresses Gateway tracking. Out-of-process launches keep
      Gateway's existing best-effort CLI policy; other callers create a best-effort row here. */
  taskRowOwnership?: "required" | "gateway_best_effort";
  gatewayContextResolver?: GatewayContextResolver;
};
