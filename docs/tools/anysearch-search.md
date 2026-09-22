---
summary: "AnySearch web search -- hosted AI search with anonymous access and vertical domains"
read_when:
  - You want a hosted web search provider
  - You want to use AnySearch for web_search
  - You want anonymous access without an API key
  - You need vertical domain search (code, finance, academic, and more)
title: "AnySearch search"
---

OpenClaw supports [AnySearch](https://anysearch.com) as a hosted `web_search`
provider. AnySearch is an official remote search API with general web search,
parallel batch search, vertical domain search across 17 domains, and full-page
content extraction.

Advantages:

- **Anonymous access** -- works without an API key at lower rate limits
- **Vertical domains** -- structured search across code, finance, academic, and more
- **Markdown content** -- results carry extracted page text, not just snippets

## Setup

<Steps>
  <Step title="Install the plugin">
    ```bash
    openclaw plugins install @openclaw/anysearch-plugin
    ```

    Installation applies to a running Gateway automatically; otherwise it takes effect
    on the next startup. See [Apply changes and inspect](/plugins/manage-plugins#apply-changes-and-inspect).

  </Step>
  <Step title="Configure">
    ```bash
    openclaw configure --section web
    # Select "anysearch" as the provider
    ```

    Or set the env var and let auto-detection find it:

    ```bash
    export ANYSEARCH_API_KEY="as_sk_..."
    ```

    Leave the key blank for anonymous access at lower rate limits.

  </Step>
</Steps>

## Config

```json5
{
  tools: {
    web: {
      search: {
        provider: "anysearch",
      },
    },
  },
}
```

Plugin-level settings for AnySearch:

```json5
{
  plugins: {
    entries: {
      anysearch: {
        config: {
          webSearch: {
            apiKey: "as_sk_...", // optional, omit for anonymous access
            tag: "code.doc", // optional vertical domain tag
            zone: "cn", // optional: cn or intl
            language: "zh", // optional language hint
          },
        },
      },
    },
  },
}
```

`apiKey` also accepts a SecretRef object.

## Environment variable

Set `ANYSEARCH_API_KEY` as an alternative to config:

```bash
export ANYSEARCH_API_KEY="as_sk_..."
```

Resolution order: configured `apiKey` (a string or an allowed env SecretRef),
then `ANYSEARCH_API_KEY` only when `apiKey` is missing. An explicit SecretRef
that read-only config inspection blocks does not fall through to the ambient
environment; fix its provider, default-provider, or env allowlist policy
instead. With no key anywhere, AnySearch answers anonymously: no
`Authorization` header is sent at all.

## Plugin config reference

| Field      | Description                                                        |
| ---------- | ------------------------------------------------------------------ |
| `apiKey`   | AnySearch API key (optional; omit for anonymous access)            |
| `tag`      | Vertical domain tag such as `code.doc` (optional)                  |
| `zone`     | Zone such as `cn` or `intl` (optional)                             |
| `language` | Language hint for results (optional)                               |
| `params`   | Tag parameters such as `library` for the `code.doc` tag (optional) |

The shared `web_search` tool owns a fixed argument schema (`query`, `count`,
and the other providers' filters). It does not adopt a provider's own `parameters`
schema, so `tag`, `zone`, `language`, and `params` are **not** exposed to the
model as per-call arguments. Configure them as plugin config; they apply to every
search this provider runs.

## Notes

- **Anonymous access** -- without a key, no `Authorization` header is sent;
  an empty or invalid key is a 401, never a silent fallback
- **Tags must come from the directory** -- invented tags are rejected by the
  API; some tags require parameters (for example `library` for `code.doc`)
- **Markdown content** -- results carry extracted page text via the search
  `format: "markdown"` response, with snippet fallback
- **Result caching** -- identical queries (same query, count, tag, zone,
  language, and key presence) are cached in-process for a short TTL
- **Version requirement** -- the plugin declares `minHostVersion: >=2026.6.9`

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [Tavily Search](/tools/tavily) -- another remote search API with key auth
- [SearXNG Search](/tools/searxng-search) -- self-hosted, key-free meta-search
