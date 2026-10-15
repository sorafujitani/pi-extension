import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  formatUsageStats,
  runSingleAgent,
  waitForProcessExit,
} from "../extensions/subagent/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

function spawnNode(script: string) {
  return spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("subagent process lifecycle", () => {
  it("includes the reasoning effort in usage metadata", () => {
    expect(
      formatUsageStats(
        {
          input: 1_234,
          output: 345,
          cacheRead: 4_567,
          cacheWrite: 78,
          cost: 0.1234,
          contextTokens: 5_678,
          turns: 2,
        },
        "openai-codex/gpt-5.6-luna",
        "max",
      ),
    ).toBe("2 turns ↑1.2k ↓345 R4.6k W78 $0.1234 ctx:5.7k openai-codex/gpt-5.6-luna effort:max");
  });

  it("does not treat a non-zero process exit as success", async () => {
    const status = await waitForProcessExit(spawnNode("process.exit(7)"));

    expect(status.exitCode).toBe(7);
    expect(status.signalCode).toBeNull();
    expect(status.aborted).toBe(false);
  });

  it("escalates an aborted process only when SIGTERM does not end it", async () => {
    if (process.platform === "win32") return;

    const child = spawnNode("setTimeout(() => {}, 10_000)");
    const controller = new AbortController();
    const statusPromise = waitForProcessExit(child, controller.signal, 50);
    controller.abort();
    const status = await statusPromise;

    expect(status.aborted).toBe(true);
    expect(status.signalCode).toBe("SIGTERM");
  });

  it("uses SIGKILL after the grace period for a SIGTERM-ignoring process", async () => {
    if (process.platform === "win32") return;

    const child = spawnNode(
      "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setTimeout(() => {}, 10_000)",
    );
    await new Promise<void>((resolve) => child.stdout.once("data", resolve));
    const controller = new AbortController();
    const statusPromise = waitForProcessExit(child, controller.signal, 50);
    controller.abort();
    const status = await statusPromise;

    expect(status.aborted).toBe(true);
    expect(status.signalCode).toBe("SIGKILL");
  });

  it("cleans the abort timer and listener when SIGTERM ends the process", async () => {
    if (process.platform === "win32") return;

    const child = spawnNode(
      "process.on('SIGTERM', () => process.exit(0)); process.stdout.write('ready\\n'); setTimeout(() => {}, 10_000)",
    );
    await new Promise<void>((resolve) => child.stdout.once("data", resolve));
    const controller = new AbortController();
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");
    const clearTimeout = vi.spyOn(globalThis, "clearTimeout");

    try {
      const statusPromise = waitForProcessExit(child, controller.signal, 50);
      controller.abort();
      const status = await statusPromise;

      expect(status.aborted).toBe(true);
      expect(status.exitCode).toBe(0);
      expect(status.signalCode).toBeNull();
      expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(clearTimeout).toHaveBeenCalled();
    } finally {
      removeEventListener.mockRestore();
      clearTimeout.mockRestore();
    }
  });

  it("preserves UTF-8 characters split across stdout and stderr chunks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-subagent-process-test-"));
    temporaryDirectories.push(directory);
    const messageText = "chunk境界😀を保持";
    const message = {
      role: "assistant",
      content: [{ type: "text", text: messageText }],
      api: "openai-responses",
      provider: "openai",
      model: "test-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    };
    const payload = `${JSON.stringify({ type: "message_end", message })}\n`;
    const stderrText = "stderr境界🚨";
    const scriptPath = join(directory, "fake-pi.mjs");
    await writeFile(
      scriptPath,
      `const stdoutBytes = Buffer.from(${JSON.stringify(payload)}, "utf8");
const stdoutSplit = stdoutBytes.indexOf(Buffer.from("😀", "utf8")) + 1;
const stderrBytes = Buffer.from(${JSON.stringify(stderrText)}, "utf8");
const stderrSplit = stderrBytes.indexOf(Buffer.from("🚨", "utf8")) + 1;
process.stdout.write(stdoutBytes.subarray(0, stdoutSplit));
process.stderr.write(stderrBytes.subarray(0, stderrSplit));
setTimeout(() => {
  process.stdout.write(stdoutBytes.subarray(stdoutSplit));
  process.stderr.write(stderrBytes.subarray(stderrSplit));
}, 25);
`,
      "utf8",
    );

    const originalArgv = [...process.argv];
    try {
      process.argv[1] = scriptPath;
      const result = await runSingleAgent(
        process.cwd(),
        {},
        [
          {
            name: "chunk-agent",
            description: "test agent",
            systemPrompt: "",
            source: "user",
            filePath: scriptPath,
          },
        ],
        "chunk-agent",
        "emit UTF-8",
        undefined,
        undefined,
        undefined,
        undefined,
        (results) => ({
          mode: "single",
          agentScope: "user",
          projectAgentsDir: null,
          results,
        }),
      );

      expect(result.exitCode).toBe(0);
      expect((result.messages[0].content[0] as { text: string }).text).toBe(messageText);
      expect(result.stderr).toBe(stderrText);
      expect(result.stderr).not.toContain("\\uFFFD");
    } finally {
      process.argv.splice(0, process.argv.length, ...originalArgv);
    }
  });

  it("persists a session id instead of using --no-session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-subagent-session-test-"));
    temporaryDirectories.push(directory);
    const scriptPath = join(directory, "fake-pi.mjs");
    await writeFile(
      scriptPath,
      `const sessionIndex = process.argv.indexOf("--session-id");
if (process.argv.includes("--no-session")) process.exit(3);
if (sessionIndex < 0 || !process.argv[sessionIndex + 1]) process.exit(2);
const sessionId = process.argv[sessionIndex + 1];
const message = {
  role: "assistant",
  content: [{ type: "text", text: sessionId }],
  api: "openai-responses",
  provider: "openai",
  model: "test-model",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop",
  timestamp: 0,
};
process.stdout.write(JSON.stringify({ type: "session", id: sessionId }) + "\\n");
process.stdout.write(JSON.stringify({ type: "message_end", message }) + "\\n");
`,
      "utf8",
    );
    const originalArgv = [...process.argv];
    try {
      process.argv[1] = scriptPath;
      const result = await runSingleAgent(
        process.cwd(),
        {},
        [
          {
            name: "session-agent",
            description: "test agent",
            systemPrompt: "",
            source: "user",
            filePath: scriptPath,
          },
        ],
        "session-agent",
        "keep a session",
        undefined,
        undefined,
        undefined,
        undefined,
        (results) => ({
          mode: "single",
          agentScope: "user",
          projectAgentsDir: null,
          results,
        }),
        { timeoutMs: 2_000 },
      );
      expect(result.exitCode).toBe(0);
      expect(result.sessionId).toBeTruthy();
      expect((result.messages[0].content[0] as { text: string }).text).toBe(result.sessionId);
    } finally {
      process.argv.splice(0, process.argv.length, ...originalArgv);
    }
  });

  it("times out a hung child and returns the session id", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(join(tmpdir(), "pi-subagent-timeout-test-"));
    temporaryDirectories.push(directory);
    const scriptPath = join(directory, "fake-pi.mjs");
    await writeFile(scriptPath, "setTimeout(() => {}, 10_000);\n", "utf8");
    const originalArgv = [...process.argv];
    try {
      process.argv[1] = scriptPath;
      const result = await runSingleAgent(
        process.cwd(),
        {},
        [
          {
            name: "hang-agent",
            description: "test agent",
            systemPrompt: "",
            source: "user",
            filePath: scriptPath,
          },
        ],
        "hang-agent",
        "hang",
        undefined,
        undefined,
        undefined,
        undefined,
        (results) => ({
          mode: "single",
          agentScope: "user",
          projectAgentsDir: null,
          results,
        }),
        { timeoutMs: 80, sessionId: "timeout-session" },
      );
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBe(1);
      expect(result.sessionId).toBe("timeout-session");
      expect(result.errorMessage).toContain("timed out");
      expect(result.errorMessage).toContain("timeout-session");
    } finally {
      process.argv.splice(0, process.argv.length, ...originalArgv);
    }
  });

  it("surfaces tool_execution_start before the child exits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-subagent-live-tool-test-"));
    temporaryDirectories.push(directory);
    const scriptPath = join(directory, "fake-pi.mjs");
    await writeFile(
      scriptPath,
      `process.stdout.write(JSON.stringify({
  type: "tool_execution_start",
  toolCallId: "t1",
  toolName: "bash",
  args: { command: "sleep 1" },
}) + "\\n");
process.stdout.write(JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 0,
  },
}) + "\\n");
`,
      "utf8",
    );
    const originalArgv = [...process.argv];
    const updates: Array<{ name?: string }> = [];
    try {
      process.argv[1] = scriptPath;
      const result = await runSingleAgent(
        process.cwd(),
        {},
        [
          {
            name: "live-agent",
            description: "test agent",
            systemPrompt: "",
            source: "user",
            filePath: scriptPath,
          },
        ],
        "live-agent",
        "show tools",
        undefined,
        undefined,
        undefined,
        (partial) => {
          updates.push({ name: partial.details?.results[0]?.liveTools?.at(-1)?.name });
        },
        (results) => ({
          mode: "single",
          agentScope: "user",
          projectAgentsDir: null,
          results,
        }),
        { timeoutMs: 2_000 },
      );
      expect(result.exitCode).toBe(0);
      expect(result.liveTools?.some((tool) => tool.name === "bash")).toBe(true);
      expect(updates.some((update) => update.name === "bash")).toBe(true);
    } finally {
      process.argv.splice(0, process.argv.length, ...originalArgv);
    }
  });
});
