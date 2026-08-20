import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  createLazyToolsExtension,
  LAZY_TOOLS_STATE_ENTRY,
  loadLazyToolGroups,
  matchingLazyToolGroups,
  parseLazyToolsConfig,
} from "../extensions/lazy-tools.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Command = {
  handler(args: string, ctx: ExtensionContext): Promise<void>;
};
type Tool = {
  name: string;
  description?: string;
  execute(
    toolCallId: string,
    params: unknown,
    signal: unknown,
    onUpdate: unknown,
    ctx: ExtensionContext,
  ): Promise<unknown>;
};

type Harness = {
  context: ExtensionContext;
  handlers: Map<string, Handler>;
  commands: Map<string, Command>;
  tool: Tool;
  activeTools: string[];
  setCalls: string[][];
  notifications: string[];
  entries: Array<{ type: string; data: unknown }>;
  registerTool(name: string): void;
};

async function createHarness(config?: unknown): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "lazy-tools-test-"));
  temporaryDirectories.push(root);
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  if (config !== undefined) {
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi", "lazy-tools.json"), JSON.stringify(config));
  }

  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  const notifications: string[] = [];
  const entries: Array<{ type: string; data: unknown }> = [];
  const branchEntries: Array<{
    type: "custom";
    customType: string;
    data: unknown;
  }> = [];
  let activeTools = ["bash", "web_search", "project_tool", "activate_tool_groups", "other"];
  const allTools = [
    "bash",
    "web_search",
    "source_check",
    "fetch_content",
    "get_search_content",
    "project_tool",
    "activate_tool_groups",
    "other",
  ].map((name) => ({ name }));
  const addRegisteredTool = (name: string) => {
    if (!allTools.some((tool) => tool.name === name)) allTools.push({ name });
    if (!activeTools.includes(name)) activeTools.push(name);
  };

  const context = {
    mode: "tui",
    hasUI: true,
    cwd: root,
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
    },
    isProjectTrusted: () => true,
    sessionManager: {
      getBranch: () => branchEntries,
    },
  } as unknown as ExtensionContext;

  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, command: Command) {
      commands.set(name, command);
    },
    registerTool(tool: Tool) {
      addRegisteredTool(tool.name);
      if (tool.name === "activate_tool_groups") activateTool = tool;
    },
    appendEntry(type: string, data: unknown) {
      entries.push({ type, data });
      branchEntries.push({ type: "custom", customType: type, data });
    },
    getActiveTools: () => activeTools,
    setActiveTools(tools: string[]) {
      activeTools = [...tools];
      setCalls.push([...tools]);
    },
    getAllTools: () => allTools,
  } as unknown as ExtensionAPI;
  let activateTool: Tool = {
    name: "activate_tool_groups",
    execute: async () => undefined,
  };
  const setCalls: string[][] = [];

  createLazyToolsExtension(pi, { agentDir });

  return {
    context,
    handlers,
    commands,
    get tool() {
      return activateTool;
    },
    get activeTools() {
      return activeTools;
    },
    setCalls,
    notifications,
    entries,
    registerTool(name: string) {
      addRegisteredTool(name);
    },
  };
}

function getHandler(harness: Harness, name: string): Handler {
  const handler = harness.handlers.get(name);
  if (!handler) throw new Error(`missing ${name} handler`);
  return handler;
}

