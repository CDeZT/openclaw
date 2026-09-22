import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
// Anysearch provider module implements model/runtime integration.
import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-contract";
import { createAnysearchWebSearchProviderBase } from "./anysearch-web-search-provider.shared.js";

const ANYSEARCH_MAX_SEARCH_COUNT = 10;
const ANYSEARCH_ZONES = ["cn", "intl"] as const;

const loadAnysearchWebSearchRuntime = createLazyRuntimeModule(
  () => import("./anysearch-web-search-provider.runtime.js"),
);

const AnysearchSearchSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query string." },
    count: {
      type: "integer",
      description: "Number of results to return (1-10).",
      minimum: 1,
      maximum: ANYSEARCH_MAX_SEARCH_COUNT,
    },
    tag: {
      type: "string",
      description:
        "Optional vertical tag from the AnySearch sub-domain directory, such as code.doc. Tags must come from the directory; unknown tags are rejected.",
    },
    zone: {
      type: "string",
      enum: [...ANYSEARCH_ZONES],
      description: 'Optional zone: "cn" or "intl".',
    },
    language: {
      type: "string",
      description: 'Optional result language hint, such as "en" or "zh".',
    },
    params: {
      type: "object",
      description:
        'Optional parameters for the selected tag, such as {"library":"react"} for code.doc.',
    },
  },
  additionalProperties: false,
} satisfies Record<string, unknown>;

export function createAnysearchWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...createAnysearchWebSearchProviderBase(),
    createTool: (ctx) => ({
      description:
        "Search the web using AnySearch. Returns titles, URLs, and extracted page content, with optional vertical domain routing.",
      parameters: AnysearchSearchSchema,
      execute: async (args, context) => {
        context?.signal?.throwIfAborted();
        const { executeAnysearchWebSearchProviderTool } = await loadAnysearchWebSearchRuntime();
        return await executeAnysearchWebSearchProviderTool(ctx, args, context?.signal);
      },
    }),
  };
}
