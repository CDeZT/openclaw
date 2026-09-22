// Xiaomi tests cover xiaomi plugin behavior.
import { streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { createSolidPngBuffer } from "openclaw/plugin-sdk/test-fixtures";
import { extractNonEmptyAssistantText, isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

const XIAOMI_API_KEY = process.env.XIAOMI_API_KEY?.trim() ?? "";
const XIAOMI_TOKEN_PLAN_API_KEY = process.env.XIAOMI_TOKEN_PLAN_API_KEY?.trim() ?? "";
const XIAOMI_TOKEN_PLAN_BASE_URL = process.env.XIAOMI_TOKEN_PLAN_BASE_URL?.trim() ?? "";
const LIVE = isLiveTestEnabled() && XIAOMI_API_KEY.length > 0;
const describeLive = LIVE ? describe : describe.skip;

const registerXiaomiPlugin = () =>
  registerProviderPlugin({
    plugin,
    id: "xiaomi",
    name: "Xiaomi Provider",
  });

describe.each([
  {
    provider: "xiaomi",
    apiKey: XIAOMI_API_KEY,
    baseUrl: undefined,
    models: ["mimo-v2.6-pro", "mimo-v2.6-flash"],
  },
  {
    provider: "xiaomi-token-plan",
    apiKey: XIAOMI_TOKEN_PLAN_API_KEY,
    baseUrl: XIAOMI_TOKEN_PLAN_BASE_URL,
    models: ["mimo-v2.6-pro", "mimo-v2.6-flash"],
  },
])("$provider plugin live", ({ provider, apiKey, baseUrl, models }) => {
  // UltraSpeed is a separately provisioned service, even when /models lists its ID.
  const selectedModels =
    provider === "xiaomi" && process.env.OPENCLAW_LIVE_XIAOMI_ULTRASPEED === "1"
      ? [...models, "mimo-v2.6-pro-ultraspeed"]
      : models;
  const itLive =
    isLiveTestEnabled() && apiKey && (provider !== "xiaomi-token-plan" || baseUrl) ? it : it.skip;
  itLive.each(selectedModels)(
    "MiMo V2.6 %s preserves tool reasoning across turns and recognizes image input",
    async (modelId) => {
      const { providers } = await registerXiaomiPlugin();
      const registered = requireRegisteredProvider(providers, provider);
      const discovered = await registered.catalog?.run({
        config: baseUrl ? { models: { providers: { [provider]: { baseUrl, models: [] } } } } : {},
        env: {},
        resolveProviderApiKey: () => ({ apiKey }),
        resolveProviderAuth: () => ({
          apiKey,
          mode: "api_key",
          source: "env",
        }),
      });
      if (!discovered || !("provider" in discovered)) {
        throw new Error(`Xiaomi live discovery did not return the ${provider} catalog`);
      }
      const catalog = discovered.provider;
      const definition = catalog.models.find((entry) => entry.id === modelId);
      if (!definition) {
        throw new Error(`Xiaomi live discovery did not return ${modelId}`);
      }
      expect(definition.input).toContain("image");
      const model: Model<"openai-completions"> = {
        ...definition,
        input: definition.input.filter((kind) => kind === "text" || kind === "image"),
        provider,
        baseUrl: catalog.baseUrl,
        api: "openai-completions",
      };
      const stream = registered.wrapStreamFn?.({
        provider,
        modelId,
        model,
        thinkingLevel: "high",
        streamFn: streamSimple,
      });
      if (!stream) {
        throw new Error("Xiaomi provider did not wrap the model stream");
      }
      const complete = async (context: Context) => {
        let payload: unknown;
        const result = await (
          await stream(model, context, {
            apiKey,
            reasoning: "high",
            maxTokens: 4096,
            signal: AbortSignal.timeout(60_000),
            onPayload: (value) => {
              payload = value;
            },
          })
        ).result();
        if (result.stopReason === "error" || result.stopReason === "aborted") {
          throw new Error(result.errorMessage || `Xiaomi stopped: ${result.stopReason}`);
        }
        expect(payload).toMatchObject({ thinking: { type: "enabled" } });
        return { result, payload };
      };

      const context: Context = {
        messages: [
          {
            role: "user",
            content:
              "Call lookup_word exactly once, then reply with only its returned word. " +
              "The word is unknown until the tool returns; do not guess it.",
            timestamp: Date.now(),
          },
        ],
        tools: [
          {
            name: "lookup_word",
            description: "Retrieve the word for this test fixture.",
            parameters: Type.Object({}, { additionalProperties: false }),
          },
        ],
      };
      const first = await complete(context);
      const calls = first.result.content.filter((block) => block.type === "toolCall");
      expect(calls).toHaveLength(1);
      const call = calls[0];
      if (!call) {
        throw new Error(`${modelId} did not call lookup_word`);
      }
      expect(call.name).toBe("lookup_word");
      expect(call.arguments).toEqual({});
      const reasoning = first.result.content
        .filter((block) => block.type === "thinking")
        .map((block) => block.thinking)
        .join("\n");
      expect(reasoning.length).toBeGreaterThan(0);
      context.messages.push(first.result, {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: "marigold" }],
        isError: false,
        timestamp: Date.now(),
      });
      const second = await complete(context);
      expect(extractNonEmptyAssistantText(second.result.content)).toMatch(/\bmarigold\b/i);
      context.messages.push(second.result, {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Use the word already returned by lookup_word; do not call it again. " +
              "Reply with that word followed by the dominant color in this image.",
          },
          {
            type: "image",
            mimeType: "image/png",
            data: createSolidPngBuffer(128, 128, { r: 255, g: 0, b: 0 }).toString("base64"),
          },
        ],
        timestamp: Date.now(),
      });
      const third = await complete(context);
      const text = extractNonEmptyAssistantText(third.result.content);
      expect(text).toMatch(/\bmarigold\b/i);
      expect(text).toMatch(/\bred\b/i);
      for (const { payload } of [second, third]) {
        expect(payload).toMatchObject({
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: "assistant",
              reasoning_content: reasoning,
              tool_calls: expect.arrayContaining([expect.objectContaining({ id: call.id })]),
            }),
          ]),
        });
      }
    },
    210_000,
  );
});

