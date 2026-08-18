/**
 * Show token totals and turn count when a session ends.
 *
 * - /quit, Ctrl+C/D: print after the TUI tears down
 * - /new, /resume, /fork: notify with the previous session's totals
 * - /reload and empty sessions are skipped
 *
 * A turn is one assistant message (one model inference), matching /session.
 */

import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

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
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
};

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
  usage.input += raw.input ?? 0;
  usage.output += raw.output ?? 0;
  usage.cacheRead += raw.cacheRead ?? 0;
  usage.cacheWrite += raw.cacheWrite ?? 0;
  usage.cost += raw.cost?.total ?? 0;
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
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

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (event, ctx) => {
    if (!event.previousSessionFile) return;
    const usage = sessionUsageFromFile(event.previousSessionFile);
    if (usage) showUsage(ctx, usage, "previous session");
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
