/**
 * Show session usage summaries and the rolling token metrics that matter for
 * provider limits.
 *
 * - /usage toggles a live TUI report with the active-branch 60-second window
 * - /quit, Ctrl+C/D: print after the TUI tears down
 * - /new, /resume, /fork: notify with the previous session's totals
 * - /reload and empty sessions are skipped
 *
 * A turn is one assistant message (one model inference), matching /session.
 */

import { readFileSync } from "node:fs";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

export const RATE_WINDOW_MS = 60_000;
const USAGE_WIDGET_KEY = "pi-extension-usage-metrics";

export type SessionUsage = {
  turns: number;
  userMessages: number;
  toolCalls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
};

type UsageLike = {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
};

export type UsageSampleKind = "assistant" | "tool" | "summary";

/** One provider request recorded in the session history. */
export type UsageSample = {
  timestamp: number;
  kind: UsageSampleKind;
  provider?: string;
  model?: string;
  promptTokens: number;
  uncachedInput: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  total: number;
  cost: number;
};

/** Aggregated usage for a session or a rolling time window. */
export type UsageMetrics = {
  requests: number;
  promptTokens: number;
  uncachedInput: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  total: number;
  cost: number;
  maxPromptTokens: number;
  maxOutput: number;
  maxReasoning: number;
};

/** Provider responses observed during the current Pi process/session. */
export type ProviderHealth = {
  responses: number;
  rateLimited: number;
  serverErrors: number;
  lastStatus?: number;
  lastRetryAfter?: string;
  remainingTokens?: string;
  resetTokens?: string;
};

type ContextSnapshot = {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
};

function emptyUsageMetrics(): UsageMetrics {
  return {
    requests: 0,
    promptTokens: 0,
    uncachedInput: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    total: 0,
    cost: 0,
    maxPromptTokens: 0,
    maxOutput: 0,
    maxReasoning: 0,
  };
}

function numberValue(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function timestampValue(value: number | string | undefined): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

type UsageSampleOptions = {
  raw: UsageLike | undefined;
  timestamp: number;
  kind: UsageSampleKind;
  provider?: string;
  model?: string;
};

function sampleFromUsage({
  raw,
  timestamp,
  kind,
  provider,
  model,
}: UsageSampleOptions): UsageSample | undefined {
  if (!raw) return undefined;

  const input = numberValue(raw.input);
  const output = numberValue(raw.output);
  const reasoning = numberValue(raw.reasoning);
  const cacheRead = numberValue(raw.cacheRead);
  const cacheWrite = numberValue(raw.cacheWrite);
  const promptTokens = input + cacheRead + cacheWrite;

  return {
    timestamp,
    kind,
    provider,
    model,
    promptTokens,
    uncachedInput: input + cacheWrite,
    cacheRead,
    cacheWrite,
    output,
    reasoning,
    total: promptTokens + output,
    cost: numberValue(raw.cost?.total),
  };
}

/** Extract individual provider-usage records from session entries. */
export function collectUsageSamples(entries: readonly SessionEntry[]): UsageSample[] {
  const samples: UsageSample[] = [];

  for (const entry of entries) {
    if (entry.type === "message") {
      const message = entry.message;
      let sample: UsageSample | undefined;

      if (message.role === "assistant") {
        sample = sampleFromUsage({
          raw: message.usage,
          timestamp: timestampValue(message.timestamp),
          kind: "assistant",
          provider: message.provider,
          model: message.responseModel ?? message.model,
        });
      } else if (message.role === "toolResult") {
        sample = sampleFromUsage({
          raw: message.usage,
          timestamp: timestampValue(message.timestamp),
          kind: "tool",
        });
      }

      if (sample) samples.push(sample);
      continue;
    }

    if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
      const sample = sampleFromUsage({
        raw: entry.usage,
        timestamp: timestampValue(entry.timestamp),
        kind: "summary",
      });
      if (sample) samples.push(sample);
    }
  }

  return samples;
}

