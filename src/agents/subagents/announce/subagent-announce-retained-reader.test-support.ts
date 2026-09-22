import type {
  SubagentAnnounceDeliveryDeps,
  SubagentRequesterSessionReader,
} from "./subagent-announce-delivery.runtime.js";

type RequesterRead = SubagentAnnounceDeliveryDeps["loadRequesterSessionEntry"];
type ConfiguredRead = SubagentAnnounceDeliveryDeps["loadSessionEntry"];
type WithRequester = SubagentAnnounceDeliveryDeps["withRequesterSessionReader"];
type WithConfigured = SubagentAnnounceDeliveryDeps["withConfiguredSessionEntryReader"];
type ConfiguredReader = Parameters<Parameters<WithConfigured>[2]>[0];

/** Explicit opt-in for fixtures that already own complete requester metadata. */
export function createRequesterSessionReaderForTest(read: RequesterRead): WithRequester {
  return async function withRequester<T>(
    sessionKey: string,
    agentId: string | undefined,
    operation: (reader: SubagentRequesterSessionReader) => T | Promise<T>,
  ): Promise<T> {
    let open = true;
    const assertCurrent = () => {
      if (!open) {
        throw new Error("Requester fixture reader used after callback cleanup");
      }
    };
    try {
      return await operation({
        kind: "durable",
        assertCurrent,
        read: async () => {
          assertCurrent();
          // Read on every use: rotating transcript fixtures keep their live row objects.
          const requester = read(sessionKey, agentId);
          assertCurrent();
          // Preserve the original bare fixture object inside the read envelope.
          return { requester, assertCurrent };
        },
      });
    } finally {
      open = false;
    }
  };
}

/** Explicit opt-in for synthetic entry maps; keep the real requester route resolver. */
export function createConfiguredSessionEntryReaderForTest(read: ConfiguredRead): WithConfigured {
  return async function withConfigured<T>(
    _cfg: Parameters<WithConfigured>[0],
    scope: Parameters<WithConfigured>[1],
    operation: (reader: ConfiguredReader) => T | Promise<T>,
  ): Promise<T> {
    let open = true;
    const assertCurrent = () => {
      if (!open) {
        throw new Error("Configured fixture reader used after callback cleanup");
      }
    };
    const { agentId, sessionKey, storePath } = scope;
    try {
      return await operation({
        kind: "durable",
        agentId,
        sessionKey,
        storePath,
        // This is a fixture locator, not a claim of native physical ownership.
        readSource: { agentId, path: storePath },
        assertCurrent,
        readEntry: async () => {
          assertCurrent();
          const entry = read({ agentId, sessionKey, storePath, clone: false });
          assertCurrent();
          return { entry, assertCurrent };
        },
      });
    } finally {
      open = false;
    }
  };
}
