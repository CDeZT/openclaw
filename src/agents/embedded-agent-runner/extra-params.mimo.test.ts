import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AssistantMessage } from "../../llm/types.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import type { StreamFn } from "../runtime/index.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import { applyExtraParamsToAgent } from "./extra-params.js";
import { runExtraParamsCase, testing as extraParamsTesting } from "./extra-params.test-support.js";

beforeEach(() => {
  extraParamsTesting.setProviderRuntimeDepsForTest({
    wrapProviderStreamFn: (params) => params.context.streamFn,
  });
});

afterEach(() => {
  extraParamsTesting.resetProviderRuntimeDepsForTest();
});

describe("extra-params: MiMo OpenAI-compatible proxy fallback", () => {
  it.each([
    "xiaomi/mimo-v2.6-pro",
    "xiaomi/mimo-v2.6-flash:cloud",
    "xiaomi/mimo-v2.6-pro-ultraspeed",
  ])("fills %s reasoning_content for unowned OpenAI-compatible proxy models", (modelId) => {
    const payload: Record<string, unknown> = {
      messages: [
        { role: "user", content: "look up the answer" },
        {
          role: "assistant",
          content: null,
          reasoning_content: "I should use the lookup tool.",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "42" },
        { role: "user", content: "continue" },
        { role: "assistant", content: "I used a tool" },
        { role: "tool", content: "ok" },
      ],
    };
    runExtraParamsCase({
      thinkingLevel: "high",
      model: makeProviderModelFixture<"openai-completions">({
        api: "openai-completions",
        provider: "opencode",
        id: modelId,
        baseUrl: "https://proxy.example.com/v1",
      }),
      payload,
    });

    const messages = payload.messages as Array<Record<string, unknown>>;
    expect(payload.thinking).toEqual({ type: "enabled" });
    expect(payload.reasoning_effort).toBe("high");
    expect(messages[1]).toHaveProperty("reasoning_content", "I should use the lookup tool.");
    expect(messages[4]).toHaveProperty("reasoning_content", "");
  });

  it("promotes reasoning-only MiMo V2 proxy finals to visible text", async () => {
    const resultMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "proxy final answer" }],
      api: "openai-completions",
      provider: "opencode",
      model: "xiaomi/mimo-v2-pro",
      usage: createZeroUsageFixture(),
      stopReason: "stop",
      timestamp: 1,
    };
    const baseStreamFn: StreamFn = () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "done", reason: "stop", message: resultMessage });
      });
      return stream;
    };
    const agent = { streamFn: baseStreamFn };
    applyExtraParamsToAgent(agent, undefined, "opencode", "xiaomi/mimo-v2-pro", undefined, "high");

    const model = makeProviderModelFixture<"openai-completions">({
      api: "openai-completions",
      provider: "opencode",
      id: "xiaomi/mimo-v2-pro",
      baseUrl: "https://proxy.example.com/v1",
    });
    const stream = await agent.streamFn(model, { messages: [] }, {});
    const events: unknown[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: "done",
        reason: "stop",
        message: {
          ...resultMessage,
          content: [{ type: "text", text: "proxy final answer" }],
        },
      },
    ]);
    await expect(stream.result()).resolves.toMatchObject({
      content: [{ type: "text", text: "proxy final answer" }],
    });
  });
});
