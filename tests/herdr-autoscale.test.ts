import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import autoscale, {
  BEFORE_AGENT_GUIDANCE,
  DISABLED_PROMPT_GUIDELINES,
  EXPLICIT_ONLY_RULE,
  HERDR_AUTOSCALE_STATE_ENTRY,
  MAX_OUTPUT_CHARS,
  PROMPT_GUIDELINES,
  resolveHerdrWorkflow,
} from "../extensions/herdr-autoscale.js";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Command = {
  handler(args: string, ctx: ExtensionContext): Promise<void>;
};
type Tool = {
  name: string;
  description?: string;
  promptGuidelines?: string[];
  parameters?: unknown;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ExtensionContext,
  ): Promise<unknown>;
};
type ExecCall = {
  command: string;
  args: string[];
  options: { cwd?: string; signal?: AbortSignal };
};
type Harness = {
  context: ExtensionContext;
  handlers: Map<string, Handler>;
  commands: Map<string, Command>;
  tools: Tool[];
  entries: Array<{ type: string; data: unknown }>;
  branch: Array<{ type: string; customType?: string; data?: unknown }>;
  notifications: string[];
  statuses: Array<{ key: string; text: string | undefined }>;
  execCalls: ExecCall[];
  execErrors: Error[];
  appendErrors: Error[];
  responses: ExecResult[];
};

const savedEnvironment: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of ["HERDR_ENV", "PANOPTICON_CHILD", "HERDR_AUTOSCALE"]) {
    savedEnvironment[name] = process.env[name];
  }
  process.env.HERDR_ENV = "1";
  delete process.env.PANOPTICON_CHILD;
  delete process.env.HERDR_AUTOSCALE;
});

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function createHarness(
  mode: "tui" | "rpc" | "print" = "tui",
  initialBranch: Harness["branch"] = [],
): Harness {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  const tools: Tool[] = [];
  const entries: Harness["entries"] = [];
  const branch = [...initialBranch];
  const notifications: string[] = [];
  const statuses: Harness["statuses"] = [];
  const execCalls: ExecCall[] = [];
  const execErrors: Error[] = [];
  const appendErrors: Error[] = [];
  const responses: ExecResult[] = [];

  const context = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    cwd: "/repo",
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
      setStatus(key: string, text: string | undefined) {
        statuses.push({ key, text });
      },
    },
    sessionManager: {
      getBranch: () => branch,
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
      const index = tools.findIndex((registered) => registered.name === tool.name);
      if (index >= 0) tools[index] = tool;
      else tools.push(tool);
    },
    appendEntry(customType: string, data: unknown) {
      const error = appendErrors.shift();
      if (error) throw error;
      entries.push({ type: customType, data });
      branch.push({ type: "custom", customType, data });
    },
    async exec(command: string, args: string[], options: ExecCall["options"]): Promise<ExecResult> {
      execCalls.push({ command, args: [...args], options });
      const error = execErrors.shift();
      if (error) throw error;
      const response = responses.shift();
      if (!response) throw new Error("missing test exec response");
      return response;
    },
  } as unknown as ExtensionAPI;

  autoscale(pi);
  return {
    context,
    handlers,
    commands,
    tools,
    entries,
    branch,
    notifications,
    statuses,
    execCalls,
    execErrors,
    appendErrors,
    responses,
  };
}

function getHandler(harness: Harness, name: string): Handler {
  const handler = harness.handlers.get(name);
  if (!handler) throw new Error(`missing ${name} handler`);
  return handler;
}

function getTool(harness: Harness): Tool {
  const tool = harness.tools.find((candidate) => candidate.name === "herdr_orchestrate");
  if (!tool) throw new Error("missing herdr_orchestrate tool");
  return tool;
}

function authorizeStart(harness: Harness): void {
  getHandler(harness, "before_agent_start")(
    { prompt: "start a panopticon run", systemPrompt: "base prompt" },
    harness.context,
  );
}

function stateResponse(state: Record<string, unknown>, code = 0): ExecResult {
  // Default run_id is "run-1". When the session selects another run, override
  // `run_id` explicitly — execute() rejects mismatched returned run IDs.
  return {
    stdout: JSON.stringify({
      run_id: "run-1",
      status: "running",
      current_step: "developer",
      repo: "/repo",
      worktree: "/repo-worktree",
      steps: {},
      error: null,
      updated_at: "2026-08-21T00:00:00Z",
      ...state,
    }),
    stderr: "",
    code,
    killed: false,
  };
}

function resultText(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  const text = content[0]?.text;
  if (!text) throw new Error("tool result has no text");
  return text;
}

function setCwd(harness: Harness, cwd: string): void {
  Object.assign(harness.context, { cwd });
}

describe("herdr autoscale activation", () => {
  it("registers only for an eligible parent TUI/RPC session", async () => {
    const tui = createHarness("tui");
    expect(tui.execCalls).toHaveLength(0);
    await getHandler(tui, "session_start")({}, tui.context);
    expect(getTool(tui).name).toBe("herdr_orchestrate");
    expect(tui.commands.has("herdr-auto")).toBe(true);

    const rpc = createHarness("rpc");
    await getHandler(rpc, "session_start")({}, rpc.context);
    expect(getTool(rpc).name).toBe("herdr_orchestrate");

    process.env.HERDR_AUTOSCALE = "0";
    const disabled = createHarness("tui");
    expect(disabled.handlers.size).toBe(0);
    expect(disabled.tools).toHaveLength(0);
    expect(disabled.commands.size).toBe(0);

    delete process.env.HERDR_AUTOSCALE;
    process.env.PANOPTICON_CHILD = "1";
    const child = createHarness("tui");
    expect(child.handlers.size).toBe(0);
    expect(child.tools).toHaveLength(0);
    expect(child.commands.size).toBe(0);
  });

  it("does not register in print mode or start a resource from the factory", async () => {
    const harness = createHarness("print");
    expect(harness.handlers.has("session_start")).toBe(true);
    await getHandler(harness, "session_start")({}, harness.context);
    expect(harness.tools).toHaveLength(0);
    expect(harness.commands).toHaveLength(0);
    expect(harness.execCalls).toHaveLength(0);
  });
});

