import type {
  ExecResult,
  ExtensionAPI,
  SessionEntry,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";
import { createPanopticonBackend } from "../extensions/herdr-autoscale/backend.js";
import {
  HERDR_AUTOSCALE_STATE_ENTRY,
  MAX_OUTPUT_CHARS,
} from "../extensions/herdr-autoscale/contract.js";
import {
  hasLatestOwnership,
  hasMatchingActiveOwnership,
  restoreHerdrAutoscaleState,
  sameRepo,
  sameResolvedRepo,
} from "../extensions/herdr-autoscale/session.js";
import {
  EXPLICIT_ONLY_RULE,
  guardToolCall,
  isEnvironmentEnabled,
  isExplicitStartPrompt,
  isSupportedMode,
} from "../extensions/herdr-autoscale/policy.js";

function stateResponse(state: Record<string, unknown> = {}, code = 0): ExecResult {
  return {
    stdout: JSON.stringify({
      run_id: "run-1",
      status: "running",
      repo: "/repo",
      current_step: null,
      worktree: null,
      steps: {},
      error: null,
      updated_at: null,
      ...state,
    }),
    stderr: "",
    code,
    killed: false,
  };
}

function createBackend(response: ExecResult | Error): {
  backend: ReturnType<typeof createPanopticonBackend>;
  calls: Array<{ command: string; args: string[]; cwd: string; signal?: AbortSignal }>;
} {
  const calls: Array<{ command: string; args: string[]; cwd: string; signal?: AbortSignal }> = [];
  const pi = {
    async exec(
      command: string,
      args: string[],
      options: { cwd?: string; signal?: AbortSignal },
    ): Promise<ExecResult> {
      calls.push({ command, args, cwd: options.cwd ?? "", signal: options.signal });
      if (response instanceof Error) throw response;
      return response;
    },
  } as Pick<ExtensionAPI, "exec">;
  return { backend: createPanopticonBackend(pi), calls };
}

function toolCall(toolName: string, input: Record<string, unknown> = {}): ToolCallEvent {
  return {
    type: "tool_call",
    toolCallId: "test-call",
    toolName,
    input,
  } as ToolCallEvent;
}

function stateEntry(data: Record<string, unknown>): SessionEntry {
  return {
    type: "custom",
    customType: HERDR_AUTOSCALE_STATE_ENTRY,
    data,
  } as unknown as SessionEntry;
}

describe("herdr autoscale backend contract", () => {
  it("rejects malformed JSON and an invalid exit/status pair", async () => {
    const malformed = createBackend({
      stdout: "not-json",
      stderr: "malformed output",
      code: 0,
      killed: false,
    });
    await expect(malformed.backend.invoke("status", ["status"], { cwd: "/repo" })).rejects.toThrow(
      /JSON/,
    );

    const invalidExit = createBackend(stateResponse({ status: "running" }, 1));
    await expect(invalidExit.backend.invoke("start", ["start"], { cwd: "/repo" })).rejects.toThrow(
      /exit 1/,
    );
  });

  it("keeps compact output bounded", async () => {
    const steps = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [
        `step-${index}`,
        { status: "running", result: { summary: "x".repeat(2_000) } },
      ]),
    );
    const { backend } = createBackend(stateResponse({ steps }));

    const result = await backend.invoke("status", ["status"], { cwd: "/repo" });

    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
    expect(result.state.steps).toEqual({});
  });

  it("honors Abort without issuing a cancel", async () => {
    const controller = new AbortController();
    controller.abort();
    const { backend, calls } = createBackend({
      stdout: "",
      stderr: "",
      code: 130,
      killed: true,
    });

    await expect(
      backend.invoke("wait", ["wait", "--run-id", "run-1"], {
        cwd: "/repo",
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancel していません/);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0]).toBe("wait");
  });
});