function addSample(metrics: UsageMetrics, sample: UsageSample): void {
  metrics.requests += 1;
  metrics.promptTokens += sample.promptTokens;
  metrics.uncachedInput += sample.uncachedInput;
  metrics.cacheRead += sample.cacheRead;
  metrics.cacheWrite += sample.cacheWrite;
  metrics.output += sample.output;
  metrics.reasoning += sample.reasoning;
  metrics.total += sample.total;
  metrics.cost += sample.cost;
  metrics.maxPromptTokens = Math.max(metrics.maxPromptTokens, sample.promptTokens);
  metrics.maxOutput = Math.max(metrics.maxOutput, sample.output);
  metrics.maxReasoning = Math.max(metrics.maxReasoning, sample.reasoning);
}

/** Aggregate already-extracted usage records. */
export function summarizeUsageSamples(samples: readonly UsageSample[]): UsageMetrics {
  const metrics = emptyUsageMetrics();
  for (const sample of samples) addSample(metrics, sample);
  return metrics;
}

/** Aggregate all usage records in a session, including summary requests. */
export function collectUsageMetrics(entries: readonly SessionEntry[]): UsageMetrics {
  return summarizeUsageSamples(collectUsageSamples(entries));
}

/** Aggregate usage from the active branch during the rolling rate-limit window. */
export function collectRecentUsage(
  entries: readonly SessionEntry[],
  now = Date.now(),
  windowMs = RATE_WINDOW_MS,
): UsageMetrics {
  const cutoff = now - windowMs;
  const samples = collectUsageSamples(entries).filter(
    (sample) => sample.timestamp >= cutoff && sample.timestamp <= now,
  );
  return summarizeUsageSamples(samples);
}

/** Return the newest usage record on a branch. */
export function getLatestUsageSample(entries: readonly SessionEntry[]): UsageSample | undefined {
  return collectUsageSamples(entries).reduce<UsageSample | undefined>(
    (latest, sample) => (!latest || sample.timestamp >= latest.timestamp ? sample : latest),
    undefined,
  );
}

export function getCacheHitRate(
  metrics: Pick<UsageMetrics, "promptTokens" | "cacheRead">,
): number | undefined {
  if (metrics.promptTokens <= 0) return undefined;
  return (metrics.cacheRead / metrics.promptTokens) * 100;
}

export function collectSessionUsage(entries: readonly SessionEntry[]): SessionUsage {
  const usage: SessionUsage = {
    turns: 0,
    userMessages: 0,
    toolCalls: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    cost: 0,
  };

  for (const entry of entries) {
    if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
      addUsage(usage, entry.usage);
    }
    if (entry.type !== "message") continue;

    const message = entry.message;
    if (message.role === "user") {
      usage.userMessages += 1;
      continue;
    }
    if (message.role === "toolResult") {
      if (message.usage) addUsage(usage, message.usage);
      continue;
    }
    if (message.role !== "assistant") continue;

    usage.turns += 1;
    if (Array.isArray(message.content)) {
      usage.toolCalls += message.content.filter((block) => block.type === "toolCall").length;
    }
    addUsage(usage, message.usage);
  }

  usage.total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return usage;
}

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function formatCount(count: number): string {
  return count.toLocaleString();
}

function formatRate(rate: number | undefined): string {
  return rate === undefined ? "—" : `${rate.toFixed(1)}%`;
}

