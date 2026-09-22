import type { Model } from "../../llm/types.js";

export function normalizeCompletionsModelId(modelId: unknown): string | undefined {
  if (typeof modelId !== "string") {
    return undefined;
  }
  const normalized = modelId.trim().toLowerCase();
  const suffixIndex = normalized.indexOf(":");
  const withoutSuffix = suffixIndex === -1 ? normalized : normalized.slice(0, suffixIndex);
  return withoutSuffix.split("/").pop();
}

const MIMO_REASONING_OPENAI_COMPATIBLE_MODEL_IDS = new Set([
  "mimo-v2-pro",
  "mimo-v2-omni",
  "mimo-v2.5",
  "mimo-v2.5-pro",
  "mimo-v2.6-flash",
  "mimo-v2.6-pro",
  "mimo-v2.6-pro-ultraspeed",
]);
const MIMO_REASONING_AS_VISIBLE_TEXT_MODEL_IDS = new Set(["mimo-v2-pro", "mimo-v2-omni"]);

export function isMiMoReasoningOpenAICompatibleModel(model: Pick<Model, "api" | "id">): boolean {
  const normalizedModelId = normalizeCompletionsModelId(model.id);
  return (
    model.api === "openai-completions" &&
    normalizedModelId !== undefined &&
    MIMO_REASONING_OPENAI_COMPATIBLE_MODEL_IDS.has(normalizedModelId)
  );
}

export function isMiMoReasoningAsVisibleTextOpenAICompatibleModel(
  model: Pick<Model, "api" | "id">,
): boolean {
  const normalizedModelId = normalizeCompletionsModelId(model.id);
  return (
    model.api === "openai-completions" &&
    normalizedModelId !== undefined &&
    MIMO_REASONING_AS_VISIBLE_TEXT_MODEL_IDS.has(normalizedModelId)
  );
}