describe("herdr_orchestrate", () => {
  it("starts with shell-free argv, persists the run, and returns compact JSON", async () => {
    const harness = createHarness();
    await getHandler(harness, "session_start")({}, harness.context);
    harness.responses.push(
      stateResponse({
        steps: {
          developer: {
            status: "running",
            result: { summary: "x".repeat(20_000) },
            error: null,
          },
        },
        events: ["must not be returned"],
      }),
    );

    authorizeStart(harness);
    const result = await getTool(harness).execute(
      "call-1",
      {
        action: "start",
        task: "implement the feature",
        repo: "/repo",
        workflow: "standard",
        verify: ["vp test", "vp check"],
      },
      undefined,
      undefined,
      harness.context,
    );

    expect(harness.execCalls[0]).toEqual({
      command: "panopticon",
      args: [
        "start",
        "--task",
        "implement the feature",
        "--repo",
        "/repo",
        "--workflow",
        "standard",
        "--verify",
        "vp test",
        "--verify",
        "vp check",
      ],
      options: { cwd: "/repo", signal: undefined },
    });
    expect(harness.entries.at(-1)).toEqual({
      type: HERDR_AUTOSCALE_STATE_ENTRY,
      data: {
        enabled: true,
        latestRunId: "run-1",
        latestRepo: "/repo",
        activeRunId: "run-1",
        activeRepo: "/repo",
      },
    });
    const text = resultText(result);
    expect(text.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
    expect(text).not.toContain("must not be returned");
    expect(JSON.parse(text)).toMatchObject({
      run_id: "run-1",
      status: "running",
      steps: { developer: { status: "running" } },
    });
    expect(harness.statuses.at(-1)).toEqual({
      key: "herdr-autoscale",
      text: "Herdr run-1 · running",
    });
  });

  it("maps workflow default to standard", async () => {
    expect(resolveHerdrWorkflow(undefined)).toBeUndefined();
    expect(resolveHerdrWorkflow("standard")).toBe("standard");
    expect(resolveHerdrWorkflow("default")).toBe("standard");

    const harness = createHarness();
    await getHandler(harness, "session_start")({}, harness.context);
    harness.responses.push(stateResponse({ status: "running" }));

    authorizeStart(harness);
    await getTool(harness).execute(
      "call-default",
      {
        action: "start",
        task: "implement the feature",
        repo: "/repo",
        workflow: "default",
      },
      undefined,
      undefined,
      harness.context,
    );

    expect(harness.execCalls[0]?.args).toEqual([
      "start",
      "--task",
      "implement the feature",
      "--repo",
      "/repo",
      "--workflow",
      "standard",
    ]);
  });

  it("blocks active parent mutators and rejects a duplicate start", async () => {
    const harness = createHarness();
    await getHandler(harness, "session_start")({}, harness.context);
    harness.responses.push(stateResponse({ status: "running" }));
    authorizeStart(harness);
    await getTool(harness).execute(
      "start",
      { action: "start", task: "active task" },
      undefined,
      undefined,
      harness.context,
    );

    authorizeStart(harness);
    await expect(
      getTool(harness).execute(
        "start",
        { action: "start", task: "duplicate task" },
        undefined,
        undefined,
        harness.context,
      ),
    ).rejects.toThrow(/run-1/);
    expect(harness.execCalls).toHaveLength(1);

    const toolCall = getHandler(harness, "tool_call");
    for (const toolName of ["write", "edit", "bash", "subagent", "ast_grep_replace"]) {
      const result = (await toolCall(
        { type: "tool_call", toolCallId: toolName, toolName, input: {} },
        harness.context,
      )) as { block?: boolean; reason?: string };
      expect(result.block).toBe(true);
      expect(result.reason).toContain("run-1");
      expect(result.reason).toContain("herdr_orchestrate wait");
    }
    expect(
      await toolCall(
        { type: "tool_call", toolCallId: "read", toolName: "read", input: {} },
        harness.context,
      ),
    ).toBeUndefined();
    expect(
      await toolCall(
        {
          type: "tool_call",
          toolCallId: "orchestrate",
          toolName: "herdr_orchestrate",
          input: {},
        },
        harness.context,
      ),
    ).toBeUndefined();
  });

  it("bounds an error thrown by pi.exec", async () => {
    const harness = createHarness();
    await getHandler(harness, "session_start")({}, harness.context);
    harness.execErrors.push(new Error("x".repeat(MAX_OUTPUT_CHARS * 2)));

    let caught: unknown;
    try {
      authorizeStart(harness);
      await getTool(harness).execute(
        "start",
        { action: "start", task: "failed to execute" },
        undefined,
        undefined,
        harness.context,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    if (!(caught instanceof Error)) throw new Error("expected pi.exec error");
    expect(caught.message.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
    expect(caught.message).toContain("panopticon start");
  });

  it("rejects a non-zero start even when stdout looks like valid state JSON", async () => {
    const harness = createHarness();
    await getHandler(harness, "session_start")({}, harness.context);
    harness.responses.push(stateResponse({}, 1));

    authorizeStart(harness);
    await expect(
      getTool(harness).execute(
        "start",
        { action: "start", task: "failed start" },
        undefined,
        undefined,
        harness.context,
      ),
    ).rejects.toThrow(/exit 1/);
    expect(harness.entries).toHaveLength(0);
  });

  it("rejects a start result for another repository before persisting it", async () => {
    const harness = createHarness();
    await getHandler(harness, "session_start")({}, harness.context);
    harness.responses.push(stateResponse({ repo: "/other-repo" }));

    authorizeStart(harness);
    await expect(
      getTool(harness).execute(
        "start",
        { action: "start", task: "wrong repository" },
        undefined,
        undefined,
        harness.context,
      ),
    ).rejects.toThrow(/repository.*一致しません/);
    expect(harness.entries).toHaveLength(0);
  });

  it("rejects a start result without a repository", async () => {
    const harness = createHarness();
    await getHandler(harness, "session_start")({}, harness.context);
    harness.responses.push(stateResponse({ repo: null }));

    authorizeStart(harness);
    await expect(
      getTool(harness).execute(
        "start",
        { action: "start", task: "missing repository" },
        undefined,
        undefined,
        harness.context,
      ),
    ).rejects.toThrow(/repository/);
    expect(harness.entries).toHaveLength(0);
  });

  it("persists an active run when starting another repository from /repo", async () => {
    const harness = createHarness();
    await getHandler(harness, "session_start")({}, harness.context);
    harness.responses.push(
      stateResponse({ run_id: "run-other", status: "running", repo: "/other-repo" }),
    );

    authorizeStart(harness);
    await getTool(harness).execute(
      "start",
      { action: "start", task: "other repository task", repo: "/other-repo" },
      undefined,
      undefined,
      harness.context,
    );

    expect(harness.entries.at(-1)?.data).toEqual({
      enabled: true,
      latestRunId: "run-other",
      latestRepo: "/other-repo",
      activeRunId: "run-other",
      activeRepo: "/other-repo",
    });
    const guard = (await getHandler(harness, "tool_call")(
      { type: "tool_call", toolCallId: "write", toolName: "write", input: {} },
      harness.context,
    )) as { block?: boolean };
    expect(guard.block).toBe(true);
  });

  it("requires a session-owned run and never falls back to panopticon latest", async () => {
    const harness = createHarness();
    await getHandler(harness, "session_start")({}, harness.context);

    for (const action of ["status", "wait", "cancel"] as const) {
      await expect(
        getTool(harness).execute(action, { action }, undefined, undefined, harness.context),
      ).rejects.toThrow(/session custom entry/);
    }
    expect(harness.execCalls).toHaveLength(0);
  });

  it("uses the saved repo and run from the current session", async () => {
    const harness = createHarness("tui", [
      {
        type: "custom",
        customType: HERDR_AUTOSCALE_STATE_ENTRY,
        data: { enabled: true, latestRunId: "run-session", latestRepo: "." },
      },
    ]);
    await getHandler(harness, "session_start")({}, harness.context);
    harness.responses.push(stateResponse({ run_id: "run-session", status: "completed" }));

    await getTool(harness).execute(
      "status",
      { action: "status" },
      undefined,
      undefined,
      harness.context,
    );

    expect(harness.execCalls[0]?.args).toEqual(["status", "--run-id", "run-session"]);
  });

  it("rejects explicit run IDs not owned by this session before invoking the CLI", async () => {
    const harness = createHarness("tui", [
      {
        type: "custom",
        customType: HERDR_AUTOSCALE_STATE_ENTRY,
        data: { enabled: true, latestRunId: "run-owned", latestRepo: "/repo" },
      },
    ]);
    await getHandler(harness, "session_start")({}, harness.context);

    for (const action of ["status", "wait", "cancel"] as const) {
      await expect(
        getTool(harness).execute(
          action,
          { action, run_id: "run-from-another-session" },
          undefined,
          undefined,
          harness.context,
        ),
      ).rejects.toThrow(/latestRunId/);
    }
    expect(harness.execCalls).toHaveLength(0);
  });

  it("rejects explicit operations when latest ownership pair is incomplete", async () => {
    for (const data of [
      { enabled: true, latestRunId: "run-owned" },
      { enabled: true, latestRepo: "/repo" },
    ]) {
      const harness = createHarness("tui", [
        { type: "custom", customType: HERDR_AUTOSCALE_STATE_ENTRY, data },
      ]);
      await getHandler(harness, "session_start")({}, harness.context);

      for (const action of ["status", "wait", "cancel"] as const) {
        await expect(
          getTool(harness).execute(
            action,
            { action, run_id: "run-owned" },
            undefined,
            undefined,
            harness.context,
          ),
        ).rejects.toThrow(/ownership pair/);
      }
      expect(harness.execCalls).toHaveLength(0);
    }
  });

  it("requires repository in status/wait/cancel responses for explicit and implicit runs", async () => {
    for (const explicit of [false, true]) {
      for (const action of ["status", "wait", "cancel"] as const) {
        const harness = createHarness("tui", [
          {
            type: "custom",
            customType: HERDR_AUTOSCALE_STATE_ENTRY,
            data: { enabled: true, latestRunId: "run-owned", latestRepo: "/repo" },
          },
        ]);
        await getHandler(harness, "session_start")({}, harness.context);
        harness.responses.push(
          stateResponse({ run_id: "run-owned", status: "running", repo: null }),
        );

        const params = explicit ? { action, run_id: "run-owned" } : { action };
        await expect(
          getTool(harness).execute(action, params, undefined, undefined, harness.context),
        ).rejects.toThrow(/repository/);
        expect(harness.execCalls).toHaveLength(1);
      }
    }
  });

  it("allows an explicit latest run from another cwd", async () => {
    const harness = createHarness();
    await getHandler(harness, "session_start")({}, harness.context);
    harness.responses.push(
      stateResponse({ run_id: "run-owned", status: "running", repo: "/repo" }),
    );
    authorizeStart(harness);
    await getTool(harness).execute(
      "start",
      { action: "start", task: "explicit cwd task" },
      undefined,
      undefined,
      harness.context,
    );

    setCwd(harness, "/other-repo");
    harness.responses.push(
      stateResponse({ run_id: "run-owned", status: "completed", repo: "/repo" }),
    );
    await getTool(harness).execute(
      "status",
      { action: "status", run_id: "run-owned" },
      undefined,
      undefined,
      harness.context,
    );

    expect(harness.execCalls[1]).toEqual({
      command: "panopticon",
      args: ["status", "--run-id", "run-owned"],
      options: { cwd: "/other-repo", signal: undefined },
    });
    expect(harness.entries.at(-1)?.data).toEqual({
      enabled: true,
      latestRunId: "run-owned",
      latestRepo: "/repo",
    });
  });

  it("rejects an explicit cancel when this session owns no run", async () => {
    const harness = createHarness();
    await getHandler(harness, "session_start")({}, harness.context);

    await expect(
      getTool(harness).execute(
        "cancel",
        { action: "cancel", run_id: "run-from-another-session" },
        undefined,
        undefined,
        harness.context,
      ),
    ).rejects.toThrow(/latestRunId/);
    expect(harness.execCalls).toHaveLength(0);
  });

  it("rejects non-explicit operations from another repository before invoking the CLI", async () => {
    for (const action of ["status", "wait", "cancel"] as const) {
      const harness = createHarness("tui", [
        {
          type: "custom",
          customType: HERDR_AUTOSCALE_STATE_ENTRY,
          data: { enabled: true, latestRunId: "run-other", latestRepo: "/repo" },
        },
      ]);
      await getHandler(harness, "session_start")({}, harness.context);
      setCwd(harness, "/other-repo");

      await expect(
        getTool(harness).execute(action, { action }, undefined, undefined, harness.context),
      ).rejects.toThrow(/一致しません/);
      expect(harness.execCalls).toHaveLength(0);
    }
  });

  it("uses the saved latest run for wait and passes the tool AbortSignal", async () => {
    const harness = createHarness();
    await getHandler(harness, "session_start")({}, harness.context);
    harness.responses.push(stateResponse({}), stateResponse({ status: "completed" }));
    authorizeStart(harness);
    await getTool(harness).execute(
      "start",
      { action: "start", task: "long task" },
      undefined,
      undefined,
      harness.context,
    );

    const controller = new AbortController();
    const result = await getTool(harness).execute(
      "wait",
      { action: "wait", timeout_seconds: 10, interval_seconds: 0.2 },
      controller.signal,
      undefined,
      harness.context,
    );

    expect(harness.execCalls[1]).toEqual({
      command: "panopticon",
      args: ["wait", "--run-id", "run-1", "--timeout-seconds", "10", "--interval-seconds", "0.2"],
      options: { cwd: "/repo", signal: controller.signal },
    });
    expect(JSON.parse(resultText(result))).toMatchObject({
      run_id: "run-1",
      status: "completed",
    });
    expect(harness.statuses.at(-1)).toEqual({
      key: "herdr-autoscale",
      text: undefined,
    });
  });

  it("keeps the active guard and returns a tool error when terminal persistence fails", async () => {
    for (const action of ["wait", "status"] as const) {
      const harness = createHarness();
      await getHandler(harness, "session_start")({}, harness.context);
      harness.responses.push(stateResponse({ status: "running" }));
      authorizeStart(harness);
      await getTool(harness).execute(
        "start",
        { action: "start", task: "terminal persistence failure" },
        undefined,
        undefined,
        harness.context,
      );

      harness.appendErrors.push(new Error("terminal state persistence failed"));
      harness.responses.push(stateResponse({ status: "completed" }));
      await expect(
        getTool(harness).execute(action, { action }, undefined, undefined, harness.context),
      ).rejects.toThrow("terminal state persistence failed");

      expect(harness.statuses.at(-1)).toEqual({
        key: "herdr-autoscale",
        text: "Herdr run-1 · active",
      });
      const guard = (await getHandler(harness, "tool_call")(
        { type: "tool_call", toolCallId: "write", toolName: "write", input: {} },
        harness.context,
      )) as { block?: boolean };
      expect(guard.block).toBe(true);
    }
  });

  it("clears the active state after a terminal result and allows a new start", async () => {
    const harness = createHarness();
    await getHandler(harness, "session_start")({}, harness.context);
    harness.responses.push(
      stateResponse({ status: "running" }),
      stateResponse({ status: "completed" }),
    );
    authorizeStart(harness);
    await getTool(harness).execute(
      "start",
      { action: "start", task: "terminal task" },
      undefined,
      undefined,
      harness.context,
    );
    await getTool(harness).execute(
      "wait",
      { action: "wait" },
      undefined,
      undefined,
      harness.context,
    );

    expect(harness.entries.at(-1)?.data).toEqual({
      enabled: true,
      latestRunId: "run-1",
      latestRepo: "/repo",
    });
    expect(
      await getHandler(harness, "tool_call")(
        { type: "tool_call", toolCallId: "write", toolName: "write", input: {} },
        harness.context,
      ),
    ).toBeUndefined();

    harness.responses.push(stateResponse({ run_id: "run-2", status: "running" }));
    authorizeStart(harness);
    await getTool(harness).execute(
      "start",
      { action: "start", task: "new task" },
      undefined,
      undefined,
      harness.context,
    );
    expect(harness.entries.at(-1)?.data).toMatchObject({
      activeRunId: "run-2",
      activeRepo: "/repo",
    });
  });

  it("keeps the active guard when tree navigation has no autoscale state entry", async () => {
    const harness = createHarness();
    await getHandler(harness, "session_start")({}, harness.context);
    harness.responses.push(stateResponse({ status: "running" }));
    authorizeStart(harness);
    await getTool(harness).execute(
      "start",
      { action: "start", task: "branch-safe task" },
      undefined,
      undefined,
      harness.context,
    );

    harness.branch.length = 0;
    await getHandler(harness, "session_tree")({}, harness.context);
    const result = (await getHandler(harness, "tool_call")(
      { type: "tool_call", toolCallId: "write", toolName: "write", input: {} },
      harness.context,
    )) as { block?: boolean; reason?: string };

    expect(result.block).toBe(true);
    expect(result.reason).toContain("run-1");
  });

  it("keeps the active guard when session-start reconciliation persistence fails", async () => {
    const harness = createHarness("tui", [
      {
        type: "custom",
        customType: HERDR_AUTOSCALE_STATE_ENTRY,
        data: {
          enabled: true,
          latestRunId: "run-1",
          latestRepo: "/repo",
          activeRunId: "run-1",
          activeRepo: "/repo",
        },
      },
    ]);
    harness.appendErrors.push(new Error("terminal state persistence failed"));
    harness.responses.push(stateResponse({ status: "completed" }));

    await getHandler(harness, "session_start")({}, harness.context);

    expect(harness.statuses.at(-1)).toEqual({
      key: "herdr-autoscale",
      text: "Herdr run-1 · active",
    });
    expect(harness.notifications.at(-1)).toContain("guardを維持");
    const guard = (await getHandler(harness, "tool_call")(
      { type: "tool_call", toolCallId: "write", toolName: "write", input: {} },
      harness.context,
    )) as { block?: boolean };
    expect(guard.block).toBe(true);
  });

  it("reconciles a terminal run after returning to an earlier branch", async () => {
    const harness = createHarness();
    await getHandler(harness, "session_start")({}, harness.context);
    harness.responses.push(stateResponse({ status: "running" }));
    authorizeStart(harness);
    await getTool(harness).execute(
      "start",
      { action: "start", task: "branch terminal task" },
      undefined,
      undefined,
      harness.context,
    );

    harness.branch.length = 0;
    harness.responses.push(stateResponse({ status: "completed" }));
    await getHandler(harness, "session_tree")({}, harness.context);

    expect(harness.execCalls.at(-1)?.args).toEqual(["status", "--run-id", "run-1"]);
    expect(harness.entries.at(-1)?.data).toEqual({
      enabled: true,
      latestRunId: "run-1",
      latestRepo: "/repo",
    });
    expect(
      await getHandler(harness, "tool_call")(
        { type: "tool_call", toolCallId: "write", toolName: "write", input: {} },
        harness.context,
      ),
    ).toBeUndefined();
  });

  it("keeps active and latest ownership when tree moves before the start entry", async () => {
    const harness = createHarness("tui", [
      {
        type: "custom",
        customType: HERDR_AUTOSCALE_STATE_ENTRY,
        data: { enabled: true, latestRunId: "run-old", latestRepo: "/repo" },
      },
    ]);
    await getHandler(harness, "session_start")({}, harness.context);
    harness.responses.push(stateResponse({ run_id: "run-new", status: "running" }));
    authorizeStart(harness);
    await getTool(harness).execute(
      "start",
      { action: "start", task: "branch-safe task" },
      undefined,
      undefined,
      harness.context,
    );

    harness.branch.length = 1;
    await getHandler(harness, "session_tree")({}, harness.context);
    const guard = (await getHandler(harness, "tool_call")(
      { type: "tool_call", toolCallId: "write", toolName: "write", input: {} },
      harness.context,
    )) as { block?: boolean; reason?: string };

    expect(guard.block).toBe(true);
    expect(guard.reason).toContain("run-new");

    harness.responses.push(stateResponse({ run_id: "run-new", status: "running" }));
    await getTool(harness).execute(
      "status",
      { action: "status", run_id: "run-new" },
      undefined,
      undefined,
      harness.context,
    );
    expect(harness.execCalls.at(-1)?.args).toEqual(["status", "--run-id", "run-new"]);
  });

  it("does not restore an incomplete or different-repository active state", async () => {
    for (const data of [
      { activeRunId: "run-without-repo" },
      { activeRepo: "/repo" },
      { activeRunId: "run-other", activeRepo: "/other-repo" },
    ]) {
      const harness = createHarness("tui", [
        { type: "custom", customType: HERDR_AUTOSCALE_STATE_ENTRY, data },
      ]);
      await getHandler(harness, "session_start")({}, harness.context);
      const result = await getHandler(harness, "tool_call")(
        { type: "tool_call", toolCallId: "write", toolName: "write", input: {} },
        harness.context,
      );

      expect(result).toBeUndefined();
    }
  });

  it("enforces the interval schema and direct execute boundaries", async () => {
    const harness = createHarness("tui", [
      {
        type: "custom",
        customType: HERDR_AUTOSCALE_STATE_ENTRY,
        data: { enabled: true, latestRunId: "run-boundary", latestRepo: "/repo" },
      },
    ]);
    await getHandler(harness, "session_start")({}, harness.context);
    const schema = getTool(harness).parameters as {
      properties: {
        interval_seconds: { minimum: number; maximum: number };
      };
    };
    expect(schema.properties.interval_seconds).toMatchObject({ minimum: 0.2, maximum: 30 });

    await expect(
      getTool(harness).execute(
        "wait",
        { action: "wait", interval_seconds: 0.199 },
        undefined,
        undefined,
        harness.context,
      ),
    ).rejects.toThrow(/0.2以上30以下/);
    await expect(
      getTool(harness).execute(
        "wait",
        { action: "wait", interval_seconds: 30.001 },
        undefined,
        undefined,
        harness.context,
      ),
    ).rejects.toThrow(/0.2以上30以下/);
    expect(harness.execCalls).toHaveLength(0);

    harness.responses.push(
      stateResponse({ run_id: "run-boundary", status: "running" }, 124),
      stateResponse({ run_id: "run-boundary", status: "running" }, 124),
    );
    await getTool(harness).execute(
      "wait",
      { action: "wait", interval_seconds: 0.2 },
      undefined,
      undefined,
      harness.context,
    );
    await getTool(harness).execute(
      "wait",
      { action: "wait", interval_seconds: 30 },
      undefined,
      undefined,
      harness.context,
    );
    expect(harness.execCalls[0]?.args).toContain("0.2");
    expect(harness.execCalls[1]?.args).toContain("30");
  });

  it("restores a matching active guard when the session cwd differs", async () => {
    const harness = createHarness("tui", [
      {
        type: "custom",
        customType: HERDR_AUTOSCALE_STATE_ENTRY,
        data: {
          enabled: true,
          latestRunId: "run-restored",
          latestRepo: "/other-repo/.",
          activeRunId: "run-restored",
          activeRepo: "/other-repo",
        },
      },
    ]);
    harness.responses.push(
      stateResponse({ run_id: "run-restored", status: "running", repo: "/other-repo" }),
    );

    await getHandler(harness, "session_start")({}, harness.context);

    expect(harness.execCalls[0]).toEqual({
      command: "panopticon",
      args: ["status", "--run-id", "run-restored"],
      options: { cwd: "/repo", signal: undefined },
    });
    const guard = (await getHandler(harness, "tool_call")(
      { type: "tool_call", toolCallId: "write", toolName: "write", input: {} },
      harness.context,
    )) as { block?: boolean; reason?: string };
    expect(guard.block).toBe(true);
    expect(guard.reason).toContain("run-restored");
  });

  it("clears a terminal active run from another repository during session_start", async () => {
    const harness = createHarness("tui", [
      {
        type: "custom",
        customType: HERDR_AUTOSCALE_STATE_ENTRY,
        data: {
          enabled: true,
          latestRunId: "run-restored",
          latestRepo: "/other-repo",
          activeRunId: "run-restored",
          activeRepo: "/other-repo",
        },
      },
    ]);
    harness.responses.push(
      stateResponse({ run_id: "run-restored", status: "completed", repo: "/other-repo" }),
    );

    await getHandler(harness, "session_start")({}, harness.context);

    expect(harness.execCalls[0]).toEqual({
      command: "panopticon",
      args: ["status", "--run-id", "run-restored"],
      options: { cwd: "/repo", signal: undefined },
    });
    expect(harness.entries.at(-1)?.data).toEqual({
      enabled: true,
      latestRunId: "run-restored",
      latestRepo: "/other-repo",
    });
    expect(
      await getHandler(harness, "tool_call")(
        { type: "tool_call", toolCallId: "write", toolName: "write", input: {} },
        harness.context,
      ),
    ).toBeUndefined();
  });

  it("clears a terminal active run during session_start", async () => {
    const harness = createHarness("tui", [
      {
        type: "custom",
        customType: HERDR_AUTOSCALE_STATE_ENTRY,
        data: {
          enabled: true,
          latestRunId: "run-restored",
          latestRepo: "/repo",
          activeRunId: "run-restored",
          activeRepo: "/repo",
        },
      },
    ]);
    harness.responses.push(stateResponse({ run_id: "run-restored", status: "completed" }));

    await getHandler(harness, "session_start")({}, harness.context);

    expect(harness.execCalls[0]).toEqual({
      command: "panopticon",
      args: ["status", "--run-id", "run-restored"],
      options: { cwd: "/repo", signal: undefined },
    });
    expect(harness.entries.at(-1)?.data).toEqual({
      enabled: true,
      latestRunId: "run-restored",
      latestRepo: "/repo",
    });
    expect(
      await getHandler(harness, "tool_call")(
        { type: "tool_call", toolCallId: "write", toolName: "write", input: {} },
        harness.context,
      ),
    ).toBeUndefined();
    expect(harness.statuses.at(-1)).toEqual({
      key: "herdr-autoscale",
      text: undefined,
    });
  });

  it("keeps the active guard when session_start status lookup fails", async () => {
    const harness = createHarness("tui", [
      {
        type: "custom",
        customType: HERDR_AUTOSCALE_STATE_ENTRY,
        data: {
          enabled: true,
          latestRunId: "run-restored",
          latestRepo: "/repo",
          activeRunId: "run-restored",
          activeRepo: "/repo",
        },
      },
    ]);
    harness.execErrors.push(new Error("panopticon unavailable"));

    await getHandler(harness, "session_start")({}, harness.context);

    const guard = (await getHandler(harness, "tool_call")(
      { type: "tool_call", toolCallId: "write", toolName: "write", input: {} },
      harness.context,
    )) as { block?: boolean; reason?: string };
    expect(guard.block).toBe(true);
    expect(guard.reason).toContain("run-restored");
  });

  it("keeps the active guard when session_start status ownership differs", async () => {
    const harness = createHarness("tui", [
      {
        type: "custom",
        customType: HERDR_AUTOSCALE_STATE_ENTRY,
        data: {
          enabled: true,
          latestRunId: "run-restored",
          latestRepo: "/repo",
          activeRunId: "run-restored",
          activeRepo: "/repo",
        },
      },
    ]);
    harness.responses.push(stateResponse({ run_id: "run-other", status: "completed" }));

    await getHandler(harness, "session_start")({}, harness.context);

    const guard = (await getHandler(harness, "tool_call")(
      { type: "tool_call", toolCallId: "write", toolName: "write", input: {} },
      harness.context,
    )) as { block?: boolean; reason?: string };
    expect(guard.block).toBe(true);
    expect(guard.reason).toContain("run-restored");
  });

  it("keeps the active guard when session_start status repository ownership differs", async () => {
    const harness = createHarness("tui", [
      {
        type: "custom",
        customType: HERDR_AUTOSCALE_STATE_ENTRY,
        data: {
          enabled: true,
          latestRunId: "run-restored",
          latestRepo: "/repo",
          activeRunId: "run-restored",
          activeRepo: "/repo",
        },
      },
    ]);
    harness.responses.push(
      stateResponse({ run_id: "run-restored", status: "completed", repo: "/other-repo" }),
    );

    await getHandler(harness, "session_start")({}, harness.context);

    const guard = (await getHandler(harness, "tool_call")(
      { type: "tool_call", toolCallId: "write", toolName: "write", input: {} },
      harness.context,
    )) as { block?: boolean; reason?: string };
    expect(guard.block).toBe(true);
    expect(guard.reason).toContain("run-restored");
    expect(harness.entries).toHaveLength(0);
  });

  it("does not restore active ownership when active/latest pairs differ", async () => {
    for (const data of [
      {
        enabled: true,
        latestRunId: "run-latest",
        latestRepo: "/repo",
        activeRunId: "run-active",
        activeRepo: "/repo",
      },
      {
        enabled: true,
        latestRunId: "run-restored",
        latestRepo: "/other-repo",
        activeRunId: "run-restored",
        activeRepo: "/repo",
      },
    ]) {
      const harness = createHarness("tui", [
        { type: "custom", customType: HERDR_AUTOSCALE_STATE_ENTRY, data },
      ]);

      await getHandler(harness, "session_start")({}, harness.context);

      expect(harness.execCalls).toHaveLength(0);
      expect(
        await getHandler(harness, "tool_call")(
          { type: "tool_call", toolCallId: "write", toolName: "write", input: {} },
          harness.context,
        ),
      ).toBeUndefined();
      expect(harness.entries).toHaveLength(0);
    }
  });

  it("restores the toggle and latest run from the current branch", async () => {
    const harness = createHarness("tui", [
      {
        type: "custom",
        customType: HERDR_AUTOSCALE_STATE_ENTRY,
        data: {
          enabled: false,
          latestRunId: "run-restored",
          latestRepo: "/repo",
          activeRunId: "run-restored",
          activeRepo: "/repo",
        },
      },
    ]);
    await getHandler(harness, "session_start")({}, harness.context);

    const toolCall = getHandler(harness, "tool_call");
    const restoredGuard = (await toolCall(
      { type: "tool_call", toolCallId: "write", toolName: "write", input: {} },
      harness.context,
    )) as { block?: boolean; reason?: string };
    expect(restoredGuard.block).toBe(true);
    expect(restoredGuard.reason).toContain("run-restored");
    await getHandler(harness, "session_tree")({}, harness.context);
    const restoredAfterTree = (await toolCall(
      { type: "tool_call", toolCallId: "bash", toolName: "bash", input: {} },
      harness.context,
    )) as { block?: boolean; reason?: string };
    expect(restoredAfterTree.block).toBe(true);

    const guidance = await getHandler(harness, "before_agent_start")(
      { systemPrompt: "base prompt" },
      harness.context,
    );
    expect(guidance).toBeUndefined();
    authorizeStart(harness);
    await expect(
      getTool(harness).execute(
        "start",
        { action: "start", task: "must be rejected" },
        undefined,
        undefined,
        harness.context,
      ),
    ).rejects.toThrow(/off/);

    harness.responses.push(stateResponse({ run_id: "run-restored", status: "completed" }));
    await getTool(harness).execute(
      "wait",
      { action: "wait" },
      undefined,
      undefined,
      harness.context,
    );
    expect(harness.execCalls.at(-1)?.args).toEqual(["wait", "--run-id", "run-restored"]);
  });

  it("toggles per session and refreshes prompt guidelines", async () => {
    const harness = createHarness();
    await getHandler(harness, "session_start")({}, harness.context);
    const command = harness.commands.get("herdr-auto");
    if (!command) throw new Error("missing herdr-auto command");

    await command.handler("off", harness.context);
    expect(getTool(harness).promptGuidelines).toEqual(DISABLED_PROMPT_GUIDELINES);
    expect(harness.entries.at(-1)?.data).toEqual({ enabled: false });
    expect(
      await getHandler(harness, "before_agent_start")(
        { systemPrompt: "base prompt" },
        harness.context,
      ),
    ).toBeUndefined();

    await command.handler("on", harness.context);
    expect(getTool(harness).promptGuidelines).toEqual(PROMPT_GUIDELINES);
    expect(harness.entries.at(-1)?.data).toEqual({ enabled: true });
    expect(harness.notifications.at(-1)).toContain("autoscale on");
  });

  it("injects short system guidance without replacing the user prompt or duplicating it", async () => {
    const harness = createHarness();
    await getHandler(harness, "session_start")({}, harness.context);
    const event = {
      prompt: "Please refactor this",
      systemPrompt: "base prompt",
      systemPromptOptions: {},
    };
    const result = await getHandler(harness, "before_agent_start")(event, harness.context);
    if (!result || typeof result !== "object" || !("systemPrompt" in result)) {
      throw new Error("missing system prompt result");
    }
    const systemPrompt = String(result.systemPrompt);
    expect(systemPrompt).toContain(EXPLICIT_ONLY_RULE);
    expect(systemPrompt).not.toContain(event.prompt);

    const repeated = await getHandler(harness, "before_agent_start")(
      { ...event, systemPrompt },
      harness.context,
    );
    expect(repeated).toBeUndefined();
  });

  it("gates start on the current user request naming panopticon or herdr", async () => {
    const harness = createHarness();
    await getHandler(harness, "session_start")({}, harness.context);

    await expect(
      getTool(harness).execute(
        "start",
        { action: "start", task: "implicit task" },
        undefined,
        undefined,
        harness.context,
      ),
    ).rejects.toThrow(/explicit-only/);
    expect(harness.execCalls).toHaveLength(0);

    authorizeStart(harness);
    harness.responses.push(stateResponse({ status: "completed" }));
    await getTool(harness).execute(
      "start",
      { action: "start", task: "explicit task" },
      undefined,
      undefined,
      harness.context,
    );
    expect(harness.execCalls).toHaveLength(1);

    await expect(
      getTool(harness).execute(
        "start",
        { action: "start", task: "reused authorization" },
        undefined,
        undefined,
        harness.context,
      ),
    ).rejects.toThrow(/explicit-only/);
    expect(harness.execCalls).toHaveLength(1);

    getHandler(harness, "before_agent_start")(
      { prompt: "fix a typo", systemPrompt: "base prompt" },
      harness.context,
    );
    await expect(
      getTool(harness).execute(
        "start",
        { action: "start", task: "implicit again" },
        undefined,
        undefined,
        harness.context,
      ),
    ).rejects.toThrow(/explicit-only/);
    expect(harness.execCalls).toHaveLength(1);
  });

  it("consumes one explicit start attempt after CLI failure or repository mismatch", async () => {
    for (const failure of ["cli", "repo"] as const) {
      const harness = createHarness();
      await getHandler(harness, "session_start")({}, harness.context);
      authorizeStart(harness);
      if (failure === "cli") {
        harness.execErrors.push(new Error("panopticon unavailable"));
      } else {
        harness.responses.push(stateResponse({ repo: "/other-repo" }));
      }

      await expect(
        getTool(harness).execute(
          "start",
          { action: "start", task: `failed ${failure} start` },
          undefined,
          undefined,
          harness.context,
        ),
      ).rejects.toThrow();
      await expect(
        getTool(harness).execute(
          "start",
          { action: "start", task: `retry ${failure} start` },
          undefined,
          undefined,
          harness.context,
        ),
      ).rejects.toThrow(/explicit-only/);
      expect(harness.execCalls).toHaveLength(1);
    }
    expect(EXPLICIT_ONLY_RULE).toContain("never retry start without a new explicit user request");
  });

  it("closes the gate when before_agent_start has no prompt", async () => {
    const harness = createHarness();
    await getHandler(harness, "session_start")({}, harness.context);
    authorizeStart(harness);
    getHandler(harness, "before_agent_start")({ systemPrompt: "base prompt" }, harness.context);
    await expect(
      getTool(harness).execute(
        "start",
        { action: "start", task: "stale authorization" },
        undefined,
        undefined,
        harness.context,
      ),
    ).rejects.toThrow(/explicit-only/);
    expect(harness.execCalls).toHaveLength(0);
  });

  it("blocks direct panopticon start/cancel via bash even without an active run", async () => {
    const harness = createHarness();
    await getHandler(harness, "session_start")({}, harness.context);
    const toolCall = getHandler(harness, "tool_call");

    const blockedStart = (await toolCall(
      {
        type: "tool_call",
        toolCallId: "bash-1",
        toolName: "bash",
        input: { command: "HERDR_ENV=1 panopticon start --repo . 'task'" },
      },
      harness.context,
    )) as { block?: boolean; reason?: string };
    expect(blockedStart.block).toBe(true);
    expect(blockedStart.reason).toContain("herdr_orchestrate");

    const blockedCancel = (await toolCall(
      {
        type: "tool_call",
        toolCallId: "bash-2",
        toolName: "bash",
        input: { command: "bin/panopticon cancel run-1" },
      },
      harness.context,
    )) as { block?: boolean };
    expect(blockedCancel.block).toBe(true);

    const allowed = await toolCall(
      {
        type: "tool_call",
        toolCallId: "bash-3",
        toolName: "bash",
        input: { command: "panopticon status --run-id run-1" },
      },
      harness.context,
    );
    expect(allowed).toBeUndefined();
  });

  it("keeps every model-visible surface explicit-only", async () => {
    const harness = createHarness();
    await getHandler(harness, "session_start")({}, harness.context);
    const tool = getTool(harness);
    const visible = [
      tool.description ?? "",
      ...(tool.promptGuidelines ?? []),
      BEFORE_AGENT_GUIDANCE,
    ].join("\n");
    expect(visible).toContain(EXPLICIT_ONLY_RULE);
    expect(visible).not.toMatch(/start first|automatic|on your own judgment[^,.]*(fine|allowed)/i);
  });

  it("allows latest-run cancel and reports CLI failures clearly", async () => {
    const harness = createHarness();
    await getHandler(harness, "session_start")({}, harness.context);
    harness.responses.push(stateResponse({}), stateResponse({ status: "cancel_requested" }, 2));
    authorizeStart(harness);
    await getTool(harness).execute(
      "start",
      { action: "start", task: "cancelable task" },
      undefined,
      undefined,
      harness.context,
    );
    await getTool(harness).execute(
      "cancel",
      { action: "cancel" },
      undefined,
      undefined,
      harness.context,
    );
    expect(harness.execCalls.at(-1)?.args).toEqual(["cancel", "run-1"]);

    harness.responses.push({
      stdout: JSON.stringify({ error: "HERDR_ENV=1 is required", type: "HerdrError" }),
      stderr: "",
      code: 1,
      killed: false,
    });
    await expect(
      getTool(harness).execute(
        "status",
        { action: "status", run_id: "run-1" },
        undefined,
        undefined,
        harness.context,
      ),
    ).rejects.toThrow(/HERDR_ENV=1/);
  });

  it("does not cancel a run when wait is aborted", async () => {
    const harness = createHarness();
    await getHandler(harness, "session_start")({}, harness.context);
    harness.responses.push(stateResponse({}), {
      stdout: "",
      stderr: "",
      code: 130,
      killed: true,
    });
    authorizeStart(harness);
    await getTool(harness).execute(
      "start",
      { action: "start", task: "wait task" },
      undefined,
      undefined,
      harness.context,
    );

    const controller = new AbortController();
    const wait = getTool(harness).execute(
      "wait",
      { action: "wait" },
      controller.signal,
      undefined,
      harness.context,
    );
    controller.abort();
    await expect(wait).rejects.toThrow(/cancel していません/);
    expect(harness.execCalls).toHaveLength(2);
    expect(harness.execCalls.at(-1)?.args[0]).toBe("wait");
  });
});
