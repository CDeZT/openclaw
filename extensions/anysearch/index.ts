// AnySearch plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createAnysearchWebSearchProvider } from "./src/anysearch-web-search-provider.js";

export default definePluginEntry({
  id: "anysearch",
  name: "AnySearch Plugin",
  description: "Bundled AnySearch web search plugin",
  register(api) {
    api.registerWebSearchProvider(createAnysearchWebSearchProvider());
  },
});
