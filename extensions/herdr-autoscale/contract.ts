import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { Static } from "typebox";

export const HERDR_AUTOSCALE_TOOL_NAME = "herdr_orchestrate";
export const HERDR_AUTOSCALE_STATE_ENTRY = "herdr-autoscale-state";
export const HERDR_AUTOSCALE_STATUS_KEY = "herdr-autoscale";

export const MAX_OUTPUT_CHARS = 12_000;
export const MAX_FIELD_CHARS = 2_000;
export const MAX_STEP_SUMMARY_CHARS = 1_000;
export const MAX_STEPS = 32;
export const MAX_ERROR_DETAIL_CHARS = 3_000;
export const MIN_INTERVAL_SECONDS = 0.2;
export const MAX_INTERVAL_SECONDS = 30;

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "blocked"]);
const FLOW_STATUSES = new Set([
  "created",
  "running",
  "completed",
  "failed",
  "blocked",
  "cancelled",
  "cancel_requested",
]);

export const ORCHESTRATE_PARAMETERS = Type.Object({
  action: StringEnum(["start", "status", "wait", "cancel"] as const),
  task: Type.Optional(Type.String({ description: "依頼内容。start のとき必須です" })),
  repo: Type.Optional(Type.String({ description: "対象 repository のパス" })),
  workflow: Type.Optional(
    Type.String({
      description:
        "workflow 名または TOML path。省略時は panopticon 既定の standard。`default` は standard として扱う。",
    }),
  ),
  verify: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      description: "検証 argv の shell 文字列。複数指定できます",
    }),
  ),
  run_id: Type.Optional(Type.String({ description: "対象 run ID" })),
  timeout_seconds: Type.Optional(
    Type.Number({ exclusiveMinimum: 0, description: "wait のタイムアウト秒数" }),
  ),
  interval_seconds: Type.Optional(
    Type.Number({
      minimum: MIN_INTERVAL_SECONDS,
      maximum: MAX_INTERVAL_SECONDS,
      description: "wait の state 監視間隔秒数",
    }),
  ),
});

export type OrchestrateParams = Static<typeof ORCHESTRATE_PARAMETERS>;
export type OrchestrateAction = OrchestrateParams["action"];

export type HerdrAutoscaleState = {
  enabled: boolean;
  latestRunId?: string;
  latestRepo?: string;
  activeRunId?: string;
  activeRepo?: string;
};

export type CompactStep = {
  status: string | null;
  summary: string | null;
  error: string | null;
};

export type CompactRunState = {
  run_id: string | null;
  status: string | null;
  current_step: string | null;
  repo: string | null;
  worktree: string | null;
  steps: Record<string, CompactStep>;
  error: string | null;
  updated_at: string | null;
};

export type FlowInvocation = {
  state: CompactRunState;
  text: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
};

export type HerdrOrchestrateDetails = {
  action: OrchestrateAction;
  runId?: string;
  state: CompactRunState;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
};

export type FlowStatus =
  | "created"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled"
  | "cancel_requested";

export const DEFAULT_HERDR_WORKFLOW = "standard";
export const HERDR_WORKFLOW_ALIASES: Record<string, string> = {
  default: DEFAULT_HERDR_WORKFLOW,
};