function sessionPromptTokens(usage: SessionUsage): number {
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

function sessionCacheRate(usage: SessionUsage): number | undefined {
  const promptTokens = sessionPromptTokens(usage);
  if (promptTokens <= 0) return undefined;
  return (usage.cacheRead / promptTokens) * 100;
}

/** Compact rolling-window label for the always-visible input panel. */
export function formatUsageWindowCompact(metrics: UsageMetrics, label = "1m"): string {
  if (metrics.requests === 0) return `${label} —`;
  return `${label} ${metrics.requests}r in${formatTokens(metrics.promptTokens)}/u${formatTokens(metrics.uncachedInput)} out${formatTokens(metrics.output)}`;
}

/** Full header label: rolling rate metrics plus long-term cache/session context. */
export function formatUsageHeader(session: SessionUsage, recent: UsageMetrics): string {
  const cache = sessionCacheRate(session);
  return `${formatUsageWindowCompact(recent)} · cache${formatRate(cache)} · session${formatTokens(session.total)}`;
}

/** Narrow-terminal header label. */
export function formatUsageHeaderCompact(session: SessionUsage, recent: UsageMetrics): string {
  const cache = sessionCacheRate(session);
  return `${formatUsageWindowCompact(recent)} · c${formatRate(cache)} · s${formatTokens(session.total)}`;
}

export function formatSessionUsage(usage: SessionUsage, label = "session"): string {
  const parts = [
    label,
    `${usage.turns} turn${usage.turns === 1 ? "" : "s"}`,
    `${usage.userMessages} user`,
    `${formatTokens(usage.total)} tok`,
  ];

  const tokenParts = [];
  if (usage.input) tokenParts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) tokenParts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) tokenParts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) tokenParts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (tokenParts.length > 0) parts.push(tokenParts.join(" "));
  if (usage.cost > 0) parts.push(`$${usage.cost.toFixed(3)}`);
  if (usage.toolCalls > 0) parts.push(`${usage.toolCalls} tools`);

  return parts.join("  ");
}

/** The session total used by the always-visible metadata line. */
export function formatSessionUsageTotal(usage: SessionUsage): string {
  const turnLabel = `${usage.turns} turn${usage.turns === 1 ? "" : "s"}`;
  return `session ${formatTokens(usage.total)} tok · ${turnLabel}`;
}

/** Compact form for persistent UI such as the input-panel metadata line. */
export function formatSessionUsageCompact(usage: SessionUsage): string {
  const parts = [formatSessionUsageTotal(usage)];
  const tokenParts = [];
  if (usage.input) tokenParts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) tokenParts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) tokenParts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) tokenParts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (tokenParts.length > 0) parts.push(tokenParts.join(" "));
  if (usage.cost > 0) parts.push(`$${usage.cost.toFixed(3)}`);
  return parts.join(" ");
}

export function hasSessionUsage(usage: SessionUsage): boolean {
  return usage.turns > 0 || usage.total > 0 || usage.userMessages > 0;
}

export function sessionUsageFromFile(path: string): SessionUsage | undefined {
  try {
    return collectSessionUsage(readSessionEntries(path));
  } catch {
    return undefined;
  }
}

function readSessionEntries(path: string): SessionEntry[] {
  const entries: SessionEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { type?: string };
      if (entry.type && entry.type !== "session") entries.push(entry as SessionEntry);
    } catch {
      // Ignore an incomplete or malformed trailing line.
    }
  }
  return entries;
}

function addUsage(usage: SessionUsage, raw: UsageLike | undefined): void {
  if (!raw) return;
  usage.input += numberValue(raw.input);
  usage.output += numberValue(raw.output);
  usage.cacheRead += numberValue(raw.cacheRead);
  usage.cacheWrite += numberValue(raw.cacheWrite);
  usage.cost += numberValue(raw.cost?.total);
}

function formatMetricsLines(metrics: UsageMetrics): string[] {
  const output = `  Output: ${formatCount(metrics.output)}${metrics.reasoning ? ` (reasoning ${formatCount(metrics.reasoning)})` : ""}`;
  return [
    `  Requests: ${formatCount(metrics.requests)}`,
    `  Prompt: ${formatCount(metrics.promptTokens)}`,
    `  Uncached input: ${formatCount(metrics.uncachedInput)}`,
    `  Cached read: ${formatCount(metrics.cacheRead)} (${formatRate(getCacheHitRate(metrics))})`,
    output,
    `  Max request: ${formatCount(metrics.maxPromptTokens)} prompt / ${formatCount(metrics.maxOutput)} output${metrics.maxReasoning ? ` / ${formatCount(metrics.maxReasoning)} reasoning` : ""}`,
    `  Total: ${formatCount(metrics.total)}`,
  ];
}

