import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const nodeRequire = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

// Absolute fallback for hosts that do not report a context window.
export const DEFAULT_CONTEXT_TOKEN_LIMIT = 100_000;
export const DEFAULT_CONTEXT_WINDOW_RATIO = 0.6;
export const DEFAULT_CONTEXT_WARNING_RATIO = 0.4;
export const DEFAULT_COMPACTION_LIMIT = 2;
export const DEFAULT_BRAIN_MODE = "full";
export const DEFAULT_PROMPT_VERSION = "default";
export const EXTENSION_HASH = createHash("sha256")
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .digest("hex")
  .slice(0, 12);
export const DEFAULT_HANDOFF_RESUME_PATH = join(
  homedir(),
  ".atlantis",
  "atlantis-handoff-resume.md",
);
export function metricsPath(env = process.env, home = homedir()) {
  return join(
    env.XDG_STATE_HOME || join(home, ".local", "state"),
    "atlantis",
    "pi-interactions.sqlite",
  );
}
export const DEFAULT_METRICS_PATH = metricsPath();
export function reportPath(env = process.env, home = homedir()) {
  return join(dirname(metricsPath(env, home)), "atl-metrics.html");
}
export const DEFAULT_REPORT_PATH = reportPath();

async function runAtlantis(args) {
  const result = await execFileAsync("atlantis", args, {
    encoding: "utf8",
    shell: false,
    timeout: 10_000,
  });
  return result.stdout;
}
function byteLength(value) {
  if (value === undefined || value === null) return 0;
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return Buffer.byteLength(text ?? "", "utf8");
  } catch {
    return 0;
  }
}

function numeric(value) {
  return Number.isFinite(value) ? value : 0;
}

function usageFromMessage(message, toolResults = []) {
  const total = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    cost: 0,
  };
  const add = (usage) => {
    if (!usage || typeof usage !== "object") return;
    total.input += numeric(usage.input);
    total.output += numeric(usage.output);
    total.cacheRead += numeric(usage.cacheRead);
    total.cacheWrite += numeric(usage.cacheWrite);
    total.reasoning += numeric(usage.reasoning);
    total.cost += numeric(usage.cost?.total);
  };
  add(message?.usage);
  for (const result of toolResults) add(result?.usage);
  return total;
}

function assistantToolCalls(message) {
  return Array.isArray(message?.content)
    ? message.content.filter((block) => block?.type === "toolCall").length
    : 0;
}

const OUTCOME_CHOICES = ["成功・テスト通過", "成功・未検証", "手戻り", "失敗", "記録しない"];

const OUTCOME_BY_CHOICE = {
  "成功・テスト通過": {
    outcome: "success",
    testStatus: "passed",
    humanCorrections: 0,
  },
  "成功・未検証": {
    outcome: "success",
    testStatus: "unknown",
    humanCorrections: 0,
  },
  手戻り: {
    outcome: "rework",
    testStatus: "unknown",
    humanCorrections: 1,
  },
  失敗: {
    outcome: "failed",
    testStatus: "unknown",
    humanCorrections: 0,
  },
};

const MEANINGFUL_TOOL_NAMES = new Set([
  "edit",
  "write",
  "ast_grep_replace",
  "lsp_diagnostics",
  "lens_diagnostics",
  "image_gen",
]);

function isMeaningfulTool(toolName, args) {
  const name = String(toolName ?? "").toLowerCase();
  if (MEANINGFUL_TOOL_NAMES.has(name)) return true;
  if (/(?:^|_)(?:edit|write|replace|patch|test|lint|build|deploy)(?:_|$)/.test(name)) return true;
  if (name !== "bash") return false;
  const command = String(args?.command ?? "");
  return /(?:^|[;&|]\s*|\s)(?:go\s+(?:test|vet|build|install)|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|check|build|format)|node\s+--test|pytest|cargo\s+(?:test|check|build|clippy|fmt)|make(?:\s+[^;&|]+)?|git\s+(?:add|commit|merge|rebase|cherry-pick)|(?:rm|mv|cp|mkdir|chmod)\s)/i.test(
    command,
  );
}

const TASK_RULES = [
  [
    "debugging",
    /\b(debug|bug|fix|failure|failing|error|crash|regression)\b|デバッグ|不具合|原因|失敗|エラー/i,
  ],
  ["review", /\b(review|critique|audit|assess)\b|レビュー|監査|評価/i],
  ["planning", /\b(plan|design|architecture|proposal|break down)\b|計画|設計|方針|分解/i],
  ["research", /\b(research|investigate|compare|explore)\b|調査|比較|検討|探索/i],
  ["documentation", /\b(document|docs|readme|guide|explain)\b|文書|ドキュメント|説明|解説/i],
  [
    "operations",
    /\b(deploy|release|ci|workflow|infrastructure|migration)\b|デプロイ|リリース|運用|移行/i,
  ],
  [
    "coding",
    /\b(implement|code|refactor|feature|test|edit|change)\b|実装|コード|リファクタ|機能|テスト|修正/i,
  ],
];

const RELEVANT_PRINCIPLES = {
  coding: [
    "minimize-reader-load",
    "outcome-oriented-execution",
    "boundary-discipline",
    "type-system-discipline",
    "prove-it-works",
    "sequence-verifiable-units",
    "fix-root-causes",
  ],
  debugging: [
    "foundational-thinking",
    "minimize-reader-load",
    "prove-it-works",
    "sequence-verifiable-units",
    "fix-root-causes",
  ],
  review: [
    "minimize-reader-load",
    "outcome-oriented-execution",
    "boundary-discipline",
    "type-system-discipline",
    "prove-it-works",
  ],
  planning: [
    "foundational-thinking",
    "outcome-oriented-execution",
    "exhaust-the-design-space",
    "boundary-discipline",
  ],
  research: ["foundational-thinking", "minimize-reader-load", "outcome-oriented-execution"],
  documentation: ["minimize-reader-load", "experience-first", "outcome-oriented-execution"],
  operations: [
    "make-operations-idempotent",
    "serialize-shared-state-mutations",
    "fail-fast-required-config",
    "prove-it-works",
  ],
  other: ["laziness-protocol", "outcome-oriented-execution", "guard-the-context-window"],
};

export function inferTaskType(prompt = "") {
  return TASK_RULES.find(([, pattern]) => pattern.test(String(prompt)))?.[0] ?? "other";
}

export function resolveBrainMode(configured = DEFAULT_BRAIN_MODE, sessionIdentity = "") {
  if (["none", "relevant", "full"].includes(configured)) return configured;
  if (configured !== "auto") return DEFAULT_BRAIN_MODE;
  const digest = createHash("sha256").update(String(sessionIdentity)).digest();
  return ["none", "relevant", "full"][digest[0] % 3];
}

export function selectBrainContext(context, mode, taskType = "other") {
  if (mode === "none") return "";
  if (mode === "full") return context;
  const selected = new Set(RELEVANT_PRINCIPLES[taskType] ?? RELEVANT_PRINCIPLES.other);
  const lines = String(context).split("\n");
  const safety = lines
    .slice(
      0,
      Math.max(
        0,
        lines.findIndex((line) => line === "## Principles"),
      ),
    )
    .filter((line) => line.trim());
  const principles = lines.filter(
    (line) =>
      line.startsWith("- [[principles/") &&
      [...selected].some((slug) => line.includes(`/${slug}]]`)),
  );
  const onDemand = lines.slice(
    Math.max(
      0,
      lines.findIndex((line) => line === "## On demand"),
    ),
  );
  return [...safety, "", "## Relevant Atlantis principles", ...principles, "", ...onDemand]
    .join("\n")
    .trim();
}

function parseNumstat(output = "") {
  return String(output)
    .split("\n")
    .reduce(
      (total, line) => {
        const [added, deleted] = line.split("\t");
        if (/^\d+$/.test(added)) total.added += Number(added);
        if (/^\d+$/.test(deleted)) total.deleted += Number(deleted);
        return total;
      },
      { added: 0, deleted: 0 },
    );
}