export function resolveHerdrWorkflow(workflow: string | undefined): string | undefined {
  const trimmed = trimmedString(workflow);
  if (!trimmed) return undefined;
  return HERDR_WORKFLOW_ALIASES[trimmed] ?? trimmed;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(value: unknown, limit = MAX_FIELD_CHARS): string | null {
  if (value === undefined || value === null) return null;
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    text = String(value);
  } else {
    const serialized = JSON.stringify(value);
    text = serialized === undefined ? "[unserializable]" : serialized;
  }
  if (text.length <= limit) return text;
  const suffix = "…[truncated]";
  return `${text.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
}

export function trimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function compactRunState(value: unknown): CompactRunState {
  const record = isRecord(value) ? value : {};
  const rawWorktree = record.worktree;
  const worktree = isRecord(rawWorktree) ? rawWorktree.path : rawWorktree;
  const steps: Record<string, CompactStep> = {};
  const rawSteps = record.steps;

  if (isRecord(rawSteps)) {
    for (const [rawStepId, rawStep] of Object.entries(rawSteps).slice(0, MAX_STEPS)) {
      const step = isRecord(rawStep) ? rawStep : {};
      const result = isRecord(step.result) ? step.result : undefined;
      const stepId = stringValue(rawStepId, 128) ?? "step";
      steps[stepId] = {
        status: stringValue(isRecord(rawStep) ? step.status : rawStep),
        summary: stringValue(result?.summary ?? step.summary, MAX_STEP_SUMMARY_CHARS),
        error: stringValue(step.error, MAX_STEP_SUMMARY_CHARS),
      };
    }
  }

  return {
    run_id: stringValue(record.run_id),
    status: stringValue(record.status),
    current_step: stringValue(record.current_step),
    repo: stringValue(record.repo),
    worktree: stringValue(worktree),
    steps,
    error: stringValue(record.error),
    updated_at: stringValue(record.updated_at),
  };
}

export function compactJson(value: CompactRunState): {
  state: CompactRunState;
  text: string;
  truncated: boolean;
} {
  const initial = JSON.stringify(value);
  if (initial.length <= MAX_OUTPUT_CHARS) {
    return { state: value, text: initial, truncated: false };
  }

  const reduced: CompactRunState = {
    ...value,
    repo: stringValue(value.repo, 256),
    worktree: stringValue(value.worktree, 256),
    error: stringValue(value.error, 512),
    steps: {},
  };
  const reducedText = JSON.stringify(reduced);
  if (reducedText.length <= MAX_OUTPUT_CHARS) {
    return { state: reduced, text: reducedText, truncated: true };
  }

  const minimal: CompactRunState = {
    run_id: stringValue(value.run_id, 256),
    status: stringValue(value.status, 256),
    current_step: stringValue(value.current_step, 256),
    repo: stringValue(value.repo, 256),
    worktree: stringValue(value.worktree, 256),
    steps: {},
    error: stringValue(value.error, 512),
    updated_at: stringValue(value.updated_at, 256),
  };
  return { state: minimal, text: JSON.stringify(minimal), truncated: true };
}

export function isFlowStatus(value: unknown): value is FlowStatus {
  return typeof value === "string" && FLOW_STATUSES.has(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function flowFailureDiagnostic(result: ExecResult, value?: Record<string, unknown>): string | null {
  const error = value?.error;
  const source =
    error !== undefined && error !== null
      ? stringValue(error, MAX_ERROR_DETAIL_CHARS)
      : [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
  return stringValue(source, MAX_ERROR_DETAIL_CHARS);
}

function throwFlowFailure(
  action: OrchestrateAction,
  result: ExecResult,
  reason: string,
  value?: Record<string, unknown>,
): never {
  const diagnostic = flowFailureDiagnostic(result, value);
  throw new Error(
    `panopticon ${action} に失敗しました (exit ${result.code})。${reason}${diagnostic ? ` 出力: ${diagnostic}` : " panopticon が利用できないか、Herdr管理セッション(HERDR_ENV=1)の外で実行されています。"}`,
  );
}

export function validateStateShape(
  action: OrchestrateAction,
  result: ExecResult,
  value: Record<string, unknown>,
): FlowStatus {
  if (typeof value.run_id !== "string" || !value.run_id.trim()) {
    throwFlowFailure(action, result, "run_id は空でない文字列である必要があります。", value);
  }

  if (!isFlowStatus(value.status)) {
    throwFlowFailure(
      action,
      result,
      "status は既知の状態を表す文字列である必要があります。",
      value,
    );
  }

  if (typeof value.repo !== "string" || !value.repo.trim()) {
    throwFlowFailure(
      action,
      result,
      "repository (repo) は空でない文字列である必要があります。",
      value,
    );
  }

  for (const field of ["current_step", "updated_at"] as const) {
    if (field in value && !isNullableString(value[field])) {
      throwFlowFailure(action, result, `${field} は文字列またはnullである必要があります。`, value);
    }
  }

  if ("worktree" in value) {
    const worktree = value.worktree;
    const validWorktree =
      isNullableString(worktree) ||
      (isRecord(worktree) && "path" in worktree && isNullableString(worktree.path));
    if (!validWorktree) {
      throwFlowFailure(
        action,
        result,
        "worktree は文字列、null、またはpathを持つobjectである必要があります。",
        value,
      );
    }
  }

  if ("steps" in value && !isRecord(value.steps)) {
    throwFlowFailure(action, result, "steps はobjectである必要があります。", value);
  }

  if (
    "error" in value &&
    value.error !== null &&
    typeof value.error !== "string" &&
    !isRecord(value.error)
  ) {
    throwFlowFailure(
      action,
      result,
      "error は文字列、null、またはobjectである必要があります。",
      value,
    );
  }

  return value.status;
}

export function hasExpectedExitCode(
  action: OrchestrateAction,
  exitCode: number,
  status: FlowStatus,
): boolean {
  if (action === "start") {
    return exitCode === 0 && ["created", "running", "completed"].includes(status);
  }

  if (action === "wait") {
    if (exitCode === 124) {
      return status === "created" || status === "running" || status === "cancel_requested";
    }
    if (exitCode === 0) return status === "completed";
    if (exitCode === 1) return status === "failed" || status === "cancelled";
    return exitCode === 2 && status === "blocked";
  }

  if (exitCode === 0) return status === "created" || status === "running" || status === "completed";
  if (exitCode === 1) return status === "failed";
  if (exitCode === 2) return status === "blocked" || status === "cancel_requested";
  return exitCode === 3 && status === "cancelled";
}

export function parseJsonOutput(
  action: OrchestrateAction,
  result: ExecResult,
): Record<string, unknown> {
  const output = result.stdout.trim();
  let value: unknown;
  try {
    value = JSON.parse(output) as unknown;
  } catch {
    const diagnostic = stringValue(
      [result.stderr.trim(), output].filter(Boolean).join("\n"),
      MAX_ERROR_DETAIL_CHARS,
    );
    throw new Error(
      `panopticon ${action} の結果をJSONとして読めませんでした。${diagnostic ? ` 出力: ${diagnostic}` : " panopticon がPATHにないか、CLIが利用できません。"}`,
    );
  }

  if (!isRecord(value)) {
    throwFlowFailure(action, result, "結果JSONのトップレベルはobjectである必要があります。");
  }

  const status = validateStateShape(action, result, value);
  if (!hasExpectedExitCode(action, result.code, status)) {
    throwFlowFailure(
      action,
      result,
      `status=${status} に対する終了コード ${result.code} は許容されません。`,
      value,
    );
  }

  return value;
}

export function validateIntervalSeconds(value: unknown): void {
  if (
    value === undefined ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      value >= MIN_INTERVAL_SECONDS &&
      value <= MAX_INTERVAL_SECONDS)
  ) {
    return;
  }
  throw new Error(
    `interval_seconds は${MIN_INTERVAL_SECONDS}以上${MAX_INTERVAL_SECONDS}以下で指定してください。`,
  );
}

export function isActiveStatus(status: string | null): boolean {
  return status === null || !TERMINAL_STATUSES.has(status);
}

export function runIdFromState(state: CompactRunState): string | undefined {
  return trimmedString(state.run_id);
}