export type UsageReportOptions = {
  session: SessionUsage;
  sessionMetrics: UsageMetrics;
  recent: UsageMetrics;
  latest?: UsageSample;
  context?: ContextSnapshot;
  health?: ProviderHealth;
  model?: string;
};

function formatLatestRequestLine(sample: UsageSample | undefined): string | undefined {
  if (!sample) return undefined;
  const model = sample.provider ? `${sample.provider}/${sample.model ?? "?"}` : sample.kind;
  return `Latest request (${model}): prompt ${formatCount(sample.promptTokens)} / uncached ${formatCount(sample.uncachedInput)} / output ${formatCount(sample.output)}`;
}

function formatContextLine(context: ContextSnapshot | undefined): string | undefined {
  if (!context) return undefined;
  const percent = context.percent === null ? "?" : `${context.percent.toFixed(1)}%`;
  const tokens = context.tokens === null ? "" : ` (${formatCount(context.tokens)} tokens)`;
  return `Context: ${percent}/${formatTokens(context.contextWindow)}${tokens}`;
}

function formatProviderHealthLine(health: ProviderHealth | undefined): string | undefined {
  if (!health || health.responses <= 0) return undefined;
  const headers = [
    health.remainingTokens ? `remaining tokens ${health.remainingTokens}` : undefined,
    health.resetTokens ? `reset ${health.resetTokens}` : undefined,
    health.lastRetryAfter ? `retry-after ${health.lastRetryAfter}` : undefined,
  ].filter((value): value is string => Boolean(value));
  const lastStatus = health.lastStatus === undefined ? "" : ` · last ${health.lastStatus}`;
  const headerText = headers.length ? ` · ${headers.join(" · ")}` : "";
  return `Provider responses (current session): ${formatCount(health.responses)} · 429 ${formatCount(health.rateLimited)} · 5xx ${formatCount(health.serverErrors)}${lastStatus}${headerText}`;
}

/** Human-readable report for /usage. */
export function formatUsageReport(options: UsageReportOptions): string {
  const lines = ["LLM usage metrics"];
  if (options.model) lines.push(`Model: ${options.model}`);

  lines.push("Last 60s (active branch):", ...formatMetricsLines(options.recent));
  lines.push("Session total (all entries):", ...formatMetricsLines(options.sessionMetrics));
  lines.push(
    `  Turns: ${formatCount(options.session.turns)} · User messages: ${formatCount(options.session.userMessages)} · Cost: $${options.session.cost.toFixed(3)}`,
  );

  const latestLine = formatLatestRequestLine(options.latest);
  if (latestLine) lines.push(latestLine);

  const contextLine = formatContextLine(options.context);
  if (contextLine) lines.push(contextLine);

  const healthLine = formatProviderHealthLine(options.health);
  if (healthLine) lines.push(healthLine);

  return lines.join("\n");
}

function reportForContext(ctx: ExtensionContext, health?: ProviderHealth): string {
  const allEntries = ctx.sessionManager.getEntries();
  const activeEntries = ctx.sessionManager.getBranch();
  const context = ctx.getContextUsage();
  const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

  return formatUsageReport({
    session: collectSessionUsage(allEntries),
    sessionMetrics: collectUsageMetrics(allEntries),
    recent: collectRecentUsage(activeEntries),
    latest: getLatestUsageSample(activeEntries),
    health,
    context: context
      ? {
          tokens: context.tokens,
          contextWindow: context.contextWindow,
          percent: context.percent,
        }
      : undefined,
    model,
  });
}