describe("lazy tools config", () => {
  it("merges global and trusted project groups and matches patterns", async () => {
    const root = await mkdtemp(join(tmpdir(), "lazy-tools-config-test-"));
    temporaryDirectories.push(root);
    const agentDir = join(root, "agent");
    const projectDir = join(root, "project");
    await mkdir(agentDir, { recursive: true });
    await mkdir(join(projectDir, ".pi"), { recursive: true });
    await writeFile(
      join(agentDir, "lazy-tools.json"),
      JSON.stringify({
        groups: {
          code: { tools: ["search_code"], patterns: ["\\bcode\\b"] },
          shared: { tools: ["global_tool"], patterns: ["global"] },
        },
      }),
    );
    await writeFile(
      join(projectDir, ".pi", "lazy-tools.json"),
      JSON.stringify({
        groups: {
          docs: { tools: ["read_docs"], patterns: ["docs"] },
          shared: { tools: ["project_tool"], patterns: ["project"] },
        },
      }),
    );

    const trusted = loadLazyToolGroups(agentDir, projectDir, true);
    expect([...trusted.groups.keys()]).toEqual(["web", "code", "shared", "docs"]);
    expect(trusted.groups.get("shared")).toMatchObject({
      tools: ["global_tool", "project_tool"],
      patterns: ["global", "project"],
    });
    expect(matchingLazyToolGroups(trusted.groups, "open the docs")).toEqual(["docs"]);

    const untrusted = loadLazyToolGroups(agentDir, projectDir, false);
    expect(untrusted.groups.has("docs")).toBe(false);
    expect(untrusted.groups.has("code")).toBe(true);
  });

  it("reports malformed configuration without throwing", async () => {
    const root = await mkdtemp(join(tmpdir(), "lazy-tools-invalid-config-test-"));
    temporaryDirectories.push(root);
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "lazy-tools.json"), "{not-json");

    const result = loadLazyToolGroups(agentDir, root, false);
    expect(result.groups.has("web")).toBe(true);
    expect(result.warnings.join("\n")).toContain("lazy-tools.json");
  });

  it("rejects reserved, unsafe, and overly long patterns from configuration", () => {
    const longPattern = "a".repeat(257);
    const result = parseLazyToolsConfig({
      groups: {
        project: {
          tools: ["activate_tool_groups", "project_tool"],
          patterns: ["^(a+)+$"],
        },
        long: { tools: ["long_tool"], patterns: [longPattern] },
      },
    });

    expect(result.groups.get("project")).toEqual({
      tools: ["project_tool"],
      patterns: [],
    });
    expect(result.groups.get("long")).toEqual({
      tools: ["long_tool"],
      patterns: [],
    });
    expect(result.warnings.join("\n")).toContain("reserved tool activate_tool_groups");
    expect(result.warnings.join("\n")).toContain("unsafe pattern");
    expect(result.warnings.join("\n")).toContain("longer than 256 characters");
  });
});

