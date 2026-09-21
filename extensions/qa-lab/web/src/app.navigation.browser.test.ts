/* @vitest-environment jsdom */
import type { QaBusStateSnapshot } from "openclaw/plugin-sdk/qa-channel-protocol";
import { describe, expect, it, vi } from "vitest";
import { httpMock, mountRunner, setupAppBrowserTests } from "./app.browser.test-support.js";

setupAppBrowserTests();

describe("QA Lab tab navigation retention", () => {
  async function mountNavigation() {
    const snapshot: QaBusStateSnapshot = {
      conversations: [{ accountId: "default", id: "alice", kind: "direct" }],
      cursor: 0,
      events: [],
      messages: [],
      threads: [],
    };
    const root = await mountRunner(
      {
        alternateModel: "mock-openai/gpt-5.6-luna-alt",
        channel: null,
        channelDriver: "qa-channel",
        evidenceMode: "full",
        fastMode: false,
        primaryModel: "mock-openai/gpt-5.6-luna",
        profile: "all",
        providerMode: "mock-openai",
        runtimePair: null,
        runtimePairLane: null,
        scenarioIds: ["dm-chat-baseline"],
      },
      snapshot,
    );
    return { root, snapshot };
  }

  async function pollWithMessage(snapshot: QaBusStateSnapshot) {
    const message: QaBusStateSnapshot["messages"][number] = {
      accountId: "default",
      conversation: { id: "alice", kind: "direct" },
      direction: "inbound",
      id: `message-${snapshot.messages.length + 1}`,
      reactions: [],
      senderId: "alice",
      text: "new polling message",
      timestamp: 1,
    };
    snapshot.messages.push(message);
    snapshot.events.push({
      accountId: message.accountId,
      cursor: ++snapshot.cursor,
      kind: "inbound-message",
      message,
    });
    await vi.advanceTimersByTimeAsync(1_000);
  }

  it.each(["chat", "results", "evidence", "report", "events", "capture"])(
    "retains the focused %s tab and offset when polling replaces the navigation",
    async (tab) => {
      const { root, snapshot } = await mountNavigation();
      const nav = root.querySelector<HTMLElement>("nav.tab-bar")!;
      const button = nav.querySelector<HTMLButtonElement>(`[data-tab="${tab}"]`)!;
      button.focus();
      nav.scrollLeft = 137.25;
      const focusReveals: number[] = [];
      root.addEventListener(
        "focus",
        (event) => {
          if (event.target instanceof HTMLButtonElement && event.target.dataset.tab === tab) {
            const focusedNav = event.target.parentElement!;
            focusedNav.scrollLeft = 243.75;
            focusReveals.push(focusedNav.scrollLeft);
          }
        },
        true,
      );
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      try {
        await pollWithMessage(snapshot);

        const nextNav = root.querySelector<HTMLElement>("nav.tab-bar")!;
        const nextButton = nextNav.querySelector<HTMLButtonElement>(`[data-tab="${tab}"]`)!;
        expect(nextNav).not.toBe(nav);
        expect(button.isConnected).toBe(false);
        expect(document.activeElement).toBe(nextButton);
        expect(nextNav.scrollLeft).toBe(137.25);
        expect(focusReveals).toEqual([243.75]);
        expect(focus).toHaveBeenCalledTimes(1);
        expect(focus).toHaveBeenCalledWith({ preventScroll: true });
        expect(nextNav.querySelector<HTMLElement>(".active")?.dataset.tab).toBe("chat");
        expect(root.querySelector("#chat-messages")?.textContent).toContain("new polling message");
        expect(httpMock.getJson.mock.calls.filter(([url]) => url === "/api/state")).toHaveLength(2);

        nextButton.blur();
        nextButton.focus();
        expect(document.activeElement).toBe(nextButton);
        expect(nextNav.scrollLeft).toBe(243.75);
        expect(focusReveals).toEqual([243.75, 243.75]);
      } finally {
        focus.mockRestore();
      }
    },
  );

  it("keeps the same navigation nodes and focus when polling is unchanged", async () => {
    const { root } = await mountNavigation();
    const nav = root.querySelector<HTMLElement>("nav.tab-bar")!;
    const button = nav.querySelector<HTMLButtonElement>('[data-tab="capture"]')!;
    button.focus();
    nav.scrollLeft = 91.5;

    await vi.advanceTimersByTimeAsync(1_000);

    expect(root.querySelector("nav.tab-bar")).toBe(nav);
    expect(document.activeElement).toBe(button);
    expect(nav.scrollLeft).toBe(91.5);
    expect(httpMock.getJson.mock.calls.filter(([url]) => url === "/api/state")).toHaveLength(2);
  });

  it("retains a focused tab through activation and the next changed poll", async () => {
    const { root, snapshot } = await mountNavigation();
    const nav = root.querySelector<HTMLElement>("nav.tab-bar")!;
    const button = nav.querySelector<HTMLButtonElement>('[data-tab="events"]')!;
    button.focus();
    nav.scrollLeft = 83.5;
    button.click();

    const activated = root.querySelector<HTMLButtonElement>('nav.tab-bar [data-tab="events"]')!;
    expect(button.isConnected).toBe(false);
    expect(document.activeElement).toBe(activated);
    expect(activated.classList.contains("active")).toBe(true);
    expect(activated.parentElement!.scrollLeft).toBe(83.5);

    await pollWithMessage(snapshot);

    const refreshed = root.querySelector<HTMLButtonElement>('nav.tab-bar [data-tab="events"]')!;
    expect(activated.isConnected).toBe(false);
    expect(document.activeElement).toBe(refreshed);
    expect(refreshed.classList.contains("active")).toBe(true);
    expect(refreshed.parentElement!.scrollLeft).toBe(83.5);
    expect(root.querySelector(".events-scroll")?.textContent).toContain("new polling message");
  });

  it("retains horizontal navigation scroll without moving focus into it", async () => {
    const { root, snapshot } = await mountNavigation();
    const nav = root.querySelector<HTMLElement>("nav.tab-bar")!;
    nav.scrollLeft = 64.5;
    expect(document.activeElement).toBe(document.body);

    await pollWithMessage(snapshot);

    const nextNav = root.querySelector<HTMLElement>("nav.tab-bar")!;
    expect(nextNav).not.toBe(nav);
    expect(nextNav.scrollLeft).toBe(64.5);
    expect(document.activeElement).toBe(document.body);
  });

  it.each(["#conversation-id", "#composer-text"])(
    "preserves %s focus and draft while retaining navigation scroll",
    async (selector) => {
      const { root, snapshot } = await mountNavigation();
      const nav = root.querySelector<HTMLElement>("nav.tab-bar")!;
      const input = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
      input.value = "unfinished draft";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
      nav.scrollLeft = 48.5;

      await pollWithMessage(snapshot);

      const nextInput = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
      expect(input.isConnected).toBe(false);
      expect(document.activeElement).toBe(nextInput);
      expect(nextInput.value).toBe("unfinished draft");
      expect(root.querySelector<HTMLElement>("nav.tab-bar")!.scrollLeft).toBe(48.5);
    },
  );

  it("does not steal outside focus for a matching tab identity or control id", async () => {
    const { root, snapshot } = await mountNavigation();
    root.querySelector<HTMLButtonElement>('nav.tab-bar [data-tab="report"]')!.focus();
    const outsideNav = document.createElement("nav");
    outsideNav.className = "tab-bar";
    const outside = document.createElement("button");
    outside.dataset.tab = "report";
    outside.id = "composer-text";
    outsideNav.append(outside);
    document.body.append(outsideNav);
    outside.focus();
    const nav = root.querySelector("nav.tab-bar");

    await pollWithMessage(snapshot);

    expect(root.querySelector("nav.tab-bar")).not.toBe(nav);
    expect(document.activeElement).toBe(outside);
  });

  it("defers changed polling while a select is focused and renders after it blurs", async () => {
    const { root, snapshot } = await mountNavigation();
    const select = root.querySelector<HTMLSelectElement>("#conversation-kind")!;
    const nav = root.querySelector("nav.tab-bar");
    select.focus();

    await pollWithMessage(snapshot);

    expect(root.querySelector("nav.tab-bar")).toBe(nav);
    expect(document.activeElement).toBe(select);
    expect(root.querySelector("#chat-messages")?.textContent).not.toContain("new polling message");
    select.blur();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(root.querySelector("nav.tab-bar")).not.toBe(nav);
    expect(select.isConnected).toBe(false);
    expect(root.querySelector("#chat-messages")?.textContent).toContain("new polling message");
    expect(document.activeElement).toBe(document.body);
  });
});
