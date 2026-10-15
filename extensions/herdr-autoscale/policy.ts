import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

export const GUIDANCE_MARKER = "<!-- herdr-autoscale-guidance -->";
const EXPLICIT_START_PATTERN = /panopticon|herdr/i;
const DIRECT_PANOPTICON_MUTATION_PATTERN =
  /(?:^|[\s;&|])(?:"(?:[^"]*\/)?panopticon"|'(?:[^']*\/)?panopticon'|(?:[^\s"';&|]*\/)?panopticon)\s+(?:start|cancel)\b/;
const MUTATOR_TOOL_NAMES = new Set(["write", "edit", "bash", "subagent", "ast_grep_replace"]);

export const EXPLICIT_ONLY_RULE =
  "herdr_orchestrate start is explicit-only: call it solely when the user's current request explicitly names panopticon or herdr (for example via the panopticon agent skill). Never start a run on your own judgment, however non-trivial the task looks, and never retry start without a new explicit user request.";

export const PROMPT_GUIDELINES = [
  EXPLICIT_ONLY_RULE,
  "After herdr_orchestrate start succeeds, do not edit the same repository in the parent session; use herdr_orchestrate wait and report the workflow result.",
  "Use herdr_orchestrate status, wait, or cancel to observe or control an existing run. If start fails, report it and continue normally.",
  "Omit workflow unless the repo has its own. The global workflow is `standard`. Never pass `default`.",
];

export const DISABLED_PROMPT_GUIDELINES = [
  "herdr autoscale is off in this session; herdr_orchestrate start is unavailable until the user runs /herdr-auto on. Use herdr_orchestrate status, wait, or cancel only.",
];

export const BEFORE_AGENT_GUIDANCE = `${GUIDANCE_MARKER}
${EXPLICIT_ONLY_RULE} After a successful start, the parent must not edit that repository; use wait and report the run's result. Use status, wait, or cancel to control an existing run.`;

export const EXPLICIT_START_ERROR =
  "herdr_orchestrate start は explicit-only です。現在のユーザー依頼が panopticon / herdr を名指ししていないため start できません。ユーザーの明示依頼（panopticon agent skill など）を受けてから実行し、依頼なしに再試行しないでください。";

export function isEnvironmentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HERDR_AUTOSCALE !== "0" && env.HERDR_ENV === "1" && env.PANOPTICON_CHILD !== "1";
}

export function isSupportedMode(ctx: Pick<ExtensionContext, "mode">): boolean {
  return ctx.mode === "tui" || ctx.mode === "rpc";
}

export function isExplicitStartPrompt(prompt: unknown): boolean {
  return typeof prompt === "string" && EXPLICIT_START_PATTERN.test(prompt);
}

export type ToolCallGuardResult = {
  block: true;
  reason: string;
};

export function isDirectPanopticonMutationCommand(command: unknown): boolean {
  return typeof command === "string" && DIRECT_PANOPTICON_MUTATION_PATTERN.test(command);
}

export function guardToolCall(
  event: ToolCallEvent,
  activeRunId: string | undefined,
): ToolCallGuardResult | undefined {
  if (
    isToolCallEventType("bash", event) &&
    isDirectPanopticonMutationCommand(event.input.command)
  ) {
    return {
      block: true,
      reason:
        "この親セッションでは panopticon の start / cancel を CLI で直接実行できません。run ownership 追跡と編集 guard を維持するため、herdr_orchestrate tool を使ってください。",
    };
  }

  if (!activeRunId || !MUTATOR_TOOL_NAMES.has(event.toolName)) return undefined;
  return {
    block: true,
    reason: `Herdr run ${activeRunId} がactiveです。親セッションの ${event.toolName} を実行できません。先に herdr_orchestrate wait（または cancel）でrunを制御してください。`,
  };
}