describe("herdr autoscale session ownership", () => {
  it("rejects incomplete ownership and restores only matching active pairs", () => {
    const missingRun = restoreHerdrAutoscaleState([
      stateEntry({ enabled: true, latestRepo: "/repo" }),
    ]);
    expect(missingRun).toEqual({ enabled: true, latestRepo: "/repo" });
    expect(hasLatestOwnership(missingRun ?? { enabled: true })).toBe(false);

    const matching = restoreHerdrAutoscaleState([
      stateEntry({
        enabled: true,
        latestRunId: "run-1",
        latestRepo: "/repo/.",
        activeRunId: "run-1",
        activeRepo: "/repo",
      }),
    ]);
    expect(matching).toBeDefined();
    expect(hasLatestOwnership(matching!)).toBe(true);
    expect(hasMatchingActiveOwnership(matching!, "/repo")).toBe(true);

    const mismatched = restoreHerdrAutoscaleState([
      stateEntry({
        enabled: true,
        latestRunId: "run-1",
        latestRepo: "/repo",
        activeRunId: "run-2",
        activeRepo: "/repo",
      }),
    ]);
    expect(hasMatchingActiveOwnership(mismatched!, "/repo")).toBe(false);
  });

  it("restores the latest valid state while skipping trailing unrelated and invalid entries", () => {
    const restored = restoreHerdrAutoscaleState([
      stateEntry({ enabled: false, latestRunId: "run-old", latestRepo: "/old" }),
      { type: "custom", customType: "other", data: { enabled: false } } as SessionEntry,
      stateEntry({ enabled: true, latestRunId: "run-new", latestRepo: "/new" }),
      { type: "custom", customType: HERDR_AUTOSCALE_STATE_ENTRY, data: null } as SessionEntry,
      { type: "message" } as SessionEntry,
    ]);

    expect(restored).toEqual({
      enabled: true,
      latestRunId: "run-new",
      latestRepo: "/new",
    });
  });

  it("normalizes relative repositories against the current cwd", () => {
    expect(sameRepo("/repo", ".")).toBe(true);
    expect(sameResolvedRepo("/repo/.", "/repo", "/repo")).toBe(true);
    expect(sameRepo("/other", "/repo")).toBe(false);
  });
});

describe("herdr autoscale policy", () => {
  it("keeps environment, mode, and explicit prompt predicates pure", () => {
    expect(isEnvironmentEnabled({ HERDR_ENV: "1" })).toBe(true);
    expect(isEnvironmentEnabled({ HERDR_ENV: "1", PANOPTICON_CHILD: "1" })).toBe(false);
    expect(isEnvironmentEnabled({ HERDR_ENV: "1", HERDR_AUTOSCALE: "0" })).toBe(false);
    expect(isSupportedMode({ mode: "tui" })).toBe(true);
    expect(isSupportedMode({ mode: "rpc" })).toBe(true);
    expect(isSupportedMode({ mode: "print" })).toBe(false);
    expect(isExplicitStartPrompt("please use panopticon")).toBe(true);
    expect(isExplicitStartPrompt("please refactor this")).toBe(false);
    expect(EXPLICIT_ONLY_RULE).toContain("never retry start without a new explicit user request");
  });

  it("guards direct CLI mutations and active parent mutators", () => {
    expect(
      guardToolCall(toolCall("bash", { command: "bin/panopticon start --repo ." }), undefined),
    ).toMatchObject({ block: true });
    expect(
      guardToolCall(toolCall("bash", { command: "panopticon cancel run-1" }), undefined),
    ).toMatchObject({ block: true });
    for (const command of [
      '"panopticon" start --repo .',
      "'/usr/local/bin/panopticon' cancel run-1",
      "./bin/panopticon start --repo .",
    ]) {
      expect(guardToolCall(toolCall("bash", { command }), undefined)).toMatchObject({
        block: true,
      });
    }
    expect(
      guardToolCall(toolCall("bash", { command: "panopticon status --run-id run-1" }), undefined),
    ).toBeUndefined();
    expect(
      guardToolCall(
        toolCall("bash", { command: "'/usr/local/bin/panopticon' wait run-1" }),
        undefined,
      ),
    ).toBeUndefined();

    for (const toolName of ["write", "edit", "bash", "subagent", "ast_grep_replace"]) {
      expect(guardToolCall(toolCall(toolName), "run-1")).toMatchObject({ block: true });
    }
    expect(guardToolCall(toolCall("read"), "run-1")).toBeUndefined();
  });
});
