import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAnysearchWebSearchProvider as createContractAnysearchWebSearchProvider } from "../web-search-contract-api.js";
import { createAnysearchWebSearchProvider } from "./anysearch-web-search-provider.js";

type JsonRecord = Record<string, unknown>;

const SAVED_ENV_API_KEY = process.env.ANYSEARCH_API_KEY;

function requireAnysearchTool(webSearch: JsonRecord = {}, searchConfig: JsonRecord = {}) {
  const tool = createAnysearchWebSearchProvider().createTool({
    config: { plugins: { entries: { anysearch: { config: { webSearch } } } } },
    searchConfig,
  } as never);
  if (!tool) {
    throw new Error("Expected AnySearch tool definition");
  }
  return tool;
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function successResponse(results: unknown[]) {
  return jsonResponse({ code: 0, message: "success", request_id: "req-test", data: { results } });
}

function requestOf(fetchMock: { mock: { calls: unknown[][] } }) {
  const call = fetchMock.mock.calls[0];
  if (!call) {
    throw new Error("Expected one AnySearch request");
  }
  const [url, init] = call as [unknown, RequestInit | undefined];
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as JsonRecord) : {};
  return { url: String(url), init, headers: new Headers(init?.headers), body };
}

beforeEach(() => {
  // Anonymous access is the default; keep an ambient key from changing a test's mode.
  delete process.env.ANYSEARCH_API_KEY;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (SAVED_ENV_API_KEY === undefined) {
    delete process.env.ANYSEARCH_API_KEY;
  } else {
    process.env.ANYSEARCH_API_KEY = SAVED_ENV_API_KEY;
  }
});