function setUsageWidget(ctx: ExtensionContext, visible: boolean, health: ProviderHealth): void {
  if (ctx.mode !== "tui") return;
  if (!visible) {
    ctx.ui.setWidget(USAGE_WIDGET_KEY, undefined);
    return;
  }

  ctx.ui.setWidget(
    USAGE_WIDGET_KEY,
    (_tui, theme) => ({
      render(width: number): string[] {
        return reportForContext(ctx, health)
          .split("\n")
          .map((line, index) => {
            const styled = theme.fg(index === 0 ? "accent" : "dim", line);
            return truncateToWidth(styled, width, theme.fg("dim", "..."));
          });
      },
      invalidate() {},
    }),
    { placement: "aboveEditor" },
  );
}

function showUsage(ctx: ExtensionContext, usage: SessionUsage, label: string): void {
  if (!hasSessionUsage(usage)) return;
  const line = formatSessionUsage(usage, label);

  if (ctx.hasUI) {
    ctx.ui.notify(line, "info");
    return;
  }

  if (ctx.mode === "json" || ctx.mode === "rpc") return;
  const stream = ctx.mode === "print" ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

function getHeaderValue(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === target);
  return entry?.[1];
}

function emptyProviderHealth(): ProviderHealth {
  return { responses: 0, rateLimited: 0, serverErrors: 0 };
}

type ProviderResponseEvent = {
  status: number;
  headers: Record<string, string>;
};

function recordProviderResponse(health: ProviderHealth, event: ProviderResponseEvent): void {
  health.responses += 1;
  health.lastStatus = event.status;
  if (event.status === 429) health.rateLimited += 1;
  if (event.status >= 500) health.serverErrors += 1;

  const retryAfter =
    getHeaderValue(event.headers, "retry-after-ms") ?? getHeaderValue(event.headers, "retry-after");
  if (retryAfter !== undefined) health.lastRetryAfter = retryAfter;

  const remainingTokens = getHeaderValue(event.headers, "x-ratelimit-remaining-tokens");
  if (remainingTokens !== undefined) health.remainingTokens = remainingTokens;

  const resetTokens = getHeaderValue(event.headers, "x-ratelimit-reset-tokens");
  if (resetTokens !== undefined) health.resetTokens = resetTokens;
}

export default function (pi: ExtensionAPI) {
  let usageWidgetVisible = false;
  let providerHealth = emptyProviderHealth();

  pi.on("after_provider_response", (event) => recordProviderResponse(providerHealth, event));

  pi.on("session_start", (event, ctx) => {
    providerHealth = emptyProviderHealth();
    if (event.previousSessionFile) {
      const usage = sessionUsageFromFile(event.previousSessionFile);
      if (usage) showUsage(ctx, usage, "previous session");
    }
    setUsageWidget(ctx, usageWidgetVisible, providerHealth);
  });

  pi.registerCommand("usage", {
    description: "直近1分とセッション全体のLLM使用量を表示",
    handler: (_args, ctx) => {
      usageWidgetVisible = !usageWidgetVisible;
      if (ctx.mode === "tui") {
        setUsageWidget(ctx, usageWidgetVisible, providerHealth);
        return Promise.resolve();
      }
      ctx.ui.notify(reportForContext(ctx, providerHealth), "info");
      return Promise.resolve();
    },
  });

  pi.on("session_shutdown", (event, ctx) => {
    if (event.reason !== "quit") return;
    const usage = collectSessionUsage(ctx.sessionManager.getEntries());
    if (!hasSessionUsage(usage)) return;

    const line = formatSessionUsage(usage, "session");
    if (ctx.mode === "json" || ctx.mode === "rpc") return;
    const stream = ctx.mode === "print" ? process.stderr : process.stdout;
    stream.write(`${line}\n`);
  });
}
