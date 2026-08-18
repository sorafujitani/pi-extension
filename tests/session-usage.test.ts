import { describe, expect, it } from "vite-plus/test";
import {
  collectSessionUsage,
  formatSessionUsageCompact,
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
});