describe("anysearch web search provider", () => {
  it("declares keyless provider metadata and a model-facing schema capped at 10 results", () => {
    const provider = createAnysearchWebSearchProvider();

    expect(provider).toMatchObject({
      id: "anysearch",
      label: "AnySearch",
      requiresCredential: false,
      envVars: ["ANYSEARCH_API_KEY"],
      placeholder: "as_sk_...",
      signupUrl: "https://anysearch.com/console/api-keys",
      docsUrl: "https://docs.openclaw.ai/tools/anysearch-search",
      autoDetectOrder: 110,
      credentialPath: "plugins.entries.anysearch.config.webSearch.apiKey",
    });
    expect(provider.hint.trim()).not.toBe("");
    expect(provider.label).toMatch(/[\s\S]*/);

    const tool = provider.createTool({ config: {}, searchConfig: {} });
    expect(tool).not.toBeNull();
    const schema = tool?.parameters as {
      additionalProperties?: boolean;
      properties?: Record<string, { enum?: unknown[]; maximum?: number; minimum?: number }>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties?.count).toMatchObject({ minimum: 1, maximum: 10 });
    expect(schema.properties?.zone?.enum).toEqual(["cn", "intl"]);
  });

  it("keeps the contract artifact in parity and enables the plugin on selection", () => {
    const direct = createAnysearchWebSearchProvider();
    const contract = createContractAnysearchWebSearchProvider();

    expect(contract.id).toBe(direct.id);
    expect(contract.label).toBe(direct.label);
    expect(contract.hint).toBe(direct.hint);
    expect(contract.envVars).toEqual(direct.envVars);
    expect(contract.credentialPath).toBe(direct.credentialPath);
    expect(contract.autoDetectOrder).toBe(direct.autoDetectOrder);
    expect(contract.requiresCredential).toBe(false);

    const applied = contract.applySelectionConfig?.({} as never) as
      | { plugins?: { entries?: Record<string, { enabled?: boolean }> } }
      | undefined;
    expect(applied?.plugins?.entries?.anysearch?.enabled).toBe(true);
  });

  it("round-trips the scoped credential value", () => {
    const provider = createAnysearchWebSearchProvider();
    const target: JsonRecord = {};

    provider.setCredentialValue(target, "test-key");
    expect(provider.getCredentialValue(target)).toBe("test-key");
  });

  it("posts an anonymous markdown search without an Authorization header", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      successResponse([
        {
          title: "OpenClaw",
          url: "https://example.com/openclaw",
          snippet: "short excerpt",
          content: "full extracted body",
        },
      ]),
    );
    const tool = requireAnysearchTool({}, { cacheTtlMinutes: 0 });

    const payload = await tool.execute({ query: "anysearch anonymous probe" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const { url, init, headers, body } = requestOf(fetchMock);
    expect(url).toBe("https://api.anysearch.com/v1/search");
    expect(init?.method).toBe("POST");
    expect(headers.get("authorization")).toBeNull();
    expect(body).toEqual({
      query: "anysearch anonymous probe",
      max_results: 5,
      format: "markdown",
    });

    expect(payload).toMatchObject({ provider: "anysearch", count: 1 });
    const results = payload.results as JsonRecord[];
    expect(results[0]?.url).toBe("https://example.com/openclaw");
    expect(results[0]?.siteName).toBe("example.com");
    // `format: "markdown"` content wins over the shorter snippet fallback.
    expect(String(results[0]?.description)).toContain("full extracted body");
  });

  it("sends the configured key and vertical routing fields", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(successResponse([{ title: "T", url: "https://example.com/t" }]));
    const tool = requireAnysearchTool(
      {
        apiKey: "  test-cfg-key  ",
        tag: "code.doc",
        zone: "INTL",
        language: "zh",
        params: { library: "react" },
      },
      { cacheTtlMinutes: 0 },
    );

    await tool.execute({ query: "react useTransition" });

    const { headers, body } = requestOf(fetchMock);
    expect(headers.get("authorization")).toBe("Bearer test-cfg-key");
    expect(body).toEqual({
      query: "react useTransition",
      max_results: 5,
      format: "markdown",
      tag: "code.doc",
      zone: "intl",
      language: "zh",
      params: { library: "react" },
    });
  });

  it("falls back to ANYSEARCH_API_KEY and lets tool arguments override configured routing", async () => {
    process.env.ANYSEARCH_API_KEY = "  test-env-key  ";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(successResponse([{ title: "T", url: "https://example.com/t" }]));
    const tool = requireAnysearchTool({ tag: "code.doc", zone: "cn" }, { cacheTtlMinutes: 0 });

    await tool.execute({ query: "override probe", tag: "finance.news", zone: "intl" });

    const { headers, body } = requestOf(fetchMock);
    expect(headers.get("authorization")).toBe("Bearer test-env-key");
    expect(body).toMatchObject({ tag: "finance.news", zone: "intl" });
  });

  it("caps returned rows at the requested count", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      successResponse([
        { title: "One", url: "https://example.com/1", content: "one" },
        { title: "Two", url: "https://example.com/2", content: "two" },
        { title: "Three", url: "https://example.com/3", content: "three" },
        { title: "Four", url: "https://example.com/4", content: "four" },
      ]),
    );
    const tool = requireAnysearchTool({}, { cacheTtlMinutes: 0 });

    const payload = await tool.execute({ query: "cap probe", count: 2 });

    expect(requestOf(fetchMock).body.max_results).toBe(2);
    expect(payload.count).toBe(2);
    expect(payload.results).toHaveLength(2);
  });

  it("serves an identical query from the shared search cache", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        successResponse([{ title: "T", url: "https://example.com/cached", content: "body" }]),
      );
    const tool = requireAnysearchTool({}, { cacheTtlMinutes: 15 });
    const args = { query: "anysearch shared cache probe", count: 3 };

    const first = await tool.execute(args);
    const cached = await tool.execute(args);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(cached).toEqual({ ...first, cached: true });
  });

  it("does not read or write the cache when cacheTtlMinutes is 0", async () => {
    // A Response body is single-use, so each request needs its own instance.
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        successResponse([{ title: "T", url: "https://example.com/nocache" }]),
      );
    const tool = requireAnysearchTool({}, { cacheTtlMinutes: 0 });
    const args = { query: "anysearch no-cache probe", count: 2 };

    await tool.execute(args);
    await tool.execute(args);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns an invalid_zone payload without calling the provider", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const tool = requireAnysearchTool({}, { cacheTtlMinutes: 0 });

    await expect(tool.execute({ query: "zone probe", zone: "mars" })).resolves.toMatchObject({
      error: "invalid_zone",
      docs: "https://docs.openclaw.ai/tools/anysearch-search",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns an invalid_params payload when params is not an object", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const tool = requireAnysearchTool({}, { cacheTtlMinutes: 0 });

    await expect(
      tool.execute({ query: "params probe", params: "library=react" }),
    ).resolves.toMatchObject({ error: "invalid_params" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a fractional or out-of-range count before searching", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const tool = requireAnysearchTool({}, { cacheTtlMinutes: 0 });

    await expect(tool.execute({ query: "count probe", count: 2.5 })).rejects.toThrow(
      /count must be an integer from 1 to 10/,
    );
    await expect(tool.execute({ query: "count probe", count: 11 })).rejects.toThrow(
      /count must be an integer from 1 to 10/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a query", async () => {
    const tool = requireAnysearchTool({}, { cacheTtlMinutes: 0 });

    await expect(tool.execute({})).rejects.toThrow(/query required/);
  });

  it("does not search when the caller already canceled", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const controller = new AbortController();
    controller.abort(new Error("AnySearch caller canceled"));
    const tool = requireAnysearchTool({}, { cacheTtlMinutes: 0 });

    await expect(
      tool.execute({ query: "pre-canceled probe" }, { signal: controller.signal }),
    ).rejects.toThrow("AnySearch caller canceled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces an HTTP provider error with its status and message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ code: -1, message: "Invalid tag: not.a.real.tag." }, 400),
    );
    const tool = requireAnysearchTool({}, { cacheTtlMinutes: 0 });

    await expect(tool.execute({ query: "bad tag probe", tag: "not.a.real.tag" })).rejects.toThrow(
      /AnySearch search API error \(400\): [\s\S]*Invalid tag: not\.a\.real\.tag\./,
    );
  });

  it("redacts the active credential when the provider reflects it in an error body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ code: -1, message: "invalid key secret-sample" }, 402),
    );
    const tool = requireAnysearchTool({ apiKey: "secret-sample" }, { cacheTtlMinutes: 0 });

    const error: unknown = await tool
      .execute({ query: "redaction probe" })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("AnySearch search API error (402)");
    expect(message).not.toContain("secret-sample");
  });

  it("treats a non-zero envelope code on a 2xx response as an error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ code: -1, message: "Invalid tag: nope." }, 200),
    );
    const tool = requireAnysearchTool({}, { cacheTtlMinutes: 0 });

    await expect(tool.execute({ query: "envelope probe" })).rejects.toThrow(
      /AnySearch API error \(code -1\): Invalid tag: nope\./,
    );
  });

  it("redacts the active credential reflected in a 2xx envelope error", async () => {
    // HTTP-200 failure envelopes do not pass through throwWebSearchApiError, so
    // the request-bound redactor must still cover the raw upstream message.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ code: -1, message: "bad key secret-sample" }, 200),
    );
    const tool = requireAnysearchTool({ apiKey: "secret-sample" }, { cacheTtlMinutes: 0 });

    const error: unknown = await tool
      .execute({ query: "envelope redaction probe" })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("AnySearch API error (code -1)");
    expect(message).not.toContain("secret-sample");
  });

  it("rejects a malformed provider body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html>not json</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    const tool = requireAnysearchTool({}, { cacheTtlMinutes: 0 });

    await expect(tool.execute({ query: "malformed probe" })).rejects.toThrow(
      /AnySearch search returned malformed JSON/,
    );
  });
});
