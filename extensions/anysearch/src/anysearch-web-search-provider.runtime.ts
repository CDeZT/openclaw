// Anysearch provider module implements model/runtime integration.
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  mergeScopedSearchConfig,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readPositiveIntegerParam,
  readProviderEnvValue,
  readResponseText,
  readStringParam,
  resolveProviderWebSearchPluginConfig,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  throwWebSearchApiError,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
  type SearchConfigRecord,
} from "openclaw/plugin-sdk/provider-web-search";
import {
  asOptionalRecord,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const ANYSEARCH_SEARCH_ENDPOINT = "https://api.anysearch.com/v1/search";
const ANYSEARCH_CREDENTIAL_PATH = "plugins.entries.anysearch.config.webSearch.apiKey";
const ANYSEARCH_DOCS_URL = "https://docs.openclaw.ai/tools/anysearch-search";
const ANYSEARCH_MAX_SEARCH_COUNT = 10;
const ANYSEARCH_ZONES = ["cn", "intl"] as const;
const ANYSEARCH_ERROR_BODY_LIMIT_BYTES = 8 * 1024;
// Hits carry extracted page text, so the success body is untrusted external
// content. Cap it the way the other bundled providers do (16 MiB) so a
// misbehaving endpoint cannot stream an unbounded body into memory.
const ANYSEARCH_SEARCH_JSON_MAX_BYTES = 16 * 1024 * 1024;
// Anonymous calls carry no Authorization header, so this is the only
// attribution signal AnySearch receives for them.
const ANYSEARCH_USER_AGENT = "OpenClaw/anysearch-plugin";
// `format: "markdown"` returns structured extracted page text in each hit's
// `content`; without it AnySearch sends a plain excerpt instead.
const ANYSEARCH_CONTENT_FORMAT = "markdown";

type AnysearchZone = (typeof ANYSEARCH_ZONES)[number];

type AnysearchConfig = {
  apiKey?: unknown;
  tag?: unknown;
  zone?: unknown;
  language?: unknown;
  params?: unknown;
};

type AnysearchSearchHit = {
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
  content?: unknown;
};

type AnysearchSearchResponse = {
  code?: unknown;
  message?: unknown;
  data?: unknown;
};

type AnysearchErrorPayload = { error: string; message: string; docs: string };

function resolveAnysearchConfig(searchConfig?: SearchConfigRecord): AnysearchConfig {
  return asOptionalRecord(searchConfig?.anysearch) ?? {};
}

function resolveAnysearchApiKey(anysearch?: AnysearchConfig): string | undefined {
  // Anonymous search is a supported mode, so a missing key is not a
  // misconfiguration; only a configured key is sent on the request.
  return (
    readConfiguredSecretString(anysearch?.apiKey, ANYSEARCH_CREDENTIAL_PATH) ??
    readProviderEnvValue(["ANYSEARCH_API_KEY"])
  );
}

function anysearchErrorPayload(error: string, message: string): AnysearchErrorPayload {
  return { error, message, docs: ANYSEARCH_DOCS_URL };
}

function isErrorPayload(value: unknown): value is AnysearchErrorPayload {
  return Boolean(
    value && typeof value === "object" && "error" in value && "message" in value && "docs" in value,
  );
}

function normalizeAnysearchZone(value: string | undefined): AnysearchZone | undefined {
  const normalized = normalizeOptionalLowercaseString(value);
  if (!normalized) {
    return undefined;
  }
  return ANYSEARCH_ZONES.find((zone) => zone === normalized);
}

function parseAnysearchTagParams(
  raw: unknown,
): { value?: Record<string, unknown> } | AnysearchErrorPayload {
  if (raw === undefined) {
    return { value: undefined };
  }
  const rawRecord = asOptionalRecord(raw);
  if (!rawRecord) {
    return anysearchErrorPayload("invalid_params", "params must be an object of tag parameters.");
  }

  const entries = Object.entries(rawRecord).filter(([, value]) => value !== undefined);
  return entries.length > 0 ? { value: Object.fromEntries(entries) } : { value: undefined };
}

function normalizeAnysearchSearchHits(payload: unknown, count: number): AnysearchSearchHit[] {
  const record = asOptionalRecord(payload);
  if (!record) {
    return [];
  }

  const response: AnysearchSearchResponse = record;
  // A rejected request answers with a non-zero envelope code. The search
  // endpoint reports those as HTTP 4xx today, so this covers a 2xx response
  // that still carries a failure code.
  if (typeof response.code === "number" && response.code !== 0) {
    const detail = normalizeOptionalString(response.message);
    throw new Error(`AnySearch API error (code ${response.code})${detail ? `: ${detail}` : ""}`);
  }

  const results = asOptionalRecord(response.data)?.results;
  if (!Array.isArray(results)) {
    return [];
  }
  return results
    .filter((entry): entry is AnysearchSearchHit =>
      Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
    )
    .slice(0, count);
}

async function readAnysearchSearchHits(
  response: Response,
  count: number,
): Promise<AnysearchSearchHit[]> {
  const body = await readResponseText(response, { maxBytes: ANYSEARCH_SEARCH_JSON_MAX_BYTES });
  if (body.truncated) {
    throw new Error(`AnySearch search response exceeds ${ANYSEARCH_SEARCH_JSON_MAX_BYTES} bytes`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch (cause) {
    throw new Error("AnySearch search returned malformed JSON", { cause });
  }
  return normalizeAnysearchSearchHits(parsed, count);
}

async function runAnysearchSearch(params: {
  query: string;
  count: number;
  tag?: string;
  zone?: AnysearchZone;
  language?: string;
  tagParams?: Record<string, unknown>;
  apiKey?: string;
  timeoutSeconds: number;
  signal?: AbortSignal;
}): Promise<AnysearchSearchHit[]> {
  const body: Record<string, unknown> = {
    query: params.query,
    max_results: params.count,
    format: ANYSEARCH_CONTENT_FORMAT,
  };
  if (params.tag) {
    body.tag = params.tag;
  }
  if (params.zone) {
    body.zone = params.zone;
  }
  if (params.language) {
    body.language = params.language;
  }
  if (params.tagParams) {
    body.params = params.tagParams;
  }

  const headers = new Headers({
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": ANYSEARCH_USER_AGENT,
  });
  // Anonymous means the Authorization header is absent entirely: an empty or
  // malformed Bearer value is rejected instead of falling back to anonymous.
  if (params.apiKey) {
    headers.set("Authorization", `Bearer ${params.apiKey}`);
  }

  return await withTrustedWebSearchEndpoint(
    {
      url: ANYSEARCH_SEARCH_ENDPOINT,
      timeoutSeconds: params.timeoutSeconds,
      signal: params.signal,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
    },
    async (response) => {
      if (!response.ok) {
        return await throwWebSearchApiError(response, "AnySearch search", {
          headers,
          maxBytes: ANYSEARCH_ERROR_BODY_LIMIT_BYTES,
          signal: params.signal,
        });
      }
      return await readAnysearchSearchHits(response, params.count);
    },
  );
}

function buildAnysearchCacheKey(params: {
  query: string;
  count: number;
  tag?: string;
  zone?: AnysearchZone;
  language?: string;
  tagParams?: Record<string, unknown>;
  keyed: boolean;
}): string {
  return buildSearchCacheKey([
    "anysearch",
    params.query,
    params.count,
    params.tag,
    params.zone,
    params.language,
    params.tagParams ? JSON.stringify(params.tagParams) : undefined,
    // Anonymous and keyed requests are served from separate rate-limit pools.
    params.keyed ? "keyed" : "anonymous",
  ]);
}

export async function executeAnysearchWebSearchProviderTool(
  ctx: { config?: Record<string, unknown>; searchConfig?: SearchConfigRecord },
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  // SAFETY: mergeScopedSearchConfig widens to a plain record by design.
  const searchConfig = mergeScopedSearchConfig(
    ctx.searchConfig,
    "anysearch",
    resolveProviderWebSearchPluginConfig(ctx.config, "anysearch"),
  ) as SearchConfigRecord | undefined; // SAFETY: the SDK helper returns the scoped record shape.
  const anysearch = resolveAnysearchConfig(searchConfig);
  const apiKey = resolveAnysearchApiKey(anysearch);

  const query = readStringParam(args, "query", { required: true });
  const count =
    readPositiveIntegerParam(args, "count", {
      max: ANYSEARCH_MAX_SEARCH_COUNT,
      message: `count must be an integer from 1 to ${ANYSEARCH_MAX_SEARCH_COUNT}.`,
    }) ??
    searchConfig?.maxResults ??
    undefined;

  const rawZone = readStringParam(args, "zone") ?? normalizeOptionalString(anysearch.zone);
  const zone = normalizeAnysearchZone(rawZone);
  if (rawZone && !zone) {
    return anysearchErrorPayload("invalid_zone", 'zone must be "cn" or "intl".');
  }

  const tag = readStringParam(args, "tag") ?? normalizeOptionalString(anysearch.tag);
  const language = readStringParam(args, "language") ?? normalizeOptionalString(anysearch.language);

  const parsedTagParams = parseAnysearchTagParams(args.params ?? anysearch.params);
  if (isErrorPayload(parsedTagParams)) {
    return parsedTagParams;
  }
  const tagParams = parsedTagParams.value;

  const resolvedCount = resolveSearchCount(count, DEFAULT_SEARCH_COUNT);
  const cacheKey = buildAnysearchCacheKey({
    query,
    count: resolvedCount,
    tag,
    zone,
    language,
    tagParams,
    keyed: Boolean(apiKey),
  });
  const cacheTtlMs = resolveSearchCacheTtlMs(searchConfig);
  const cached = readCachedSearchPayload(cacheKey, cacheTtlMs);
  if (cached) {
    return cached;
  }

  const start = Date.now();
  const hits = await runAnysearchSearch({
    query,
    count: resolvedCount,
    tag,
    zone,
    language,
    tagParams,
    apiKey,
    timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig),
    signal,
  });

  signal?.throwIfAborted();
  const payload = {
    query,
    provider: "anysearch",
    count: hits.length,
    tookMs: Date.now() - start,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "anysearch",
      wrapped: true,
    },
    results: hits.map((hit) => {
      const url = typeof hit.url === "string" ? hit.url : "";
      const title = typeof hit.title === "string" ? hit.title : "";
      const description =
        normalizeOptionalString(hit.content) ?? normalizeOptionalString(hit.snippet) ?? "";
      return {
        title: title ? wrapWebContent(title, "web_search") : "",
        url,
        description: description ? wrapWebContent(description, "web_search") : "",
        siteName: resolveSiteName(url) || undefined,
      };
    }),
  } satisfies Record<string, unknown>;

  writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
  return payload;
}
