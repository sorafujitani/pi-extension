import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import "./expose-tool.js";
import { createPanopticonBackend } from "./herdr-autoscale/backend.js";
import {
  HERDR_AUTOSCALE_STATE_ENTRY,
  HERDR_AUTOSCALE_STATUS_KEY,
  HERDR_AUTOSCALE_TOOL_NAME,
  MAX_ERROR_DETAIL_CHARS,
  ORCHESTRATE_PARAMETERS,
  isActiveStatus,
  resolveHerdrWorkflow,
  runIdFromState,
  stringValue,
  trimmedString,
  validateIntervalSeconds,
} from "./herdr-autoscale/contract.js";
import type {
  CompactRunState,
  HerdrAutoscaleState,
  HerdrOrchestrateDetails,
  OrchestrateParams,
} from "./herdr-autoscale/contract.js";
import {
  BEFORE_AGENT_GUIDANCE,
  DISABLED_PROMPT_GUIDELINES,
  EXPLICIT_ONLY_RULE,
  EXPLICIT_START_ERROR,
  GUIDANCE_MARKER,
  PROMPT_GUIDELINES,
  guardToolCall,
  isEnvironmentEnabled,
  isExplicitStartPrompt,
  isSupportedMode,
} from "./herdr-autoscale/policy.js";
import {
  hasLatestOwnership,
  hasMatchingActiveOwnership,
  ownsActiveRun,
  resolveRepoPath,
  restoreHerdrAutoscaleState,
  sameRepo,
  sameResolvedRepo,
} from "./herdr-autoscale/session.js";
import type { FlowBackend } from "./herdr-autoscale/backend.js";

export {
  BEFORE_AGENT_GUIDANCE,
  DISABLED_PROMPT_GUIDELINES,
  EXPLICIT_ONLY_RULE,
  PROMPT_GUIDELINES,
} from "./herdr-autoscale/policy.js";
export {
  DEFAULT_HERDR_WORKFLOW,
  HERDR_AUTOSCALE_STATE_ENTRY,
  HERDR_AUTOSCALE_STATUS_KEY,
  HERDR_AUTOSCALE_TOOL_NAME,
  HERDR_WORKFLOW_ALIASES,
  MAX_OUTPUT_CHARS,
  resolveHerdrWorkflow,
} from "./herdr-autoscale/contract.js";
export type {
  CompactRunState,
  HerdrAutoscaleState,
  HerdrOrchestrateDetails,
} from "./herdr-autoscale/contract.js";

