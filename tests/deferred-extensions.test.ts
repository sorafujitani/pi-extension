import { pathToFileURL } from "node:url";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionToolContext,
  SessionStartEvent,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";
import {
  createDeferredExtensionsExtension,
  resolveDeferredPackageEntry,
  type DeferredPackageSpec,
  type ImportModule,
} from "../extensions/deferred-extensions.js";

const AGENT_DIR = "/tmp/deferred-extensions-agent";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type TestCommand = {
  handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
};

type Harness = {
  pi: ExtensionAPI;
  handlers: Map<string, Handler[]>;
  tools: Map<string, ToolDefinition>;
  commands: Map<string, TestCommand>;
  notifications: Array<{ message: string; type?: string }>;
  context(mode: "tui" | "print"): ExtensionToolContext;
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function createHarness(): Harness {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, TestCommand>();
  const notifications: Array<{ message: string; type?: string }> = [];

  const pi = {
    on(event: string, handler: Handler) {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
    },
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: TestCommand) {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    handlers,
    tools,
    commands,
    notifications,
    context(mode) {
      return {
        mode,
        hasUI: true,
        tools: [],
        async executeTool() {
          throw new Error("Unexpected nested tool call in deferred extension test");
        },
        ui: {
          notify(message: string, type?: "info" | "warning" | "error") {
            notifications.push({ message, type });
          },
        },
      } as unknown as ExtensionToolContext;
    },
  };
}

function getHandler(harness: Harness, event: string, index = 0): Handler {
  const handler = harness.handlers.get(event)?.[index];
  if (!handler) throw new Error(`missing ${event} handler ${index}`);
  return handler;
}

async function emitSessionStart(
  harness: Harness,
  event: SessionStartEvent,
  ctx: ExtensionContext,
): Promise<void> {
  const eventHandlers = harness.handlers.get("session_start") ?? [];
  for (const handler of eventHandlers) await handler(event, ctx);
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function testSpec(
  name = "test-package",
  entry = "entry.ts",
  commands?: readonly string[],
): DeferredPackageSpec {
  return { name, entry, commands };
}

async function install(
  harness: Harness,
  packageSpecs: readonly DeferredPackageSpec[],
  importModule: ImportModule,
  timeoutMs?: number,
): Promise<void> {
  await createDeferredExtensionsExtension(harness.pi, {
    agentDir: AGENT_DIR,
    packageSpecs,
    importModule,
    timeoutMs,
    entryExists: () => true,
  });
}

describe("deferred extensions", () => {
  it("skips packages whose entry is not installed", async () => {
    const harness = createHarness();
    const installed = testSpec("installed-package", "entry.ts", ["installed-cmd"]);
    const missing = testSpec("missing-package", "entry.ts", ["missing-cmd"]);
    const imported: string[] = [];

    await createDeferredExtensionsExtension(harness.pi, {
      agentDir: AGENT_DIR,
      packageSpecs: [installed, missing],
      importModule: async (specifier) => {
        imported.push(specifier);
        return { default: () => undefined };
      },
      entryExists: (entry) => entry === resolveDeferredPackageEntry(AGENT_DIR, installed),
    });

    const ctx = harness.context("print");
    await getHandler(harness, "session_start")(
      { type: "session_start", reason: "startup" } as SessionStartEvent,
      ctx,
    );

    expect(harness.commands.has("installed-cmd")).toBe(true);
    expect(harness.commands.has("missing-cmd")).toBe(false);

    expect(imported).toEqual([
      pathToFileURL(resolveDeferredPackageEntry(AGENT_DIR, installed)).href,
    ]);
    expect(harness.notifications).toEqual([]);
  });

  it("starts TUI loading without awaiting the package import", async () => {
    const harness = createHarness();
    const moduleReady = deferred<unknown>();
    let importCalls = 0;
    const spec = testSpec();
    await install(harness, [spec], async (specifier) => {
      importCalls += 1;
      expect(specifier).toBe(pathToFileURL(resolveDeferredPackageEntry(AGENT_DIR, spec)).href);
      return moduleReady.promise;
    });

    const event = { type: "session_start", reason: "startup" } as SessionStartEvent;
    const result = getHandler(harness, "session_start")(event, harness.context("tui"));

    expect(result).toBeUndefined();
    expect(importCalls).toBe(1);

    moduleReady.resolve({ default: () => undefined });
    await getHandler(harness, "before_agent_start")(
      { type: "before_agent_start" },
      harness.context("tui"),
    );
  });

  it("awaits package loading for non-TUI session_start", async () => {
    const harness = createHarness();
    const moduleReady = deferred<unknown>();
    const spec = testSpec();
    await install(harness, [spec], async () => moduleReady.promise);

    const sessionStart = getHandler(harness, "session_start")(
      { type: "session_start", reason: "startup" } as SessionStartEvent,
      harness.context("print"),
    ) as Promise<void>;
    let settled = false;
    void sessionStart.then(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(settled).toBe(false);

    moduleReady.resolve({ default: () => undefined });
    await sessionStart;
    expect(settled).toBe(true);
  });

  it("waits for all packages in before_agent_start", async () => {
    const harness = createHarness();
    const moduleReady = deferred<unknown>();
    const spec = testSpec();
    await install(harness, [spec], async () => moduleReady.promise);

    const tuiContext = harness.context("tui");
    getHandler(harness, "session_start")(
      { type: "session_start", reason: "startup" } as SessionStartEvent,
      tuiContext,
    );
    let settled = false;
    const beforeAgentStart = getHandler(harness, "before_agent_start")(
      { type: "before_agent_start" },
      tuiContext,
    ) as Promise<void>;
    void beforeAgentStart.then(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(settled).toBe(false);

    moduleReady.resolve({ default: () => undefined });
    await beforeAgentStart;
    expect(settled).toBe(true);
  });

  it("replays captured session_start once and registers it for future sessions", async () => {
    const harness = createHarness();
    let replayCount = 0;
    await install(harness, [testSpec()], async () => ({
      default: (pi: ExtensionAPI) => {
        pi.on("session_start", async () => {
          replayCount += 1;
        });
      },
    }));

    const currentEvent = { type: "session_start", reason: "startup" } as SessionStartEvent;
    const context = harness.context("print");
    await emitSessionStart(harness, currentEvent, context);

    expect(replayCount).toBe(1);
    expect(harness.handlers.get("session_start")).toHaveLength(2);

    const futureHandler = getHandler(harness, "session_start", 1);
    await futureHandler({ type: "session_start", reason: "new" } as SessionStartEvent, context);
    expect(replayCount).toBe(2);
  });

  it("waits for bootstrap before first tool and command use", async () => {
    const harness = createHarness();
    const sessionReplayReady = deferred<void>();
    let toolCalls = 0;
    let commandCalls = 0;
    await install(harness, [testSpec()], async () => ({
      default: (pi: ExtensionAPI) => {
        pi.registerTool({
          name: "deferred_tool",
          label: "Deferred tool",
          description: "test",
          parameters: {},
          execute: async () => {
            toolCalls += 1;
            return { content: [{ type: "text", text: "ok" }] };
          },
        } as unknown as ToolDefinition);
        pi.registerCommand("deferred-command", {
          handler: async () => {
            commandCalls += 1;
          },
        });
        pi.on("session_start", async () => sessionReplayReady.promise);
      },
    }));

    const context = harness.context("tui");
    getHandler(harness, "session_start")(
      { type: "session_start", reason: "startup" } as SessionStartEvent,
      context,
    );
    await flushMicrotasks();

    const toolPromise = harness.tools
      .get("deferred_tool")
      ?.execute("call-1", {}, undefined, undefined, context);
    const commandPromise = harness.commands
      .get("deferred-command")
      ?.handler("", context as unknown as ExtensionCommandContext);
    expect(toolPromise).toBeDefined();
    expect(commandPromise).toBeDefined();
    await flushMicrotasks();
    expect(toolCalls).toBe(0);
    expect(commandCalls).toBe(0);

    sessionReplayReady.resolve();
    await Promise.all([toolPromise, commandPromise]);
    expect(toolCalls).toBe(1);
    expect(commandCalls).toBe(1);
  });

  it("starts each package only once", async () => {
    const harness = createHarness();
    let importCalls = 0;
    await install(harness, [testSpec()], async () => {
      importCalls += 1;
      return { default: () => undefined };
    });

    const event = { type: "session_start", reason: "startup" } as SessionStartEvent;
    const context = harness.context("tui");
    getHandler(harness, "session_start")(event, context);
    getHandler(harness, "session_start")(event, context);
    await getHandler(harness, "before_agent_start")({ type: "before_agent_start" }, context);

    expect(importCalls).toBe(1);
  });

  it("isolates package failures and notifies with a warning", async () => {
    const harness = createHarness();
    const good = testSpec("good-package");
    const bad = testSpec("bad-package");
    await install(harness, [good, bad], async (specifier) => {
      if (specifier.includes("bad-package")) throw new Error("broken package");
      return { default: (pi: ExtensionAPI) => pi.on("session_start", () => undefined) };
    });

    await getHandler(harness, "session_start")(
      { type: "session_start", reason: "startup" } as SessionStartEvent,
      harness.context("print"),
    );

    expect(harness.notifications).toContainEqual({
      message: expect.stringContaining("bad-package"),
      type: "warning",
    });
    expect(harness.notifications).toContainEqual({
      message: expect.stringContaining("broken package"),
      type: "warning",
    });
  });

  it("runs a slash command that was looked up before its package finished loading", async () => {
    const harness = createHarness();
    const moduleReady = deferred<unknown>();
    let calls = 0;
    await install(
      harness,
      [testSpec("commands", "entry.ts", ["early"])],
      async () => moduleReady.promise,
    );

    const context = harness.context("tui");
    getHandler(harness, "session_start")(
      { type: "session_start", reason: "startup" } as SessionStartEvent,
      context,
    );
    const command = harness.commands.get("early");
    expect(command).toBeDefined();
    const invocation = command?.handler("arg", context as unknown as ExtensionCommandContext);
    await flushMicrotasks();
    expect(calls).toBe(0);

    moduleReady.resolve({
      default: (pi: ExtensionAPI) => {
        pi.registerCommand("early", {
          handler: async () => {
            calls += 1;
          },
        });
      },
    });
    await invocation;
    expect(calls).toBe(1);
  });

  it("releases readiness when a package times out", async () => {
    const harness = createHarness();
    await install(harness, [testSpec("slow")], async () => new Promise(() => undefined), 10);
    const context = harness.context("tui");
    getHandler(harness, "session_start")(
      { type: "session_start", reason: "startup" } as SessionStartEvent,
      context,
    );

    await getHandler(harness, "before_agent_start")({ type: "before_agent_start" }, context);
    expect(harness.notifications).toContainEqual({
      message: expect.stringContaining("timed out"),
      type: "warning",
    });
  });

  it("does not replay startup after session shutdown", async () => {
    const harness = createHarness();
    const moduleReady = deferred<unknown>();
    let replayCount = 0;
    await install(harness, [testSpec()], async () => moduleReady.promise);
    const context = harness.context("tui");
    getHandler(harness, "session_start")(
      { type: "session_start", reason: "startup" } as SessionStartEvent,
      context,
    );
    await getHandler(harness, "session_shutdown")({ type: "session_shutdown" }, context);
    moduleReady.resolve({
      default: (pi: ExtensionAPI) => {
        pi.on("session_start", () => {
          replayCount += 1;
        });
      },
    });
    await getHandler(harness, "before_agent_start")({ type: "before_agent_start" }, context);
    expect(replayCount).toBe(0);
    expect(harness.handlers.get("session_start")).toHaveLength(1);
  });
});
