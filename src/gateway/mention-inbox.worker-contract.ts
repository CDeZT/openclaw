import type { MentionStoreMessage, MentionStoreSnapshot } from "./mention-inbox-store.js";

export type MentionInboxMutation = {
  now: number;
  /** Prepared alias facts; the host grants commit only while their profile version is live. */
  canonicalProfiles: [string, string][];
  action:
    | { kind: "maintain" }
    | { kind: "dismiss"; profileId: string; ids: string[] }
    | {
        kind: "record";
        sourceKey: string;
        message: MentionStoreMessage;
        recipients: { profileId: string; id: string | null; excerptProfileId: string }[];
      };
};
export type MentionInboxMutationResult = {
  snapshot: MentionStoreSnapshot;
  createdIds: string[];
  capacityReached: boolean;
};
export type MentionInboxWorkerOperations = {
  "mentions.mutate": { input: MentionInboxMutation; output: MentionInboxMutationResult };
};
