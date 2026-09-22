// Anysearch provider module implements model/runtime integration.
import { createWebSearchProviderContractFields } from "openclaw/plugin-sdk/provider-web-search-contract";

const ANYSEARCH_CREDENTIAL_PATH = "plugins.entries.anysearch.config.webSearch.apiKey";
const ANYSEARCH_ONBOARDING_SCOPES: Array<"text-inference"> = ["text-inference"];

export function createAnysearchWebSearchProviderBase() {
  return {
    id: "anysearch",
    label: "AnySearch",
    hint: "Hosted web search with anonymous access and vertical domain routing",
    onboardingScopes: [...ANYSEARCH_ONBOARDING_SCOPES],
    // AnySearch answers anonymous requests; a key only raises the rate limit.
    // Declaring the provider keyless keeps setup and status from demanding a
    // credential it can run without, while credentialPath, envVars, and
    // configuredCredential still resolve a key when one is configured.
    requiresCredential: false,
    credentialLabel: "AnySearch API key",
    envVars: ["ANYSEARCH_API_KEY"],
    placeholder: "as_sk_...",
    signupUrl: "https://anysearch.com/console/api-keys",
    docsUrl: "https://docs.openclaw.ai/tools/anysearch-search",
    autoDetectOrder: 110,
    credentialPath: ANYSEARCH_CREDENTIAL_PATH,
    ...createWebSearchProviderContractFields({
      credentialPath: ANYSEARCH_CREDENTIAL_PATH,
      searchCredential: { type: "scoped", scopeId: "anysearch" },
      configuredCredential: { pluginId: "anysearch" },
      selectionPluginId: "anysearch",
    }),
  };
}
