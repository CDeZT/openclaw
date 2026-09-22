import type { SessionEntryCommitContext } from "../../config/sessions/session-accessor.types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { ensureSessionGroupRegistered } from "../session-groups.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { sessionLog } from "./sessions-shared.js";

export async function registerCreatedSessionCategory(
  category: string | undefined,
  context: Parameters<typeof emitSessionsChanged>[0],
  source: SessionEntryCommitContext,
): Promise<void> {
  if (!category) {
    return;
  }
  try {
    if (await ensureSessionGroupRegistered(category, source)) {
      // Catalog bookkeeping follows the authoritative session commit and has
      // its own invalidation. Its failure must not make a durable create ambiguous.
      emitSessionsChanged(context, { reason: "groups" }, { catalogOnly: true });
    }
  } catch (error) {
    sessionLog.warn(`failed to register created session category: ${formatErrorMessage(error)}`);
    // Registration may have committed before cleanup or the source check failed.
    // Reload the catalog conservatively; this is not an insertion receipt or retry.
    emitSessionsChanged(context, { reason: "groups" }, { catalogOnly: true });
  }
}