describe("lazy tools extension", () => {
  it("removes only inactive registered group tools and preserves other active tools", async () => {
    const harness = await createHarness({
      groups: {
        project: { tools: ["project_tool"], patterns: ["\\bproject\\b"] },
        unknown: { tools: ["not_registered"] },
      },
    });

    await getHandler(harness, "session_start")({}, harness.context);

    expect(harness.activeTools).toEqual(["bash", "activate_tool_groups", "other"]);
    expect(harness.activeTools).not.toContain("not_registered");
    expect(harness.setCalls[0]).toEqual(harness.activeTools);
    expect(harness.tool.description).toContain("web, project, unknown");
  });

  it("reconciles tools registered after session start before the first provider request", async () => {
    const harness = await createHarness({
      groups: { dynamic: { tools: ["dynamic_tool"] } },
    });
    await getHandler(harness, "session_start")({}, harness.context);

    harness.registerTool("dynamic_tool");
    expect(harness.activeTools).toContain("dynamic_tool");

    const beforeAgentStart = getHandler(harness, "before_agent_start");
    await beforeAgentStart({}, harness.context);

    expect(harness.activeTools).not.toContain("dynamic_tool");
    const callsAfterReconcile = harness.setCalls.length;
    await beforeAgentStart({}, harness.context);
    expect(harness.setCalls.length).toBe(callsAfterReconcile);
  });

  it("keeps input auto-activation through the one-time reconciliation", async () => {
    const harness = await createHarness({
      groups: {
        dynamic: { tools: ["dynamic_tool"], patterns: ["\\bactivate\\b"] },
      },
    });
    await getHandler(harness, "session_start")({}, harness.context);
    harness.registerTool("dynamic_tool");

    await getHandler(harness, "input")({ text: "activate" }, harness.context);
    expect(harness.activeTools).toContain("dynamic_tool");

    const beforeAgentStart = getHandler(harness, "before_agent_start");
    await beforeAgentStart({}, harness.context);
    expect(harness.activeTools).toContain("dynamic_tool");
    const callsAfterReconcile = harness.setCalls.length;

    await beforeAgentStart({}, harness.context);
    expect(harness.activeTools).toContain("dynamic_tool");
    expect(harness.setCalls.length).toBe(callsAfterReconcile);
  });

  it("activates groups from input without handling the input or starting another turn", async () => {
    const harness = await createHarness({
      groups: {
        project: { tools: ["project_tool"], patterns: ["\\bproject\\b"] },
      },
    });
    await getHandler(harness, "session_start")({}, harness.context);

    const result = await getHandler(harness, "input")(
      { text: "Please open https://example.test and inspect the project" },
      harness.context,
    );

    expect(result).toEqual({ action: "continue" });
    expect(harness.activeTools).toEqual([
      "bash",
      "activate_tool_groups",
      "other",
      "web_search",
      "source_check",
      "fetch_content",
      "get_search_content",
      "project_tool",
    ]);
    expect(harness.entries.at(-1)).toEqual({
      type: LAZY_TOOLS_STATE_ENTRY,
      data: { activeGroups: ["web", "project"] },
    });
  });

  it("warns about reserved tools and keeps the loader during reset", async () => {
    const harness = await createHarness({
      groups: {
        project: { tools: ["activate_tool_groups", "project_tool"] },
      },
    });
    await getHandler(harness, "session_start")({}, harness.context);

    expect(harness.notifications.join("\n")).toContain("reserved tool activate_tool_groups");
    const command = harness.commands.get("lazy-tools");
    if (!command) throw new Error("missing lazy-tools command");
    await command.handler("reset", harness.context);
    expect(harness.activeTools).toContain("activate_tool_groups");
  });

  it("restores the latest branch snapshot and supports activate/reset commands", async () => {
    const harness = await createHarness({
      groups: { project: { tools: ["project_tool"] } },
    });
    const branch = harness.context.sessionManager.getBranch() as Array<unknown>;
    branch.push(
      {
        type: "custom",
        customType: LAZY_TOOLS_STATE_ENTRY,
        data: { activeGroups: ["web"] },
      },
      {
        type: "custom",
        customType: LAZY_TOOLS_STATE_ENTRY,
        data: { activeGroups: ["project"] },
      },
    );

    await getHandler(harness, "session_start")({}, harness.context);
    expect(harness.activeTools).toEqual(["bash", "activate_tool_groups", "other", "project_tool"]);

    const command = harness.commands.get("lazy-tools");
    if (!command) throw new Error("missing lazy-tools command");
    await command.handler("activate web", harness.context);
    expect(harness.activeTools).toContain("web_search");
    expect(harness.entries.at(-1)?.data).toEqual({ activeGroups: ["project", "web"] });

    await command.handler("reset", harness.context);
    expect(harness.activeTools).toEqual(["bash", "activate_tool_groups", "other"]);
    expect(harness.entries.at(-1)).toEqual({
      type: LAZY_TOOLS_STATE_ENTRY,
      data: { activeGroups: [] },
    });
    await command.handler("status", harness.context);
    expect(harness.notifications.at(-1)).toContain("active: (none)");
  });

  it("keeps activation additive and ignores unregistered tools", async () => {
    const harness = await createHarness({
      groups: { project: { tools: ["project_tool", "not_registered"] } },
    });
    await getHandler(harness, "session_start")({}, harness.context);
    const before = [...harness.activeTools];

    await harness.tool.execute(
      "call",
      { groups: ["project"] },
      undefined,
      undefined,
      harness.context,
    );

    expect(harness.setCalls.at(-1)).toEqual([...before, "project_tool"]);
    expect(harness.activeTools).not.toContain("not_registered");
  });
});
