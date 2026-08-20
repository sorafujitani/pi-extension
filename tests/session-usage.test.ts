import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";
import sessionUsage, {
  collectRecentUsage,
  collectSessionUsage,
  formatSessionUsageCompact,
  formatUsageWindowCompact,
  getCacheHitRate,
  hasSessionUsage,
} from "../extensions/session-usage.js";

describe("session usage", () => {
  it("collects usage from messages, tool results, and compaction", () => {
    const entries = [
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall" }],
          usage: {
            input: 100,
            output: 20,
            cacheRead: 5,
            cacheWrite: 2,
            cost: { total: 0.25 },
          },
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          usage: { output: 3, cost: { total: 0.05 } },
        },
      },
      {
        type: "compaction",
        usage: { input: 10 },
      },
    ] as unknown as Parameters<typeof collectSessionUsage>[0];

    expect(collectSessionUsage(entries)).toEqual({
      turns: 1,
      userMessages: 1,
      toolCalls: 1,
      input: 110,
      output: 23,
      cacheRead: 5,
      cacheWrite: 2,
      total: 140,
      cost: 0.3,
    });
  });

  it("formats compact usage for persistent UI", () => {
    expect(
      formatSessionUsageCompact({
        turns: 1,
        userMessages: 1,
        toolCalls: 0,
        input: 1_000,
        output: 200,
        cacheRead: 300,
        cacheWrite: 0,
        total: 1_500,
        cost: 0.5,
      }),
    ).toBe("session 1.5k tok · 1 turn ↑1.0k ↓200 R300 $0.500");
  });

  it("separates full prompt volume from uncached input in the rate window", () => {
    const now = Date.parse("2026-08-20T00:00:00.000Z");
    const entries = [
      {
        type: "message",
        message: {
          role: "assistant",
          timestamp: now - 30_000,
          provider: "openai-codex",
          model: "gpt-5.6-sol",
          content: [],
          usage: {
            input: 100,
            output: 20,
            cacheRead: 900,
            cacheWrite: 10,
            cost: { total: 0.01 },
          },
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          timestamp: now - 120_000,
          provider: "openai-codex",
          model: "gpt-5.6-sol",
          content: [],
          usage: {
            input: 10_000,
            output: 30,
            cacheRead: 0,
            cacheWrite: 0,
            cost: { total: 0.02 },
          },
        },
      },
    ] as unknown as Parameters<typeof collectSessionUsage>[0];

    const recent = collectRecentUsage(entries, now);

    expect(recent).toMatchObject({
      requests: 1,
      promptTokens: 1_010,
      uncachedInput: 110,
      cacheRead: 900,
      cacheWrite: 10,
      output: 20,
      total: 1_030,
      maxPromptTokens: 1_010,
      maxOutput: 20,
    });
    expect(getCacheHitRate(recent)).toBeCloseTo(89.1089, 3);
    expect(formatUsageWindowCompact(recent)).toBe("1m 1r in1.0k/u110 out20");
  });

  it("recognizes empty sessions", () => {
    expect(
      hasSessionUsage({
        turns: 0,
        userMessages: 0,
        toolCalls: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: 0,
      }),
    ).toBe(false);
  });

  it("toggles the detailed usage widget with /usage", async () => {
    const handlers = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
    const widgetCalls: Array<{ key: string; content: unknown }> = [];
    const pi = {
      on() {},
      registerCommand(
        name: string,
        options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> },
      ) {
        if (name === "usage") handlers.set(name, options.handler);
      },
    } as unknown as ExtensionAPI;

    sessionUsage(pi);

    const context = {
      mode: "tui",
      ui: {
        setWidget(key: string, content: unknown) {
          widgetCalls.push({ key, content });
        },
        notify() {},
      },
      sessionManager: { getEntries: () => [], getBranch: () => [] },
      getContextUsage: () => undefined,
      model: undefined,
    } as unknown as ExtensionContext;
    const handler = handlers.get("usage");
    if (!handler) throw new Error("missing /usage handler");

    await handler("", context);
    await handler("", context);

    expect(widgetCalls).toHaveLength(2);
    expect(widgetCalls[0]?.key).toBe("pi-extension-usage-metrics");
    expect(typeof widgetCalls[0]?.content).toBe("function");
    expect(widgetCalls[1]?.content).toBeUndefined();
  });
});