export function createHerdrAutoscaleExtension(pi: ExtensionAPI): void {
  if (!isEnvironmentEnabled()) return;

  const backend: FlowBackend = createPanopticonBackend(pi);
  const session: HerdrAutoscaleState & {
    startRequestedByUser: boolean;
    toolRegistered: boolean;
    commandRegistered: boolean;
  } = {
    enabled: true,
    startRequestedByUser: false,
    toolRegistered: false,
    commandRegistered: false,
  };

  function persistState(): void {
    const data: HerdrAutoscaleState = { enabled: session.enabled };
    if (session.latestRunId) data.latestRunId = session.latestRunId;
    if (session.latestRepo) data.latestRepo = session.latestRepo;
    if (session.activeRunId && session.activeRepo) {
      data.activeRunId = session.activeRunId;
      data.activeRepo = session.activeRepo;
    }
    pi.appendEntry<HerdrAutoscaleState>(HERDR_AUTOSCALE_STATE_ENTRY, data);
  }

  function restoreActiveStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(
      HERDR_AUTOSCALE_STATUS_KEY,
      session.activeRunId && session.activeRepo
        ? `Herdr ${session.activeRunId} · active`
        : undefined,
    );
  }

  function updateStatus(ctx: ExtensionContext, state: CompactRunState): void {
    if (!ctx.hasUI) return;
    if (!state.run_id || !isActiveStatus(state.status)) {
      ctx.ui.setStatus(HERDR_AUTOSCALE_STATUS_KEY, undefined);
      return;
    }
    ctx.ui.setStatus(
      HERDR_AUTOSCALE_STATUS_KEY,
      `Herdr ${state.run_id} · ${state.status ?? "active"}`,
    );
  }

  function notify(
    ctx: Pick<ExtensionContext, "ui">,
    message: string,
    type: "info" | "warning" | "error" = "info",
  ): void {
    ctx.ui.notify(`[herdr-auto] ${message}`, type);
  }

  function activeOwnershipMatches(runId: string, repo: string, cwd: string): boolean {
    return ownsActiveRun(session, runId, repo, cwd);
  }

  function clearActiveRunAndPersist(ctx: ExtensionContext, runId: string, repo: string): boolean {
    if (session.activeRunId !== runId || session.activeRepo !== repo) return false;

    const previousActiveRunId = session.activeRunId;
    const previousActiveRepo = session.activeRepo;
    session.activeRunId = undefined;
    session.activeRepo = undefined;
    try {
      persistState();
      return true;
    } catch (error) {
      if (session.activeRunId === undefined && session.activeRepo === undefined) {
        session.activeRunId = previousActiveRunId;
        session.activeRepo = previousActiveRepo;
      }
      restoreActiveStatus(ctx);
      throw error;
    }
  }

  function restoreFromBranch(ctx: ExtensionContext): void {
    const currentActiveRunId = session.activeRunId;
    const currentActiveRepo = session.activeRepo;
    const currentLatestRunId = session.latestRunId;
    const currentLatestRepo = session.latestRepo;
    const restored = restoreHerdrAutoscaleState(ctx.sessionManager.getBranch());

    session.enabled = restored?.enabled ?? true;
    session.latestRunId = restored?.latestRunId;
    session.latestRepo = restored?.latestRepo;

    if (currentActiveRunId && currentActiveRepo) {
      session.activeRunId = currentActiveRunId;
      session.activeRepo = currentActiveRepo;
      if (currentLatestRunId && currentLatestRepo) {
        session.latestRunId = currentLatestRunId;
        session.latestRepo = currentLatestRepo;
      }
    } else if (restored && hasMatchingActiveOwnership(restored, ctx.cwd)) {
      session.activeRunId = restored.activeRunId;
      session.activeRepo = restored.activeRepo;
    } else {
      session.activeRunId = undefined;
      session.activeRepo = undefined;
    }

    restoreActiveStatus(ctx);
    if (session.toolRegistered) registerOrchestrateTool();
  }

  async function reconcileActiveRun(ctx: ExtensionContext): Promise<void> {
    const runId = session.activeRunId;
    const repo = session.activeRepo;
    const expectedLatestRepo = session.latestRepo;
    if (!runId || !repo) return;

    if (!activeOwnershipMatches(runId, repo, ctx.cwd)) {
      restoreActiveStatus(ctx);
      notify(
        ctx,
        `active run ${runId} のsession ownershipを確認できないためguardを維持します。`,
        "warning",
      );
      return;
    }

    try {
      const invocation = await backend.invoke("status", ["status", "--run-id", runId], {
        cwd: ctx.cwd,
      });
      if (runIdFromState(invocation.state) !== runId) {
        throw new Error(
          `panopticon status の結果run_id (${runIdFromState(invocation.state) ?? "none"}) が保存済みactive run (${runId}) と一致しません。`,
        );
      }
      const returnedRepo = trimmedString(invocation.state.repo);
      if (
        !returnedRepo ||
        !expectedLatestRepo ||
        !sameResolvedRepo(returnedRepo, expectedLatestRepo, ctx.cwd)
      ) {
        throw new Error(
          `panopticon status の結果repository (${returnedRepo ?? "none"}) がsessionのlatest repository (${expectedLatestRepo ?? "none"}) と一致しません。`,
        );
      }
      if (!isActiveStatus(invocation.state.status)) {
        if (!clearActiveRunAndPersist(ctx, runId, repo)) return;
      }
      updateStatus(ctx, invocation.state);
    } catch (error) {
      restoreActiveStatus(ctx);
      const message = error instanceof Error ? error.message : String(error);
      notify(
        ctx,
        `active run ${runId} のstatus確認に失敗したためguardを維持します: ${stringValue(message, MAX_ERROR_DETAIL_CHARS) ?? "不明なエラー"}`,
        "warning",
      );
    }
  }

  function resultFor(
    action: OrchestrateParams["action"],
    invocation: Awaited<ReturnType<FlowBackend["invoke"]>>,
    runId?: string,
  ): AgentToolResult<HerdrOrchestrateDetails> {
    return {
      content: [{ type: "text", text: invocation.text }],
      details: {
        action,
        ...(runId ? { runId } : {}),
        state: invocation.state,
        exitCode: invocation.exitCode,
        timedOut: invocation.timedOut,
        truncated: invocation.truncated,
      },
    };
  }

  async function dispatchOrchestrate(
    params: OrchestrateParams,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<HerdrOrchestrateDetails>> {
    if (!isEnvironmentEnabled() || !isSupportedMode(ctx)) {
      throw new Error(
        "herdr_orchestrate はHERDR_ENV=1の親TUI/RPCセッションでのみ利用できます。Herdr外では通常の作業へフォールバックしてください。",
      );
    }

    validateIntervalSeconds(params.interval_seconds);

    if (params.action === "start") {
      if (!session.enabled) {
        throw new Error(
          "herdr autoscale はoffです。ユーザーが /herdr-auto on を実行するまで start はできません。start を再試行せず通常の作業を続けてください。",
        );
      }
      if (!session.startRequestedByUser) throw new Error(EXPLICIT_START_ERROR);
      if (session.activeRunId) {
        throw new Error(
          `Herdr run ${session.activeRunId} がactiveです。別のstartは実行できません。先に herdr_orchestrate wait または cancel を実行してください。`,
        );
      }
      const task = trimmedString(params.task);
      if (!task) throw new Error("herdr_orchestrate start にはtaskが必要です。");

      const args = ["start", "--task", task];
      const repo = trimmedString(params.repo);
      const workflow = resolveHerdrWorkflow(params.workflow);
      if (repo) args.push("--repo", repo);
      if (workflow) args.push("--workflow", workflow);
      const verify = Array.isArray(params.verify)
        ? params.verify.map(trimmedString).filter((value): value is string => Boolean(value))
        : [];
      for (const command of verify) args.push("--verify", command);

      // A prompt authorizes at most one attempt, including a failed CLI call or mismatch.
      session.startRequestedByUser = false;
      const invocation = await backend.invoke("start", args, {
        cwd: ctx.cwd,
        signal,
      });
      const runId = runIdFromState(invocation.state);
      if (!runId) {
        throw new Error(
          "panopticon start のcompact結果にrun_idがありません。CLIの結果を確認し、同じstartを繰り返さず通常作業へフォールバックしてください。",
        );
      }
      const expectedRepo = resolveRepoPath(repo, ctx.cwd);
      const returnedRepo = trimmedString(invocation.state.repo);
      if (!returnedRepo || !sameResolvedRepo(returnedRepo, expectedRepo, ctx.cwd)) {
        throw new Error(
          `panopticon start の結果repository (${returnedRepo ?? "none"}) が要求したrepository (${expectedRepo}) と一致しません。`,
        );
      }

      session.latestRunId = runId;
      session.latestRepo = expectedRepo;
      if (isActiveStatus(invocation.state.status)) {
        session.activeRunId = runId;
        session.activeRepo = expectedRepo;
      } else {
        session.activeRunId = undefined;
        session.activeRepo = undefined;
      }
      persistState();
      updateStatus(ctx, invocation.state);
      return resultFor(params.action, invocation, runId);
    }

    if (!hasLatestOwnership(session)) {
      throw new Error(
        `${params.action}対象runのsession custom entryに完全なownership pair (latestRunId/latestRepo)がありません。panopticonは実行していません。`,
      );
    }
    const ownedLatestRunId = session.latestRunId;
    const ownedLatestRepo = session.latestRepo;
    const explicitRunId = trimmedString(params.run_id);
    let selectedRunId: string;
    if (explicitRunId) {
      if (explicitRunId !== ownedLatestRunId) {
        throw new Error(
          `指定されたrun_id (${explicitRunId}) はこのsessionが所有するlatestRunId (${ownedLatestRunId}) と一致しません。panopticonは実行していません。`,
        );
      }
      selectedRunId = explicitRunId;
    } else {
      const savedRunId = session.activeRunId ?? ownedLatestRunId;
      const savedRepo = session.activeRunId ? session.activeRepo : ownedLatestRepo;
      if (!savedRunId) {
        throw new Error(
          `${params.action}対象のrunがsession custom entryにありません。run_idを明示してください。`,
        );
      }
      if (!savedRepo) {
        throw new Error(
          `${params.action}対象runのrepositoryがsession custom entryにありません。run_idとrepoを明示してください。`,
        );
      }
      if (session.activeRunId && !activeOwnershipMatches(session.activeRunId, savedRepo, ctx.cwd)) {
        throw new Error(
          `sessionのactive run (${session.activeRunId}) とlatest runのownershipが一致しません。明示run_idを指定してください。`,
        );
      }
      if (!sameRepo(ctx.cwd, savedRepo)) {
        throw new Error(
          `sessionのcwd (${resolveRepoPath(undefined, ctx.cwd)}) と保存済みrepository (${savedRepo}) が一致しません。run_idを明示してください。`,
        );
      }
      selectedRunId = savedRunId;
    }

    const args: string[] = [params.action];
    if (params.action === "cancel") args.push(selectedRunId);
    else args.push("--run-id", selectedRunId);
    if (params.action === "wait") {
      if (params.timeout_seconds !== undefined) {
        args.push("--timeout-seconds", String(params.timeout_seconds));
      }
      if (params.interval_seconds !== undefined) {
        args.push("--interval-seconds", String(params.interval_seconds));
      }
    }

    const invocation = await backend.invoke(params.action, args, {
      cwd: ctx.cwd,
      signal,
    });
    const runId = runIdFromState(invocation.state);
    if (runId !== selectedRunId) {
      throw new Error(
        `panopticon ${params.action} の結果run_id (${runId ?? "none"}) が要求したrun_id (${selectedRunId}) と一致しません。`,
      );
    }
    const returnedRepo = trimmedString(invocation.state.repo);
    if (!returnedRepo || !sameResolvedRepo(returnedRepo, ownedLatestRepo, ctx.cwd)) {
      throw new Error(
        `panopticon ${params.action} の結果repository (${returnedRepo ?? "none"}) がsessionのlatest repository (${ownedLatestRepo}) と一致しません。`,
      );
    }
    if (!explicitRunId && !sameRepo(ctx.cwd, returnedRepo)) {
      throw new Error(
        `panopticon ${params.action} の結果repository (${returnedRepo}) がsessionのcwdと一致しません。`,
      );
    }

    let activeCleared = false;
    if (
      runId &&
      session.activeRunId &&
      session.activeRepo &&
      runId === session.activeRunId &&
      activeOwnershipMatches(session.activeRunId, session.activeRepo, ctx.cwd) &&
      !isActiveStatus(invocation.state.status)
    ) {
      activeCleared = clearActiveRunAndPersist(ctx, runId, session.activeRepo);
    }
    if (!activeCleared) persistState();
    updateStatus(ctx, invocation.state);
    return resultFor(params.action, invocation, runId);
  }

  function registerOrchestrateTool(): void {
    pi.registerTool({
      name: HERDR_AUTOSCALE_TOOL_NAME,
      exposure: "model-only",
      label: "Herdr Orchestrate",
      description: `Start, inspect, wait for, or cancel a panopticon run without editing the repository in the parent session. ${EXPLICIT_ONLY_RULE}`,
      promptSnippet:
        "Observe or control a Herdr run (status/wait/cancel); start only on an explicit user request",
      promptGuidelines: session.enabled ? PROMPT_GUIDELINES : DISABLED_PROMPT_GUIDELINES,
      executionMode: "sequential",
      parameters: ORCHESTRATE_PARAMETERS,
      execute: async (
        _toolCallId,
        params,
        signal,
        _onUpdate,
        ctx,
      ): Promise<AgentToolResult<HerdrOrchestrateDetails>> =>
        dispatchOrchestrate(params, signal, ctx),
    });
    session.toolRegistered = true;
  }

  function registerCommand(): void {
    if (session.commandRegistered) return;
    pi.registerCommand("herdr-auto", {
      description: "Herdr autoscale の状態表示とセッション単位の on/off",
      handler: async (args, ctx) => {
        if (!isSupportedMode(ctx)) {
          notify(ctx, "TUI/RPCセッションでのみ利用できます", "warning");
          return;
        }
        const action = trimmedString(args) ?? "status";
        if (action === "status") {
          notify(
            ctx,
            `autoscale=${session.enabled ? "on" : "off"}; latest run=${session.latestRunId ?? "none"}`,
          );
          return;
        }
        if (action === "on" || action === "off") {
          session.enabled = action === "on";
          persistState();
          if (session.toolRegistered) registerOrchestrateTool();
          notify(ctx, `autoscale ${session.enabled ? "on" : "off"}`);
          return;
        }
        notify(ctx, "usage: /herdr-auto status | on | off", "warning");
      },
    });
    session.commandRegistered = true;
  }

  pi.on("tool_call", (event, ctx) => {
    if (!isSupportedMode(ctx)) return;
    return guardToolCall(event, session.activeRunId);
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!isSupportedMode(ctx)) return;
    restoreFromBranch(ctx);
    registerCommand();
    registerOrchestrateTool();
    await reconcileActiveRun(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    if (!isSupportedMode(ctx)) return;
    restoreFromBranch(ctx);
    await reconcileActiveRun(ctx);
  });

  pi.on("before_agent_start", (event, ctx) => {
    session.startRequestedByUser = isExplicitStartPrompt(event.prompt);
    if (
      !session.toolRegistered ||
      !session.enabled ||
      !isSupportedMode(ctx) ||
      !isEnvironmentEnabled()
    ) {
      return;
    }
    if (event.systemPrompt.includes(GUIDANCE_MARKER)) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${BEFORE_AGENT_GUIDANCE}` };
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus(HERDR_AUTOSCALE_STATUS_KEY, undefined);
  });
}

export function isHerdrAutoscaleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnvironmentEnabled(env);
}

export default createHerdrAutoscaleExtension;
