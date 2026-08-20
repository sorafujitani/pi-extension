import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerSubagent, {
  formatParallelAggregateOutput,
  MODEL_VISIBLE_OUTPUT_BUDGET,
  prepareModelVisibleOutput,
  prepareParallelAggregateOutput,
  truncateModelVisibleOutput,
} from "../extensions/subagent/index.js";

type ParallelResult = Parameters<typeof formatParallelAggregateOutput>[0][number];

const temporaryDirectories: string[] = [];
const longOutput = `HEAD-${"x".repeat(MODEL_VISIBLE_OUTPUT_BUDGET * 2)}-TAIL`;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

function makeResult(agent: string, output: string): ParallelResult {
  return {
    agent,
    agentSource: "user",
    task: `Task for ${agent}`,
    exitCode: 0,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: output }],
        api: "openai-responses",
        provider: "openai",
        model: "test-model",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        timestamp: 0,
      },
    ],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
  };
}

function rememberArtifact(output: string): string {
  const match = output.match(
    /Full output preserved in temporary artifact: (.+?)\. Read it with the read tool\.\]/,
  );
  if (!match) throw new Error("artifact path was not included in output");
  const artifactPath = match[1];
  temporaryDirectories.push(dirname(artifactPath));
  return artifactPath;
}

describe("subagent model-visible output budget", () => {
  it("writes the complete overflow output and exposes a readable artifact path", async () => {
    const visibleOutput = await prepareModelVisibleOutput(
      longOutput,
      "call/with unsafe id",
      "single-success",
    );
    const artifactPath = rememberArtifact(visibleOutput);

    expect(isAbsolute(artifactPath)).toBe(true);
    expect(artifactPath.startsWith(tmpdir())).toBe(true);
    expect(artifactPath).toMatch(/output-call_with_unsafe_id-single-success-[^/]+\.txt$/);
    expect(await readFile(artifactPath, "utf8")).toBe(longOutput);
    expect(visibleOutput).toContain(artifactPath);
    expect(Buffer.byteLength(visibleOutput, "utf8")).toBeLessThanOrEqual(
      MODEL_VISIBLE_OUTPUT_BUDGET,
    );

    if (process.platform !== "win32") {
      expect((await stat(artifactPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("writes and exposes a complete parallel aggregate", async () => {
    const results = Array.from({ length: 3 }, (_, index) =>
      makeResult(`agent-${index}`, longOutput),
    );
    const aggregate = formatParallelAggregateOutput(results);
    const visibleOutput = await prepareModelVisibleOutput(
      aggregate,
      "parallel-call",
      "parallel-aggregate",
    );
    const artifactPath = rememberArtifact(visibleOutput);

    expect(await readFile(artifactPath, "utf8")).toBe(aggregate);
    expect(visibleOutput).toContain("Parallel: 3/3 succeeded");
    expect(visibleOutput).toContain("### [agent-0] completed");
    expect(visibleOutput).toContain(artifactPath);
    expect(visibleOutput).toContain("-TAIL");
    expect(Buffer.byteLength(visibleOutput, "utf8")).toBeLessThanOrEqual(
      MODEL_VISIBLE_OUTPUT_BUDGET,
    );
  });

  it("cleans overflow artifacts when the extension factory session shuts down", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagent-cleanup-"));
    temporaryDirectories.push(root);
    const agentsDirectory = join(root, ".pi", "agents");
    await mkdir(agentsDirectory, { recursive: true });
    await writeFile(
      join(agentsDirectory, "cleanup-agent.md"),
      "---\nname: cleanup-agent\ndescription: cleanup test\n---\n",
      "utf8",
    );

    const agentOutput = `artifact-${"x".repeat(MODEL_VISIBLE_OUTPUT_BUDGET * 2)}`;
    const message = {
      role: "assistant",
      content: [{ type: "text", text: agentOutput }],
      api: "openai-responses",
      provider: "openai",
      model: "test-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    };
    const payload = `${JSON.stringify({ type: "message_end", message })}\n`;
    const scriptPath = join(root, "fake-pi.mjs");
    await writeFile(scriptPath, `process.stdout.write(${JSON.stringify(payload)});\n`, "utf8");

    type TestToolResult = { content: Array<{ type: string; text: string }> };
    type EventHandler = (event: unknown, ctx: unknown) => void | Promise<void>;
    let execute: ((...args: unknown[]) => Promise<TestToolResult>) | undefined;
    let shutdown: EventHandler | undefined;
    const pi = {
      on(event: string, handler: EventHandler) {
        if (event === "session_shutdown") shutdown = handler;
      },
      registerTool(tool: { execute: (...args: unknown[]) => Promise<TestToolResult> }) {
        execute = tool.execute;
      },
    } as unknown as ExtensionAPI;
    registerSubagent(pi);

    const originalArgv = [...process.argv];
    try {
      process.argv[1] = scriptPath;
      if (!execute || !shutdown) throw new Error("subagent extension was not registered");

      const result = await execute(
        "cleanup-call",
        {
          agent: "cleanup-agent",
          task: "produce overflow output",
          agentScope: "project",
          confirmProjectAgents: false,
        },
        undefined,
        undefined,
        { cwd: root, hasUI: false, model: undefined, thinkingLevel: undefined },
      );
      const visibleOutput = result.content[0]?.text;
      if (!visibleOutput) throw new Error("subagent output was not returned");
      const artifactPath = rememberArtifact(visibleOutput);

      expect(await readFile(artifactPath, "utf8")).toBe(agentOutput);
      await shutdown({ type: "session_shutdown", reason: "quit" }, {});
      await expect(access(artifactPath)).rejects.toThrow();
    } finally {
      process.argv.splice(0, process.argv.length, ...originalArgv);
    }
  });

  it("keeps every heading in the parallel overflow preview", async () => {
    const results = Array.from({ length: 8 }, (_, index) =>
      makeResult(`agent-${index}`, longOutput),
    );
    const aggregate = formatParallelAggregateOutput(results);
    const visibleOutput = await prepareParallelAggregateOutput(results, "parallel-preview");
    const artifactPath = rememberArtifact(visibleOutput);

    expect(await readFile(artifactPath, "utf8")).toBe(aggregate);
    for (let index = 0; index < results.length; index++) {
      expect(visibleOutput).toContain(`### [agent-${index}] completed`);
    }
    expect(Buffer.byteLength(visibleOutput, "utf8")).toBeLessThanOrEqual(
      MODEL_VISIBLE_OUTPUT_BUDGET,
    );
  });

  it("keeps both ends of long UTF-8 output without corruption", async () => {
    const prefix = "先頭: 日本語 😀 ";
    const suffix = " 末尾: 絵文字 🚀";
    const output = `${prefix}${"長い日本語🌟".repeat(MODEL_VISIBLE_OUTPUT_BUDGET)}${suffix}`;
    const visibleOutput = await prepareModelVisibleOutput(output, "utf8-call", "utf8");
    const artifactPath = rememberArtifact(visibleOutput);

    expect(await readFile(artifactPath, "utf8")).toBe(output);
    expect(Buffer.byteLength(visibleOutput, "utf8")).toBeLessThanOrEqual(
      MODEL_VISIBLE_OUTPUT_BUDGET,
    );
    expect(visibleOutput.startsWith(prefix)).toBe(true);
    expect(visibleOutput.endsWith(suffix)).toBe(true);
    expect(visibleOutput).not.toContain("\uFFFD");
    expect(Buffer.from(visibleOutput, "utf8").toString("utf8")).toBe(visibleOutput);
  });

  it("does not create an artifact for short output", async () => {
    const output = "A concise conclusion.";

    expect(await prepareModelVisibleOutput(output, "short-call", "single-success")).toBe(output);
    expect(truncateModelVisibleOutput(output)).toBe(output);
  });

  it("keeps complete results for tool details", async () => {
    const results = [makeResult("agent", longOutput)];
    const before = structuredClone(results);
    const aggregate = formatParallelAggregateOutput(results);

    const visibleOutput = await prepareModelVisibleOutput(
      aggregate,
      "details-call",
      "parallel-aggregate",
    );
    rememberArtifact(visibleOutput);

    expect(results).toEqual(before);
  });
});