describeLive("xiaomi plugin live", () => {
  it("synthesizes MiMo TTS through the registered speech provider", async () => {
    const { speechProviders } = await registerXiaomiPlugin();
    const provider = requireRegisteredProvider(speechProviders, "xiaomi");

    const audioFile = await provider.synthesize({
      text: "OpenClaw Xiaomi MiMo text to speech integration test OK.",
      cfg: { plugins: { enabled: true } } as never,
      providerConfig: { apiKey: XIAOMI_API_KEY, format: "mp3", voice: "mimo_default" },
      target: "audio-file",
      timeoutMs: 90_000,
    });

    expect(audioFile.outputFormat).toBe("mp3");
    expect(audioFile.fileExtension).toBe(".mp3");
    expect(audioFile.audioBuffer.byteLength).toBeGreaterThan(512);
  }, 120_000);

  it("synthesizes MiMo TTS as an Opus voice note", async () => {
    const { speechProviders } = await registerXiaomiPlugin();
    const provider = requireRegisteredProvider(speechProviders, "xiaomi");

    const voiceNote = await provider.synthesize({
      text: "OpenClaw Xiaomi MiMo voice note test OK.",
      cfg: { plugins: { enabled: true } } as never,
      providerConfig: { apiKey: XIAOMI_API_KEY, format: "mp3", voice: "mimo_default" },
      target: "voice-note",
      timeoutMs: 90_000,
    });

    expect(voiceNote.outputFormat).toBe("opus");
    expect(voiceNote.fileExtension).toBe(".opus");
    expect(voiceNote.voiceCompatible).toBe(true);
    expect(voiceNote.audioBuffer.byteLength).toBeGreaterThan(512);
  }, 120_000);
});