async function captureGitDiff(pi, cwd) {
  try {
    const result = await pi.exec("git", ["-C", cwd, "diff", "--numstat", "HEAD", "--"], {
      timeout: 5_000,
    });
    return result.code === 0 ? parseNumstat(result.stdout) : { added: 0, deleted: 0 };
  } catch {
    return { added: 0, deleted: 0 };
  }
}

function addColumnIfMissing(database, table, definition) {
  const name = definition.trim().split(/\s+/, 1)[0];
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((column) => column.name === name)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

function openMetricsDatabase(path) {
  if (process.versions.bun) {
    const { Database } = nodeRequire("bun:sqlite");
    const database = new Database(path, { create: true });
    database.exec("PRAGMA busy_timeout = 1000;");
    return database;
  }
  const { DatabaseSync } = nodeRequire("node:sqlite");
  return new DatabaseSync(path, { timeout: 1_000 });
}

export function createMetricsStore(path = DEFAULT_METRICS_PATH) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const database = openMetricsDatabase(path);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS interactions (
      id TEXT PRIMARY KEY,
      session_path TEXT NOT NULL,
      interaction_index INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      settled_at INTEGER,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      thinking_level TEXT NOT NULL,
      cwd TEXT NOT NULL,
      prompt_bytes INTEGER NOT NULL,
      system_prompt_bytes INTEGER NOT NULL,
      system_options_bytes INTEGER NOT NULL,
      task_type TEXT NOT NULL DEFAULT 'other',
      prompt_version TEXT NOT NULL DEFAULT 'default',
      extension_hash TEXT NOT NULL DEFAULT '',
      brain_mode TEXT NOT NULL DEFAULT 'full',
      outcome TEXT NOT NULL DEFAULT 'unrated',
      test_status TEXT NOT NULL DEFAULT 'unknown',
      human_corrections INTEGER,
      diff_start_added INTEGER NOT NULL DEFAULT 0,
      diff_start_deleted INTEGER NOT NULL DEFAULT 0,
      diff_end_added INTEGER NOT NULL DEFAULT 0,
      diff_end_deleted INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      turns INTEGER NOT NULL DEFAULT 0,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      tool_errors INTEGER NOT NULL DEFAULT 0,
      compactions INTEGER NOT NULL DEFAULT 0,
      max_context_tokens INTEGER NOT NULL DEFAULT 0,
      context_window INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      wall_ms INTEGER NOT NULL DEFAULT 0,
      aborted INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE INDEX IF NOT EXISTS interactions_started_at
      ON interactions(started_at DESC);
    CREATE TABLE IF NOT EXISTS turns (
      interaction_id TEXT NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
      turn_index INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      reasoning_tokens INTEGER NOT NULL,
      tool_calls INTEGER NOT NULL,
      context_tokens INTEGER NOT NULL,
      context_delta_tokens INTEGER NOT NULL DEFAULT 0,
      tool_output_bytes INTEGER NOT NULL DEFAULT 0,
      context_window INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      stop_reason TEXT NOT NULL,
      PRIMARY KEY (interaction_id, turn_index)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS tool_calls (
      interaction_id TEXT NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
      tool_call_id TEXT NOT NULL,
      turn_index INTEGER NOT NULL,
      tool_name TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL,
      input_bytes INTEGER NOT NULL,
      output_bytes INTEGER NOT NULL,
      is_error INTEGER NOT NULL,
      PRIMARY KEY (interaction_id, tool_call_id)
    ) STRICT;
  `);
  for (const definition of [
    "task_type TEXT NOT NULL DEFAULT 'other'",
    "prompt_version TEXT NOT NULL DEFAULT 'default'",
    "extension_hash TEXT NOT NULL DEFAULT ''",
    "brain_mode TEXT NOT NULL DEFAULT 'full'",
    "outcome TEXT NOT NULL DEFAULT 'unrated'",
    "test_status TEXT NOT NULL DEFAULT 'unknown'",
    "human_corrections INTEGER",
    "diff_start_added INTEGER NOT NULL DEFAULT 0",
    "diff_start_deleted INTEGER NOT NULL DEFAULT 0",
    "diff_end_added INTEGER NOT NULL DEFAULT 0",
    "diff_end_deleted INTEGER NOT NULL DEFAULT 0",
  ])
    addColumnIfMissing(database, "interactions", definition);
  for (const definition of [
    "context_delta_tokens INTEGER NOT NULL DEFAULT 0",
    "tool_output_bytes INTEGER NOT NULL DEFAULT 0",
  ])
    addColumnIfMissing(database, "turns", definition);

  const insertInteraction = database.prepare(`
    INSERT INTO interactions (
      id, session_path, interaction_index, started_at, provider, model,
      thinking_level, cwd, prompt_bytes, system_prompt_bytes, system_options_bytes,
      task_type, prompt_version, extension_hash, brain_mode,
      diff_start_added, diff_start_deleted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTurn = database.prepare(`
    INSERT OR REPLACE INTO turns (
      interaction_id, turn_index, started_at, ended_at, input_tokens,
      output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
      tool_calls, context_tokens, context_delta_tokens, tool_output_bytes,
      context_window, cost_usd, stop_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertToolCall = database.prepare(`
    INSERT OR REPLACE INTO tool_calls (
      interaction_id, tool_call_id, turn_index, tool_name, started_at,
      ended_at, input_bytes, output_bytes, is_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const finishInteraction = database.prepare(`
    UPDATE interactions SET
      settled_at = ?, input_tokens = ?, output_tokens = ?,
      cache_read_tokens = ?, cache_write_tokens = ?, reasoning_tokens = ?,
      turns = ?, tool_calls = ?, tool_errors = ?, compactions = ?,
      max_context_tokens = ?, context_window = ?, cost_usd = ?,
      wall_ms = ?, aborted = ?, diff_end_added = ?, diff_end_deleted = ?
    WHERE id = ?
  `);
  const updateOutcome = database.prepare(`
    UPDATE interactions SET outcome = ?, test_status = ?, human_corrections = ?, task_type = ?
    WHERE id = (
      SELECT id FROM interactions
      WHERE settled_at IS NOT NULL AND cwd = ?
      ORDER BY started_at DESC
      LIMIT 1
    )
    RETURNING id
  `);
  const recentInteractions = database.prepare(`
    SELECT id, interaction_index, started_at, provider, model, thinking_level,
      turns, prompt_bytes, system_prompt_bytes, task_type, prompt_version,
      extension_hash, brain_mode, outcome, test_status, human_corrections,
      diff_start_added, diff_start_deleted, diff_end_added, diff_end_deleted,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      tool_calls, tool_errors, compactions, max_context_tokens,
      context_window, cost_usd, wall_ms, aborted
    FROM interactions
    WHERE settled_at IS NOT NULL AND cwd = ?
    ORDER BY started_at DESC
    LIMIT ?
  `);
  const recentToolUsage = database.prepare(`
    SELECT tool_name,
      count(*) AS calls,
      sum(is_error) AS errors,
      sum(ended_at - started_at) AS duration_ms,
      sum(input_bytes) AS input_bytes,
      sum(output_bytes) AS output_bytes
    FROM tool_calls
    WHERE interaction_id IN (
      SELECT id FROM interactions
      WHERE settled_at IS NOT NULL AND cwd = ?
      ORDER BY started_at DESC
      LIMIT ?
    )
    GROUP BY tool_name
    ORDER BY calls DESC
  `);
  return {
    start(record) {
      insertInteraction.run(
        record.id,
        record.sessionPath,
        record.interactionIndex,
        record.startedAt,
        record.provider,
        record.model,
        record.thinkingLevel,
        record.cwd,
        record.promptBytes,
        record.systemPromptBytes,
        record.systemOptionsBytes,
        record.taskType ?? "other",
        record.promptVersion ?? DEFAULT_PROMPT_VERSION,
        record.extensionHash ?? EXTENSION_HASH,
        record.brainMode ?? DEFAULT_BRAIN_MODE,
        record.diffStartAdded ?? 0,
        record.diffStartDeleted ?? 0,
      );
    },
    turn(record) {
      insertTurn.run(
        record.interactionID,
        record.turnIndex,
        record.startedAt,
        record.endedAt,
        record.input,
        record.output,
        record.cacheRead,
        record.cacheWrite,
        record.reasoning,
        record.toolCalls,
        record.contextTokens,
        record.contextDeltaTokens,
        record.toolOutputBytes,
        record.contextWindow,
        record.cost,
        record.stopReason,
      );
    },
    tool(record) {
      insertToolCall.run(
        record.interactionID,
        record.toolCallID,
        record.turnIndex,
        record.toolName,
        record.startedAt,
        record.endedAt,
        record.inputBytes,
        record.outputBytes,
        record.isError ? 1 : 0,
      );
    },
    finish(record) {
      finishInteraction.run(
        record.settledAt,
        record.input,
        record.output,
        record.cacheRead,
        record.cacheWrite,
        record.reasoning,
        record.turns,
        record.toolCalls,
        record.toolErrors,
        record.compactions,
        record.maxContextTokens,
        record.contextWindow,
        record.cost,
        record.wallMS,
        record.aborted ? 1 : 0,
        record.diffEndAdded ?? 0,
        record.diffEndDeleted ?? 0,
        record.id,
      );
    },
    outcome(cwd, record) {
      return updateOutcome.get(
        record.outcome,
        record.testStatus,
        record.humanCorrections,
        record.taskType,
        cwd,
      );
    },
    recent(limit = 20, cwd = "") {
      return recentInteractions.all(cwd, Math.max(1, Math.min(100, limit)));
    },
    tools(limit = 20, cwd = "") {
      return recentToolUsage.all(cwd, Math.max(1, Math.min(100, limit)));
    },
    close() {
      database.close();
    },
  };
}

function sortedMetric(records, field) {
  return records.map((record) => numeric(record[field])).sort((left, right) => left - right);
}

function medianMetric(records, field) {
  const values = sortedMetric(records, field);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 1 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function p90Metric(records, field) {
  const values = sortedMetric(records, field);
  return values[Math.max(0, Math.ceil(values.length * 0.9) - 1)];
}

function formatMetricsStatus(records, cwd) {
  if (records.length === 0) return `No Pi interactions recorded for ${cwd}.`;
  const totals = records.reduce(
    (sum, record) => ({
      input: sum.input + record.input_tokens,
      cacheRead: sum.cacheRead + record.cache_read_tokens,
      cacheWrite: sum.cacheWrite + record.cache_write_tokens,
    }),
    { input: 0, cacheRead: 0, cacheWrite: 0 },
  );
  const contextRecord = records.reduce((maximum, record) =>
    record.max_context_tokens > maximum.max_context_tokens ? record : maximum,
  );
  const context = contextRecord.max_context_tokens;
  const window = contextRecord.context_window;
  const contextPercent = window > 0 ? ` (${((context / window) * 100).toFixed(1)}%)` : "";
  const cacheDenominator = totals.input + totals.cacheRead + totals.cacheWrite;
  const cacheHit =
    cacheDenominator > 0 ? `${((totals.cacheRead / cacheDenominator) * 100).toFixed(1)}%` : "n/a";
  const rated = records.filter((record) => record.outcome && record.outcome !== "unrated");
  const success = rated.filter((record) => record.outcome === "success").length;
  return [
    `cwd ${cwd}`,
    `last ${records.length} interactions`,
    `median input ${Math.round(medianMetric(records, "input_tokens"))}`,
    `median turns ${medianMetric(records, "turns")}`,
    `p90 turns ${p90Metric(records, "turns")}`,
    `median tools ${medianMetric(records, "tool_calls")}`,
    `max context ${context}${contextPercent}`,
    `cache hit ${cacheHit}`,
    `p90 elapsed ${(p90Metric(records, "wall_ms") / 1_000).toFixed(1)}s`,
    `rated success ${rated.length > 0 ? `${success}/${rated.length}` : "n/a"}`,
    `aborted ${records.filter((record) => record.aborted === 1).length}`,
  ].join(" | ");
}

const REPORT_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};
const TOKEN_SEGMENTS = [
  ["input", "input_tokens", "fresh input"],
  ["write", "cache_write_tokens", "cache write"],
  ["read", "cache_read_tokens", "cache read"],
  ["output", "output_tokens", "output"],
];

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"]/g, (character) => REPORT_ESCAPES[character]);
}

function formatTokens(value) {
  const count = numeric(value);
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 10_000) return `${Math.round(count / 1_000)}k`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return `${Math.round(count)}`;
}

function formatSeconds(value) {
  const seconds = numeric(value) / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
}

function formatCost(value) {
  const cost = numeric(value);
  return cost >= 1 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(3)}`;
}

function formatLocalTime(value) {
  const date = new Date(numeric(value));
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part) => String(part).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function barWidth(value, maximum) {
  if (maximum <= 0) return 0;
  return Math.max(1, Math.round((numeric(value) / maximum) * 100));
}

function meterCell(value, maximum, label, tone) {
  return [
    `<td class="meter">`,
    `<span class="bar"><span class="fill ${tone}" style="width:${barWidth(value, maximum)}%"></span></span>`,
    `<span class="figure">${escapeHTML(label)}</span>`,
    `</td>`,
  ].join("");
}

function tokenCell(record, maximum) {
  const total = TOKEN_SEGMENTS.reduce((sum, [, field]) => sum + numeric(record[field]), 0);
  const segments = TOKEN_SEGMENTS.filter(([, field]) => numeric(record[field]) > 0)
    .map(
      ([tone, field, label]) =>
        `<span class="seg ${tone}" style="flex:${numeric(record[field])}" title="${label} ${formatTokens(record[field])}"></span>`,
    )
    .join("");
  return [
    `<td class="meter">`,
    `<span class="bar"><span class="mix" style="width:${barWidth(total, maximum)}%">${segments}</span></span>`,
    `<span class="figure">${escapeHTML(formatTokens(total))}</span>`,
    `</td>`,
  ].join("");
}

function summaryCard(label, value, hint) {
  return [
    `<div class="card">`,
    `<span class="label">${escapeHTML(label)}</span>`,
    `<span class="value">${escapeHTML(value)}</span>`,
    `<span class="hint">${escapeHTML(hint)}</span>`,
    `</div>`,
  ].join("");
}

function interactionFlags(record) {
  const flags = [];
  if (record.aborted === 1) flags.push(`<span class="flag stop">aborted</span>`);
  if (record.outcome === "success") flags.push(`<span class="flag pass">success</span>`);
  if (record.outcome === "rework") flags.push(`<span class="flag warn">rework</span>`);
  if (record.outcome === "failed") flags.push(`<span class="flag stop">failed</span>`);
  if (numeric(record.compactions) > 0)
    flags.push(`<span class="flag warn">compact ${numeric(record.compactions)}</span>`);
  if (numeric(record.tool_errors) > 0)
    flags.push(`<span class="flag warn">err ${numeric(record.tool_errors)}</span>`);
  return flags.join(" ");
}

export function renderMetricsReport({
  cwd = "",
  records = [],
  tools = [],
  generatedAt = Date.now(),
} = {}) {
  const totals = records.reduce(
    (sum, record) => ({
      input: sum.input + numeric(record.input_tokens),
      output: sum.output + numeric(record.output_tokens),
      cacheRead: sum.cacheRead + numeric(record.cache_read_tokens),
      cacheWrite: sum.cacheWrite + numeric(record.cache_write_tokens),
      cost: sum.cost + numeric(record.cost_usd),
      aborted: sum.aborted + (record.aborted === 1 ? 1 : 0),
      toolErrors: sum.toolErrors + numeric(record.tool_errors),
    }),
    {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      aborted: 0,
      toolErrors: 0,
    },
  );
  const cacheDenominator = totals.input + totals.cacheRead + totals.cacheWrite;
  const cacheHit =
    cacheDenominator > 0 ? `${((totals.cacheRead / cacheDenominator) * 100).toFixed(1)}%` : "n/a";
  const contextRecord =
    records.length > 0
      ? records.reduce((maximum, record) => {
          if (numeric(record.max_context_tokens) > numeric(maximum.max_context_tokens))
            return record;
          return maximum;
        })
      : undefined;
  const contextWindow = numeric(contextRecord?.context_window);
  const contextPercent =
    contextWindow > 0
      ? `${((numeric(contextRecord.max_context_tokens) / contextWindow) * 100).toFixed(1)}%`
      : "n/a";
  const rated = records.filter((record) => record.outcome && record.outcome !== "unrated");
  const successful = rated.filter((record) => record.outcome === "success");
  const maxTokens = Math.max(
    ...records.map((record) =>
      TOKEN_SEGMENTS.reduce((sum, [, field]) => sum + numeric(record[field]), 0),
    ),
    0,
  );
  const maxWall = Math.max(...records.map((record) => numeric(record.wall_ms)), 0);
  const maxCalls = Math.max(...tools.map((tool) => numeric(tool.calls)), 0);
  const median = (field) => (records.length > 0 ? medianMetric(records, field) : 0);
  const p90 = (field) => (records.length > 0 ? p90Metric(records, field) : 0);
  const cards = [
    summaryCard("interactions", `${records.length}`, "settled user submissions"),
    summaryCard("turns", `${median("turns")} / ${p90("turns")}`, "median / p90 per interaction"),
    summaryCard(
      "tool calls",
      `${median("tool_calls")} / ${p90("tool_calls")}`,
      "median / p90 per interaction",
    ),
    summaryCard(
      "elapsed",
      `${formatSeconds(median("wall_ms"))} / ${formatSeconds(p90("wall_ms"))}`,
      "median / p90 wall clock",
    ),
    summaryCard("cache hit", cacheHit, "cache read share of input"),
    summaryCard("fresh input", formatTokens(totals.input), "tokens billed at full price"),
    summaryCard(
      "peak context",
      `${formatTokens(contextRecord?.max_context_tokens ?? 0)} (${contextPercent})`,
      "largest carried context",
    ),
    summaryCard("cost", formatCost(totals.cost), "provider-reported total"),
    summaryCard(
      "rated success",
      rated.length > 0 ? `${successful.length}/${rated.length}` : "n/a",
      "success among human-rated interactions",
    ),
    summaryCard(
      "aborted / tool errors",
      `${totals.aborted} / ${totals.toolErrors}`,
      "interrupted runs, failed tool calls",
    ),
  ].join("");
  const rows = records
    .map((record, position) =>
      [
        `<tr${record.aborted === 1 ? ` class="stopped"` : ""}>`,
        `<td class="index" title="submission ${numeric(record.interaction_index)} of its session">${position + 1}</td>`,
        `<td class="time">${escapeHTML(formatLocalTime(record.started_at))}</td>`,
        `<td class="model">${escapeHTML(record.model ?? "")}<span class="sub">${escapeHTML([record.thinking_level, `brain:${record.brain_mode ?? "unknown"}`, record.task_type].filter(Boolean).join(" · "))}</span></td>`,
        `<td class="count">${numeric(record.turns)}</td>`,
        `<td class="count">${numeric(record.tool_calls)}</td>`,
        tokenCell(record, maxTokens),
        meterCell(
          record.max_context_tokens,
          contextWindow,
          contextWindow > 0
            ? `${((numeric(record.max_context_tokens) / contextWindow) * 100).toFixed(1)}%`
            : formatTokens(record.max_context_tokens),
          "context",
        ),
        meterCell(record.wall_ms, maxWall, formatSeconds(record.wall_ms), "elapsed"),
        `<td class="cost">${escapeHTML(formatCost(record.cost_usd))}</td>`,
        `<td class="quality">${escapeHTML(`${record.test_status ?? "unknown"} · corr ${record.human_corrections ?? "?"} · Δ +${numeric(record.diff_end_added) - numeric(record.diff_start_added)}/-${numeric(record.diff_end_deleted) - numeric(record.diff_start_deleted)}`)}</td>`,
        `<td class="flags">${interactionFlags(record)}</td>`,
        `</tr>`,
      ].join(""),
    )
    .join("");
  const brainGroups = new Map();
  for (const record of records) {
    const mode = record.brain_mode ?? "unknown";
    const group = brainGroups.get(mode) ?? {
      records: [],
      rated: 0,
      success: 0,
    };
    group.records.push(record);
    if (record.outcome && record.outcome !== "unrated") group.rated += 1;
    if (record.outcome === "success") group.success += 1;
    brainGroups.set(mode, group);
  }
  const brainRows = [...brainGroups.entries()]
    .map(([mode, group]) => {
      const tokens = group.records.map((record) =>
        TOKEN_SEGMENTS.reduce((sum, [, field]) => sum + numeric(record[field]), 0),
      );
      const sorted = [...tokens].sort((left, right) => left - right);
      const middle = sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)];
      return `<tr><td class="model">${escapeHTML(mode)}</td><td class="count">${group.records.length}</td><td class="count">${group.success}/${group.rated}</td><td class="cost">${escapeHTML(formatTokens(middle))}</td></tr>`;
    })
    .join("");
  const toolRows = tools
    .map((tool) =>
      [
        `<tr>`,
        `<td class="model">${escapeHTML(tool.tool_name ?? "")}</td>`,
        meterCell(tool.calls, maxCalls, `${numeric(tool.calls)}`, "calls"),
        `<td class="count">${numeric(tool.errors)}</td>`,
        `<td class="cost">${escapeHTML(formatSeconds(tool.duration_ms))}</td>`,
        `<td class="cost">${escapeHTML(formatSeconds(numeric(tool.duration_ms) / Math.max(1, numeric(tool.calls))))}</td>`,
        `<td class="cost">${escapeHTML(formatTokens(tool.output_bytes))}B</td>`,
        `</tr>`,
      ].join(""),
    )
    .join("");
  const empty = `<p class="empty">No settled interactions recorded for this directory yet.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Atlantis metrics</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; padding: 32px clamp(16px, 4vw, 56px); background: #0d1117; color: #e6edf3;
  font: 14px/1.5 ui-sans-serif, -apple-system, "Helvetica Neue", sans-serif; }
h1 { margin: 0; font-size: 20px; letter-spacing: .02em; }
h2 { margin: 40px 0 12px; font-size: 14px; text-transform: uppercase; letter-spacing: .12em; color: #8b949e; }
.meta { margin: 6px 0 0; color: #8b949e; font-size: 12px; }
.meta code { color: #e6edf3; }
.cards { display: grid; gap: 12px; margin-top: 24px;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
.card { background: #161b22; border: 1px solid #21262d; border-radius: 10px; padding: 12px 14px;
  display: flex; flex-direction: column; gap: 2px; }
.card .label { font-size: 11px; text-transform: uppercase; letter-spacing: .1em; color: #8b949e; }
.card .value { font-size: 22px; font-variant-numeric: tabular-nums; }
.card .hint { font-size: 11px; color: #6e7681; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .08em;
  color: #8b949e; font-weight: 500; padding: 6px 10px; border-bottom: 1px solid #21262d; }
td { padding: 8px 10px; border-bottom: 1px solid #161b22; vertical-align: middle; }
tr.stopped td { background: rgba(248, 81, 73, .07); }
.index { color: #6e7681; }
.time, .sub { color: #8b949e; font-size: 12px; }
.model .sub { margin-left: 6px; }
.count, .cost { text-align: right; }
.meter { width: 15%; min-width: 120px; }
.bar { display: block; height: 8px; background: #21262d; border-radius: 4px; overflow: hidden; }
.bar .fill, .bar .mix { display: flex; height: 100%; border-radius: 4px; }
.fill.context { background: #a371f7; }
.fill.elapsed { background: #58a6ff; }
.fill.calls { background: #3fb950; }
.seg { height: 100%; }
.seg.input { background: #f0883e; }
.seg.write { background: #d29922; }
.seg.read { background: #3fb950; }
.seg.output { background: #58a6ff; }
.figure { display: block; margin-top: 3px; font-size: 11px; color: #8b949e; }
.flag { display: inline-block; padding: 1px 6px; border-radius: 999px; font-size: 11px; }
.flag.stop { background: rgba(248, 81, 73, .18); color: #ff7b72; }
.flag.warn { background: rgba(210, 153, 34, .18); color: #d29922; }
.flag.pass { background: rgba(63, 185, 80, .18); color: #56d364; }
.legend { display: flex; flex-wrap: wrap; gap: 14px; margin: 12px 0 0; padding: 0; list-style: none;
  font-size: 12px; color: #8b949e; }
.legend span { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; }
.empty { color: #8b949e; }
details { margin-top: 40px; color: #8b949e; font-size: 12px; }
summary { cursor: pointer; color: #58a6ff; }
dt { margin-top: 10px; color: #e6edf3; }
dd { margin: 2px 0 0; }
</style>
</head>
<body>
<h1>Atlantis metrics</h1>
<p class="meta"><code>${escapeHTML(cwd)}</code> &middot; last ${records.length} interactions &middot; generated ${escapeHTML(formatLocalTime(generatedAt))}</p>
<section class="cards">${cards}</section>
<h2>Interactions</h2>
${
  records.length === 0
    ? empty
    : `<table>
<thead><tr><th>#</th><th>time</th><th>model / experiment</th><th class="count">turns</th><th class="count">tools</th>
<th>tokens</th><th>context</th><th>elapsed</th><th class="cost">cost</th><th>quality evidence</th><th>flags</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<ul class="legend">
<li><span style="background:#f0883e"></span>fresh input</li>
<li><span style="background:#d29922"></span>cache write</li>
<li><span style="background:#3fb950"></span>cache read</li>
<li><span style="background:#58a6ff"></span>output</li>
</ul>`
}
<h2>Brain A/B</h2>
${brainRows ? `<table><thead><tr><th>mode</th><th class="count">interactions</th><th class="count">success / rated</th><th class="cost">median tokens</th></tr></thead><tbody>${brainRows}</tbody></table>` : empty}
<h2>Tools</h2>
${
  tools.length === 0
    ? empty
    : `<table>
<thead><tr><th>tool</th><th>calls</th><th class="count">errors</th><th class="cost">total</th>
<th class="cost">avg</th><th class="cost">output</th></tr></thead>
<tbody>${toolRows}</tbody>
</table>`
}
<details>
<summary>What these numbers mean</summary>
<dl>
<dt>interaction</dt><dd>One user submission, from prompt to settle. Automatic retries and compaction stay inside it.</dd>
<dt>turns</dt><dd>Model calls inside one interaction. A high p90 with a low median means a few runs do all the tool work.</dd>
<dt>fresh input</dt><dd>Input tokens that missed the prompt cache. This is the expensive part of the bill.</dd>
<dt>cache hit</dt><dd>Cache reads divided by all input tokens. A falling value means the prompt prefix keeps changing.</dd>
<dt>context</dt><dd>Largest context carried into a single model call, against the model window. Unrelated to billed tokens.</dd>
<dt>rated success</dt><dd>Human-recorded success divided by all interactions rated in the automatic picker or with /atl-outcome. Unrated work is excluded.</dd>
<dt>Brain A/B</dt><dd>Session-stable Brain injection assignment. Compare only similar task types and prompt versions.</dd>
<dt>diff</dt><dd>Tracked git diff line-count change from interaction start to settlement; untracked files are excluded.</dd>
<dt>flags</dt><dd>aborted: interrupted or errored run. compact: context compactions. err: failed tool calls.</dd>
</dl>
</details>
</body>
</html>
`;
}

export async function writeMetricsReport(html, path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, html, "utf8");
  return path;
}

async function openReport(path) {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  await execFileAsync(command, [path], { shell: false, timeout: 10_000 });
}

export async function loadContext(state, exec) {
  const rawFingerprint = await exec(["brain", "context", "--print-fingerprint"]);
  const fingerprint = rawFingerprint.trim();
  if (fingerprint && fingerprint === state.fingerprint && state.context) {
    return state.context;
  }
  const raw = await exec(["-o", "json", "brain", "context"]);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("Atlantis returned invalid brain context JSON", {
      cause: error,
    });
  }
  state.fingerprint = typeof parsed.fingerprint === "string" ? parsed.fingerprint : fingerprint;
  state.context = typeof parsed.context === "string" ? parsed.context : "";
  return state.context;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function fraction(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : fallback;
}

function limitsFromEnvironment(env = process.env) {
  return {
    contextTokens: positiveInteger(env.ATLANTIS_CONTEXT_TOKEN_LIMIT, undefined),
    contextRatio: fraction(env.ATLANTIS_CONTEXT_WINDOW_RATIO, DEFAULT_CONTEXT_WINDOW_RATIO),
    warningRatio: fraction(env.ATLANTIS_CONTEXT_WARNING_RATIO, DEFAULT_CONTEXT_WARNING_RATIO),
    compactions: positiveInteger(env.ATLANTIS_COMPACTION_LIMIT, DEFAULT_COMPACTION_LIMIT),
  };
}

function configuredBrainMode(env = process.env) {
  const mode = String(env.ATLANTIS_BRAIN_MODE ?? DEFAULT_BRAIN_MODE).toLowerCase();
  return ["auto", "none", "relevant", "full"].includes(mode) ? mode : DEFAULT_BRAIN_MODE;
}

function promptVersion(env = process.env) {
  const version = String(env.ATLANTIS_PROMPT_VERSION ?? DEFAULT_PROMPT_VERSION).trim();
  return version || DEFAULT_PROMPT_VERSION;
}

// The boundary scales with the model context window; a fixed token count is either
// premature on a 500k window or too late on a 128k one.
function contextTokenLimit(usage, limits) {
  if (limits.contextTokens) return limits.contextTokens;
  const contextWindow = Number.isFinite(usage?.contextWindow) ? usage.contextWindow : 0;
  if (contextWindow <= 0) return DEFAULT_CONTEXT_TOKEN_LIMIT;
  return Math.floor(contextWindow * (limits.contextRatio ?? DEFAULT_CONTEXT_WINDOW_RATIO));
}

function entryData(entry, customType) {
  return entry?.type === "custom" && entry.customType === customType ? entry.data : undefined;
}

function entriesFromContext(ctx) {
  return ctx?.sessionManager?.getBranch?.() ?? ctx?.sessionManager?.getEntries?.() ?? [];
}

function restoreSessionState(state, ctx) {
  state.compactions = 0;
  state.playbooks.clear();
  state.guard = undefined;
  state.warning = undefined;
  state.brainAssignment = undefined;

  for (const entry of entriesFromContext(ctx)) {
    if (entry?.type === "compaction") {
      state.compactions += 1;
      continue;
    }

    const playbook = entryData(entry, "atlantis-playbook")?.playbook;
    if (typeof playbook === "string") {
      state.playbooks.add(playbook);
      continue;
    }

    const guard = entryData(entry, "atlantis-context-guard");
    if (guard && typeof guard === "object") {
      state.guard = guard;
      continue;
    }

    const warning = entryData(entry, "atlantis-context-warning");
    if (warning && typeof warning === "object") {
      state.warning = warning;
      continue;
    }

    const assignment = entryData(entry, "atlantis-brain-assignment")?.mode;
    if (["none", "relevant", "full"].includes(assignment)) {
      state.brainAssignment = assignment;
    }
  }
}

export function playbookFromToolResult(event) {
  if (event?.isError) return undefined;
  const input = event?.input;
  if (!input || typeof input !== "object") return undefined;

  const candidate = [input.path, input.file_path].find((value) => typeof value === "string");
  if (!candidate) return undefined;

  const normalized = candidate.replaceAll("\\", "/");
  const match = normalized.match(/(?:^|\/)atlantis\/playbooks\/([^/?#]+\.md)$/);
  return match?.[1];
}

export function contextGuardReason(state, usage, limits = state.limits) {
  const tokens = Number.isFinite(usage?.tokens) ? usage.tokens : 0;
  if (state.compactions >= limits.compactions) {
    return {
      reason: "compaction-limit",
      contextTokens: tokens,
      compactions: state.compactions,
      limit: limits.compactions,
    };
  }
  const tokenLimit = contextTokenLimit(usage, limits);
  if (tokens >= tokenLimit) {
    return {
      reason: "context-token-limit",
      contextTokens: tokens,
      compactions: state.compactions,
      limit: tokenLimit,
    };
  }
  return undefined;
}

function guardMessage(guard, resumePath) {
  const observed =
    guard.reason === "compaction-limit"
      ? `${guard.compactions} compactions (limit ${guard.limit})`
      : `${guard.contextTokens.toLocaleString()} context tokens (limit ${guard.limit.toLocaleString()})`;
  return [
    "## Atlantis context guard",
    "",
    `Host telemetry has activated the handoff boundary: ${observed}.`,
    "Finish only the current atomic step. Do not start another phase or expand scope in this session.",
    `Verify the current step, write a concise resume note to ${resumePath}, then tell the user to run /handoff.`,
    "The note must contain the goal, decisions, changed files, verification evidence, and exact next step for a fresh session.",
  ].join("\n");
}

export function handoffPrompt(note, resumePath = DEFAULT_HANDOFF_RESUME_PATH) {
  return [
    "Continue from the Atlantis resume note captured below.",
    `The note was consumed from ${resumePath}; use the inline copy as the source of truth.`,
    "",
    note.trim(),
  ].join("\n");
}

function updateGuardUI(state, ctx) {
  if (!ctx?.ui) return;
  ctx.ui.setStatus?.(
    "atlantis-context-warning",
    state.warning && !state.guard ? "Atlantis: context 40%+" : undefined,
  );
  ctx.ui.setStatus?.(
    "atlantis-context-guard",
    state.guard ? "Atlantis: handoff required" : undefined,
  );
}

function activateGuard(state, pi, ctx) {
  const usage = ctx?.getContextUsage?.();
  const candidate = contextGuardReason(state, usage);
  if (!state.guard && candidate) {
    state.guard = {
      ...candidate,
      activatedAt: new Date().toISOString(),
    };
    pi.appendEntry?.("atlantis-context-guard", state.guard);
    ctx.ui?.notify?.(
      "Atlantis context limit reached. Finish the current atomic step and hand off before starting new scope.",
      "warning",
    );
  } else if (!state.guard && !state.warning) {
    const tokens = numeric(usage?.tokens);
    const window = numeric(usage?.contextWindow);
    const warningLimit = Math.floor(window * state.limits.warningRatio);
    if (window > 0 && tokens >= warningLimit) {
      state.warning = {
        contextTokens: tokens,
        contextWindow: window,
        ratio: state.limits.warningRatio,
        activatedAt: new Date().toISOString(),
      };
      pi.appendEntry?.("atlantis-context-warning", state.warning);
      ctx.ui?.notify?.(
        `Atlantis context reached ${Math.round(state.limits.warningRatio * 100)}%. Avoid expanding scope; prepare to hand off at ${Math.round(state.limits.contextRatio * 100)}%.`,
        "warning",
      );
    }
  }
  updateGuardUI(state, ctx);
  return state.guard;
}

function ensureBrainAssignment(state, pi, ctx) {
  if (state.brainAssignment) return state.brainAssignment;
  const identity =
    ctx.sessionManager?.getSessionId?.() ??
    ctx.sessionManager?.getSessionFile?.() ??
    `${ctx.cwd ?? ""}:${Date.now()}`;
  state.brainAssignment = resolveBrainMode(state.configuredBrainMode, identity);
  pi.appendEntry?.("atlantis-brain-assignment", {
    configured: state.configuredBrainMode,
    mode: state.brainAssignment,
    assignedAt: new Date().toISOString(),
  });
  return state.brainAssignment;
}

function parseOutcomeArgs(args) {
  const words = String(args ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const outcome = words.find((word) => ["success", "rework", "failed"].includes(word));
  const values = Object.fromEntries(
    words.filter((word) => word.includes("=")).map((word) => word.split(/=(.*)/s, 2)),
  );
  const testStatus = values.test ?? "unknown";
  const corrections = values.corrections === undefined ? null : Number(values.corrections);
  const taskType = values.task ?? "other";
  if (!outcome)
    throw new Error(
      "usage: /atl-outcome success|rework|failed [test=passed|failed|unknown] [corrections=N] [task=TYPE]",
    );
  if (!["passed", "failed", "unknown"].includes(testStatus))
    throw new Error("test must be passed, failed, or unknown");
  if (corrections !== null && (!Number.isSafeInteger(corrections) || corrections < 0))
    throw new Error("corrections must be a non-negative integer");
  if (![...TASK_RULES.map(([name]) => name), "other"].includes(taskType))
    throw new Error(`unknown task type: ${taskType}`);
  return { outcome, testStatus, humanCorrections: corrections, taskType };
}

function recordPlaybook(state, pi, ctx, playbook) {
  if (state.playbooks.has(playbook)) return;
  const previous = [...state.playbooks];
  state.playbooks.add(playbook);
  pi.appendEntry?.("atlantis-playbook", {
    playbook,
    reason: "successful-playbook-read",
    loadedAt: new Date().toISOString(),
  });

  if (previous.length > 0 && playbook !== "handoff.md") {
    ctx.ui?.notify?.(
      `Atlantis already selected ${previous[0]}; also loaded ${playbook}. Keep one primary mode; only handoff.md may follow it.`,
      "warning",
    );
  }
}

export function registerPiExtension(pi, options = {}) {
  const resumePath = options.resumePath ?? DEFAULT_HANDOFF_RESUME_PATH;
  const readResumeNote = options.readResumeNote ?? ((path) => readFile(path, "utf8"));
  const consumeResumeNote = options.consumeResumeNote ?? ((path) => writeFile(path, "", "utf8"));
  const writeReport = options.writeReport ?? writeMetricsReport;
  const revealReport = options.revealReport ?? openReport;
  const state = {
    fingerprint: "",
    context: "",
    compactions: 0,
    playbooks: new Set(),
    guard: undefined,
    limits: {
      ...limitsFromEnvironment(options.env),
      ...options.limits,
    },
    configuredBrainMode: options.brainMode ?? configuredBrainMode(options.env),
    brainAssignment: undefined,
    promptVersion: options.promptVersion ?? promptVersion(options.env),
    extensionHash: options.extensionHash ?? EXTENSION_HASH,
    warning: undefined,
    metricsStore: options.metricsStore,
    createMetricsStore: options.createMetricsStore ?? createMetricsStore,
    ownsMetricsStore: false,
    metricsPath: options.metricsPath ?? DEFAULT_METRICS_PATH,
    reportPath: options.reportPath ?? DEFAULT_REPORT_PATH,
    metricsDisabled: options.metricsStore === false,
    metricsErrorShown: false,
    metricsBusyShown: false,
    interactionIndex: 0,
    interaction: undefined,
    currentTurn: undefined,
    activeTools: new Map(),
    captureDiff: options.captureDiff ?? ((cwd) => captureGitDiff(pi, cwd)),
  };
  const exec =
    options.exec ??
    (async (args) => {
      const result = await pi.exec("atlantis", args, { timeout: 10_000 });
      return result.stdout;
    });

  async function refresh() {
    await loadContext(state, exec);
  }
  async function snapshotDiff(cwd) {
    try {
      const snapshot = await state.captureDiff(cwd);
      return {
        added: numeric(snapshot?.added),
        deleted: numeric(snapshot?.deleted),
      };
    } catch {
      return { added: 0, deleted: 0 };
    }
  }
  function isMetricsBusy(error) {
    const reason = error instanceof Error ? error.message : String(error);
    return /busy|locked/i.test(reason);
  }
  function disableMetrics(ctx, error) {
    state.metricsDisabled = true;
    if (state.ownsMetricsStore) {
      try {
        state.metricsStore?.close?.();
      } catch {
        // The original storage error is the useful failure.
      }
    }
    state.metricsStore = undefined;
    state.ownsMetricsStore = false;
    if (!state.metricsErrorShown) {
      const reason = error instanceof Error ? error.message : String(error);
      ctx.ui?.notify?.(`Atlantis metrics disabled: ${reason}`, "warning");
      state.metricsErrorShown = true;
    }
  }

  function metricsStore(ctx) {
    if (state.metricsDisabled) return undefined;
    if (state.metricsStore) return state.metricsStore;
    try {
      state.metricsStore = state.createMetricsStore(state.metricsPath);
      state.ownsMetricsStore = true;
      state.metricsBusyShown = false;
      return state.metricsStore;
    } catch (error) {
      if (isMetricsBusy(error)) {
        if (!state.metricsBusyShown) {
          ctx.ui?.notify?.("Atlantis metrics store is busy; the next event will retry.", "warning");
          state.metricsBusyShown = true;
        }
        return undefined;
      }
      disableMetrics(ctx, error);
      return undefined;
    }
  }

  function useMetrics(ctx, operation) {
    const store = metricsStore(ctx);
    if (!store) return undefined;
    try {
      const value = operation(store);
      state.metricsBusyShown = false;
      return value;
    } catch (error) {
      if (isMetricsBusy(error)) {
        if (!state.metricsBusyShown) {
          ctx.ui?.notify?.(
            "Atlantis metrics skipped one write because the database was busy.",
            "warning",
          );
          state.metricsBusyShown = true;
        }
        return undefined;
      }
      disableMetrics(ctx, error);
      return undefined;
    }
  }

  async function finishMetrics(ctx, aborted) {
    const interaction = state.interaction;
    if (!interaction) return;
    if (!metricsStore(ctx)) {
      state.interaction = undefined;
      state.currentTurn = undefined;
      state.activeTools.clear();
      return;
    }
    const settledAt = Date.now();
    const context = ctx.getContextUsage?.();
    const finalDiff = await snapshotDiff(interaction.cwd);
    interaction.maxContextTokens = Math.max(interaction.maxContextTokens, numeric(context?.tokens));
    interaction.contextWindow = Math.max(
      interaction.contextWindow,
      numeric(context?.contextWindow),
    );
    const recorded = useMetrics(ctx, (store) => {
      store.finish({
        ...interaction,
        settledAt,
        wallMS: settledAt - interaction.startedAt,
        aborted,
        diffEndAdded: finalDiff.added,
        diffEndDeleted: finalDiff.deleted,
      });
      return true;
    });
    state.interaction = undefined;
    state.currentTurn = undefined;
    state.activeTools.clear();
    if (!recorded) return;
    ctx.ui?.setStatus?.(
      "atlantis-metrics",
      `Pi: ${interaction.turns} turns, ${interaction.maxContextTokens} max ctx`,
    );
    const diffChanged =
      finalDiff.added !== interaction.diffStartAdded ||
      finalDiff.deleted !== interaction.diffStartDeleted;
    if (
      aborted ||
      !ctx.hasUI ||
      typeof ctx.ui?.select !== "function" ||
      (!interaction.meaningfulToolUsed && !diffChanged)
    )
      return;
    const choice = await ctx.ui.select("この作業の成果を記録しますか？", OUTCOME_CHOICES);
    const outcome = OUTCOME_BY_CHOICE[choice];
    if (!outcome) return;
    useMetrics(ctx, (store) =>
      store.outcome(interaction.cwd, {
        ...outcome,
        taskType: interaction.taskType,
      }),
    );
  }

  async function startMetrics(event, ctx, systemPrompt, metadata) {
    if (!metricsStore(ctx)) return;
    if (state.interaction) await finishMetrics(ctx, true);
    const startedAt = Date.now();
    const initialDiff = await snapshotDiff(ctx.cwd ?? "");
    const context = ctx.getContextUsage?.();
    state.interactionIndex += 1;
    state.interaction = {
      id: randomUUID(),
      sessionPath: ctx.sessionManager?.getSessionFile?.() ?? "",
      interactionIndex: state.interactionIndex,
      startedAt,
      provider: ctx.model?.provider ?? "",
      model: ctx.model?.id ?? "",
      thinkingLevel: ctx.thinkingLevel ?? "",
      cwd: ctx.cwd ?? "",
      promptBytes: byteLength(event.prompt),
      systemPromptBytes: byteLength(systemPrompt),
      systemOptionsBytes: byteLength(event.systemPromptOptions),
      taskType: metadata.taskType,
      promptVersion: state.promptVersion,
      extensionHash: state.extensionHash,
      brainMode: metadata.brainMode,
      diffStartAdded: initialDiff.added,
      diffStartDeleted: initialDiff.deleted,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      turns: 0,
      toolCalls: 0,
      toolErrors: 0,
      compactions: 0,
      maxContextTokens: numeric(context?.tokens),
      lastContextTokens: numeric(context?.tokens),
      contextWindow: numeric(context?.contextWindow),
      cost: 0,
      meaningfulToolUsed: false,
    };
    if (
      !useMetrics(ctx, (store) => {
        store.start(state.interaction);
        return true;
      })
    ) {
      state.interaction = undefined;
    }
  }

  pi.registerCommand?.("atl-metrics", {
    description: "Atlantis interaction metrics: summary line, or `ui` for an HTML dashboard",
    handler: async (args, ctx) => {
      const words = String(args ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const wantsDashboard = words.some((word) => /^(ui|open|html|dashboard)$/i.test(word));
      const requested = words
        .map((word) => Number.parseInt(word, 10))
        .find((value) => Number.isSafeInteger(value) && value > 0);
      const limit = requested ?? 20;
      const cwd = ctx.cwd ?? "";
      const recent = useMetrics(ctx, (store) => store.recent(limit, cwd));
      if (!recent) {
        ctx.ui?.notify?.("Atlantis metrics are unavailable.", "warning");
        return;
      }
      if (!wantsDashboard || recent.length === 0) {
        ctx.ui?.notify?.(formatMetricsStatus(recent, cwd), "info");
        return;
      }
      const tools = useMetrics(ctx, (store) => store.tools(limit, cwd)) ?? [];
      try {
        const path = await writeReport(
          renderMetricsReport({ cwd, records: recent, tools }),
          state.reportPath,
        );
        await revealReport(path);
        ctx.ui?.notify?.(`Atlantis metrics dashboard: ${path}`, "info");
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        ctx.ui?.notify?.(`Cannot open the metrics dashboard: ${reason}`, "error");
      }
    },
  });

  pi.registerCommand?.("atl-outcome", {
    description: "Rate the latest interaction with outcome and verification evidence",
    handler: async (args, ctx) => {
      let outcome;
      try {
        outcome = parseOutcomeArgs(args);
      } catch (error) {
        ctx.ui?.notify?.(error instanceof Error ? error.message : String(error), "error");
        return;
      }
      const updated = useMetrics(ctx, (store) => store.outcome(ctx.cwd ?? "", outcome));
      if (!updated) {
        ctx.ui?.notify?.("No settled Atlantis interaction found for this directory.", "warning");
        return;
      }
      ctx.ui?.notify?.(
        `Recorded ${outcome.outcome}: test=${outcome.testStatus}, corrections=${outcome.humanCorrections ?? "unknown"}, task=${outcome.taskType}`,
        "info",
      );
    },
  });

  pi.registerCommand?.("atl-brain", {
    description: "Show or set Brain injection mode: auto, none, relevant, or full",
    handler: async (args, ctx) => {
      const configured = String(args ?? "")
        .trim()
        .toLowerCase();
      if (!configured) {
        ctx.ui?.notify?.(
          `Atlantis Brain mode: ${state.brainAssignment ?? ensureBrainAssignment(state, pi, ctx)} (${state.configuredBrainMode})`,
          "info",
        );
        return;
      }
      if (!["auto", "none", "relevant", "full"].includes(configured)) {
        ctx.ui?.notify?.("usage: /atl-brain auto|none|relevant|full", "error");
        return;
      }
      state.configuredBrainMode = configured;
      state.brainAssignment = undefined;
      const mode = ensureBrainAssignment(state, pi, ctx);
      ctx.ui?.notify?.(`Atlantis Brain mode set to ${mode} (${configured})`, "info");
    },
  });

  pi.registerCommand?.("handoff", {
    description: "Start a fresh session from the latest Atlantis resume note",
    handler: async (_args, ctx) => {
      let note;
      try {
        note = await readResumeNote(resumePath);
        if (!note.trim()) throw new Error("resume note is empty");
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        ctx.ui?.notify?.(`Cannot hand off: ${resumePath}: ${reason}`, "error");
        return;
      }

      const parentSession = ctx.sessionManager.getSessionFile?.();
      const prompt = handoffPrompt(note, resumePath);
      const result = await ctx.newSession({
        parentSession,
        withSession: async (replacementCtx) => {
          await replacementCtx.sendUserMessage(prompt);
        },
      });
      if (result.cancelled) {
        ctx.ui?.notify?.("Handoff cancelled", "info");
      } else {
        await consumeResumeNote(resumePath);
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    restoreSessionState(state, ctx);
    ensureBrainAssignment(state, pi, ctx);
    activateGuard(state, pi, ctx);
    ctx.ui?.setStatus?.("atlantis-turn-metrics", undefined);
    ctx.ui?.setWidget?.("atlantis-turn-metrics", undefined, {
      placement: "belowEditor",
    });
    await refresh();
  });

  pi.on("turn_start", (event) => {
    if (!state.interaction) return;
    state.currentTurn = {
      turnIndex: state.interaction.turns + 1,
      sourceTurnIndex: event.turnIndex,
      startedAt: event.timestamp ?? Date.now(),
      toolOutputBytes: 0,
    };
  });

  pi.on("turn_end", (event, ctx) => {
    const interaction = state.interaction;
    if (!interaction || !metricsStore(ctx)) return;
    const endedAt = Date.now();
    const usage = usageFromMessage(event.message, event.toolResults);
    const context = ctx.getContextUsage?.();
    const turnIndex = state.currentTurn?.turnIndex ?? interaction.turns + 1;
    interaction.input += usage.input;
    interaction.output += usage.output;
    interaction.cacheRead += usage.cacheRead;
    interaction.cacheWrite += usage.cacheWrite;
    interaction.reasoning += usage.reasoning;
    interaction.cost += usage.cost;
    interaction.turns += 1;
    const contextTokens = numeric(context?.tokens);
    const contextDeltaTokens = contextTokens - interaction.lastContextTokens;
    const toolOutputBytes = state.currentTurn?.toolOutputBytes ?? 0;
    interaction.lastContextTokens = contextTokens;
    interaction.maxContextTokens = Math.max(interaction.maxContextTokens, numeric(context?.tokens));
    interaction.contextWindow = Math.max(
      interaction.contextWindow,
      numeric(context?.contextWindow),
    );
    useMetrics(ctx, (store) =>
      store.turn({
        interactionID: interaction.id,
        turnIndex,
        startedAt: state.currentTurn?.startedAt ?? endedAt,
        endedAt,
        ...usage,
        toolCalls: assistantToolCalls(event.message),
        contextTokens,
        contextDeltaTokens,
        toolOutputBytes,
        contextWindow: numeric(context?.contextWindow),
        stopReason: event.message?.stopReason ?? "",
      }),
    );
    interaction.lastStopReason = event.message?.stopReason ?? "";
    state.currentTurn = undefined;
  });

  pi.on("tool_execution_start", (event) => {
    if (!state.interaction) return;
    state.activeTools.set(event.toolCallId, {
      interactionID: state.interaction.id,
      toolCallID: event.toolCallId,
      turnIndex: state.currentTurn?.turnIndex ?? state.interaction.turns + 1,
      toolName: event.toolName,
      startedAt: Date.now(),
      inputBytes: byteLength(event.args),
      meaningful: isMeaningfulTool(event.toolName, event.args),
    });
  });

  pi.on("tool_execution_end", (event, ctx) => {
    const interaction = state.interaction;
    const started = state.activeTools.get(event.toolCallId);
    if (!interaction || !started || !metricsStore(ctx)) return;
    interaction.toolCalls += 1;
    if (started.meaningful) interaction.meaningfulToolUsed = true;
    if (event.isError) interaction.toolErrors += 1;
    const outputBytes = byteLength(event.result);
    if (state.currentTurn) state.currentTurn.toolOutputBytes += outputBytes;
    useMetrics(ctx, (store) =>
      store.tool({
        ...started,
        endedAt: Date.now(),
        outputBytes,
        isError: event.isError,
      }),
    );
    state.activeTools.delete(event.toolCallId);
  });

  pi.on(process.versions.bun ? "session_stop" : "agent_settled", async (_event, ctx) => {
    const stopReason = state.interaction?.lastStopReason;
    await finishMetrics(ctx, stopReason === "aborted" || stopReason === "error");
    activateGuard(state, pi, ctx);
    await refresh();
  });

  pi.on("session_compact", (_event, ctx) => {
    const persistedCount = entriesFromContext(ctx).filter(
      (entry) => entry?.type === "compaction",
    ).length;
    state.compactions = Math.max(state.compactions + 1, persistedCount);
    if (state.interaction) state.interaction.compactions += 1;
    activateGuard(state, pi, ctx);
  });

  // Branch and session moves change which entries are active, so guard state is rebuilt
  // from the new branch instead of latching the previous one.
  for (const event of ["session_tree", "session_branch", "session_switch"]) {
    pi.on(event, (_event, ctx) => {
      restoreSessionState(state, ctx);
      activateGuard(state, pi, ctx);
    });
  }

  pi.on("tool_result", (event, ctx) => {
    const playbook = playbookFromToolResult(event);
    if (playbook) recordPlaybook(state, pi, ctx, playbook);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const stopReason = state.interaction?.lastStopReason;
    if (state.interaction) {
      await finishMetrics(ctx, !stopReason || stopReason === "aborted" || stopReason === "error");
    }
    if (state.ownsMetricsStore) state.metricsStore?.close?.();
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!state.context) {
      await refresh();
    }
    const guard = activateGuard(state, pi, ctx);
    const brainMode = ensureBrainAssignment(state, pi, ctx);
    const taskType = inferTaskType(event.prompt);
    const brainContext = selectBrainContext(state.context, brainMode, taskType);
    const sections = [event.systemPrompt];
    if (brainContext) sections.push(`## Atlantis brain\n\n${brainContext}`);
    if (guard) sections.push(guardMessage(guard, resumePath));
    const systemPrompt = sections.join("\n\n");
    await startMetrics(event, ctx, systemPrompt, { brainMode, taskType });
    return { systemPrompt };
  });

  return state;
}

function createOpenCodePlugin() {
  const state = { fingerprint: "", context: "" };
  return {
    "experimental.chat.system.transform": async (_input, output) => {
      const context = await loadContext(state, runAtlantis);
      output.system.push(`## Atlantis brain\n\n${context}`);
    },
  };
}

export default function atlantisBrain(host) {
  if (typeof host?.on === "function" && typeof host?.exec === "function") {
    registerPiExtension(host);
    return;
  }
  return createOpenCodePlugin();
}
