// Embedded runner utility tests cover small mapping helpers shared by run setup
// and provider option normalization.
import { describe, expect, it } from "vitest";
import { mapThinkingLevel, mapThinkingLevelForProvider } from "./utils.js";

describe("mapThinkingLevel", () => {
  it("maps adaptive to the provider-owned high effort default", () => {
    expect(mapThinkingLevel("adaptive")).toBe("high");
  });

  it("maps logical Ultra to provider max effort", () => {
    const level = mapThinkingLevelForProvider("ultra", {
      provider: "custom",
      id: "max-model",
      reasoning: true,
      thinkingLevelMap: { max: "max" },
    });
    expect(level).toBe("max");
    expect(mapThinkingLevel(level)).toBe("max");
  });

  it("preserves provider-native adaptive outside agent-core", () => {
    expect(
      mapThinkingLevelForProvider("adaptive", { provider: "custom", id: "adaptive-model" }),
    ).toBe("adaptive");
  });
});
