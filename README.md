# pi-extension

Personal extensions for the [pi](https://pi.dev) coding agent.

## Included extensions

- `atlantis-brain.js` — Atlantis context, metrics, and handoff integration
- `git-ref-explorer.ts` — bounded search, reads, and diffs across historical Git refs
- `herdr-autoscale.ts` — explicit-only panopticon run control (start/status/wait/cancel) for parent TUI/RPC sessions
- `lazy-tools.ts` — configuration-driven lazy tool groups with URL/pattern activation and session persistence
- `deferred-extensions.ts` — loads the heavy web-access and pi-lens packages after the TUI is ready
- `input-panel.ts` — input border with model, thinking level, context and usage metrics; toggle with `/input-panel`. Keeps the native footer and respects other custom editors.
- `session-usage.ts` — session token and turn usage summaries plus the `/usage` rolling metrics report
- `subagent/` — isolated subagents with parent-model-family routing
- `virtual-model.ts` — native `router/auto` model; low thinking uses Luna, high thinking uses Sol, and medium uses a classifier when available

`pi-grok-cli` is intentionally not deferred because it must register its provider before startup model-scope resolution. Deferred startup is bounded to 30 seconds so the first prompt cannot hang forever; Node cannot forcibly cancel third-party initialization already in progress after that deadline. A deferred package whose entry is missing under `<agent dir>/npm/node_modules` is skipped silently, so each host defers only what it has installed.

## Hosts

The extensions run on pi and on omp-based hosts. `host-compat.ts` holds every difference: omp exports no `CONFIG_DIR_NAME` (derived from the agent directory instead), has no `ctx.isProjectTrusted` (project-local config is then never read), has no `ctx.mode` (interactive is detected via `ctx.hasUI`), and returns plain tool names from `getAllTools()`. omp also ignores `registerTool` after the load phase, so tools are registered while the factory runs.

## Lazy tool groups

`lazy-tools.ts` keeps configured tool groups out of the initial active-tool list and exposes both the `activate_tool_groups` tool and `/lazy-tools` commands:

```text
/lazy-tools status
/lazy-tools activate web
/lazy-tools reset
```

The built-in `web` group contains `web_search`, `source_check`, `fetch_content`, and `get_search_content`; only the tools the host actually registers are gated. A URL automatically activates the group in interactive sessions. Additional groups can be configured globally at `<agent dir>/lazy-tools.json` and, when the project is trusted, at `<config dir>/lazy-tools.json` (`~/.pi/agent`+`.pi` on pi, `~/.omp/agent`+`.omp` on omp):

```json
{
  "groups": {
    "issues": {
      "tools": ["search_issues"],
      "patterns": ["\\bissue\\b", "https?://issues\\.example\\.com"]
    }
  }
}
```

Global and trusted-project groups are merged; duplicate group names merge their tool and pattern lists. Invalid entries are ignored with a warning, and only registered tools are activated. Configuration cannot include the reserved `activate_tool_groups` tool; patterns over 256 characters or rejected by `safe-regex` are ignored.

### Git ref explorer

The `git_ref_explorer` tool inspects committed content without changing the worktree. It supports:

- `search` — literal or extended-regexp search at a ref, optionally scoped by path
- `read` — line-numbered reads from a file at a ref
- `diff` — bounded diffs between two refs

Every ref is resolved to a commit hash. Results are capped at 500 rows and 30KB per call and expose a `nextOffset` for pagination, so PR archaeology does not flood the model context.

### Subagent model routing

The `subagent` tool keeps delegation inside the parent session's model family. Existing `model` values remain the default for parents in the same family. Add optional `modelRoutes` to an agent's frontmatter to choose a role-specific model for Claude or Grok parents:

```yaml
---
name: planner
description: Plan implementation
model: openai-codex/gpt-5.6-sol
modelRoutes:
  claude: anthropic/claude-opus-5
  grok: xai/grok-4.6
thinking: high
---
```

Routing keys can be model families (`gpt`, `claude`, `grok`) or exact Pi providers such as `anthropic`, `xai`, or `grok-cli`. Exact provider routes take precedence. When a parent belongs to another family and no route is configured, the subagent inherits the parent's exact model instead of crossing back to the configured GPT model. Explicit GPT models therefore continue to be used for GPT parent sessions.

Model-visible subagent output is capped at 12 KiB per single/chain final result and for the complete parallel aggregate, including its header and separators. When capped, the beginning and end are retained, and the marker includes an absolute path to a temporary artifact under the system temp directory containing the complete final output; the parent model can recover it with the `read` tool. Streaming updates do not create artifacts. Complete messages remain in `details.results`, so Ctrl+O can still show the full output.

Child agents persist a Pi session (`--session-id`, not `--no-session`) so a stall can be inspected later. The parent shows a heartbeat while the child is running, including live `tool_execution_start` events. Each child is killed after `timeout_seconds` (default 1800) and returns `session_id` with the failure instead of blocking the parent indefinitely.

`herdr-agent-state.ts` is intentionally not included because herdr owns and regenerates that file.

## Use from any clone

Clone the repository wherever you want, then install its dependencies and register the clone as a Pi package:

```bash
git clone https://github.com/sorafujitani/pi-extension.git /path/to/pi-extension
cd /path/to/pi-extension
vp install
vp config
vp check
vp test
pi install "$PWD"
```

`pi install "$PWD"` registers the absolute clone path in the global Pi settings. The package manifest uses paths relative to the repository, so the clone location is arbitrary.

For a project-local installation, add `-l`:

```bash
pi install -l "$PWD"
```

Pi can also install the repository directly without a manual clone:

```bash
pi install git:github.com/sorafujitani/pi-extension
```

After changing an installed local clone, run `/reload` in Pi.

### Usage metrics

Use `/usage` to toggle a detailed report containing:

- rolling 60-second requests, prompt tokens, uncached input, cache reads, output, and largest request;
- session-wide totals across all entries, including compaction and summary requests;
- the latest request's provider/model and token split;
- current context-window usage;
- provider response health for the current session: 429/5xx counts, retry-after, and token reset headers when exposed.

The rolling window is a measurement aid, not a provider quota calculation: cache-read tokens may be treated differently by each provider. Use provider dashboards and `Retry-After`/remaining-quota headers for authoritative limits.

## Herdr autoscale

`herdr-autoscale.ts` は `HERDR_ENV=1` の親 TUI/RPC セッションだけで有効になり、`PANOPTICON_CHILD=1` の child agent では再帰的に有効化されません。`HERDR_AUTOSCALE=0` を設定すると完全に無効になります。追加の settings 編集は不要です。

内部は composition root/lifecycle/dispatcher の `herdr-autoscale.ts` と、純粋な `contract.ts`（schema・compact・exit/status contract）、`backend.ts`（Panopticon の唯一の `FlowBackend` 実装）、`session.ts`（persisted state・ownership）、`policy.ts`（環境・explicit-only・tool guard）に分かれています。新しい backend は `FlowBackend` を直接実装し、registry・自動探索・未使用 hook は追加しません。通常ターンの hot path に I/O を置かず、subprocess は tool action と active-run reconciliation に限定します。

`herdr_orchestrate start` の explicit authorization は 1 ユーザープロンプトにつき 1 回の試行だけを許可します。CLI 失敗や repository mismatch の後も、同じ prompt では再試行できず、新しい明示的ユーザー依頼が必要です。

`herdr_orchestrate start` は explicit-only です（"autoscale" という名前に反して、何も自動では始まりません）。親 Pi は自分の判断で run を開始せず、ユーザーが panopticon の実行を明示的に依頼した場合（panopticon agent skill 経由、または panopticon / herdr を名指しした依頼）にだけ `start` を呼びます。タスクが複数 step でも自動委譲はしません。prompt 誘導に加えて、同じ名指し条件を tool 側でも強制する二重化として、直近のユーザー prompt に panopticon / herdr が含まれないターンでは `start` はエラーになります（単語一致であり意図判定ではありません。status / wait / cancel は対象外）。また親セッションの bash からの `panopticon start` / `panopticon cancel` 直叩きは tool_call guard がブロックし、`herdr_orchestrate` tool へ誘導します。`start` 後は親が同じ repository を編集せず、`wait` の compact JSON を確認して最終報告します。Herdr の専用 worktree と child agent が実作業を担当します。

```text
/herdr-auto status
/herdr-auto on
/herdr-auto off
```

`/herdr-auto` の toggle、直近 `start` の `latestRunId`/`latestRepo`、実行中 run の `activeRunId`/`activeRepo` は session custom entry に保存され、branch ごとに復元されます。`herdr_orchestrate` の `status` / `wait` / `cancel` は、`run_id` を省略すると `activeRunId`（あれば）または `latestRunId` を使い、保存済み repository と現在の `cwd` が `path.resolve` で一致する場合に限り実行します。`run_id` を明示する場合も、この session の `latestRunId`/`latestRepo` の ownership pair が完全であることを要求し、cwd が異なっても CLI応答の repository を必須として `latestRepo` と照合します（`start` も同様です）。保存値がない場合や repository が一致しない場合は明示エラーになり、panopticon のグローバル最新 run へ fallback しません。実行中 run の変更可能な `write`/`edit`/`bash`/`subagent`/`ast_grep_replace` は全面的にブロックされ、run の観測には `herdr_orchestrate status` / `herdr_orchestrate wait` を使います。guard は `session_tree` による branch 切替後も status を再確認し、terminal な結果を受け取った場合は active state を clear/persist するまで維持され、active state の復元時は `activeRunId`/`activeRepo` と `latestRunId`/`latestRepo` の run/repo 組が `path.resolve` で一致することを検証し、現在の `cwd` は条件にしません。`start` のCLI応答にも repository を必須とし、要求先との一致を検証します。実行中 run は `herdr_orchestrate wait` または `cancel` で制御します。off は新規 `start` とガイダンスだけを無効にし、既存 run の status/wait/cancel と guard は維持します。`wait` の `interval_seconds` は 0.2〜30 秒です。tool cancellation は監視だけを中断し、run 自体は cancel しません。

`panopticon` が PATH にない、Herdr 管理外で CLI が失敗する、または CLI が不正な結果を返す場合は、tool が理由を bounded error として返します。親 Pi は start を無限再試行せず、通常の作業へ fallback できます。`workflow: "default"` はグローバル workflow 名 `standard` に読み替えます。

## Pi 1.0

Development dependencies target Pi 1.0. Keep its built-in Codemode, MCP, and tool-search extensions enabled.
`defaultTools: ["+codemode", "+tool_search"]` enables the script and discovery tools alongside the default tools.
MCP servers use `~/.pi/agent/mcp.json`; no custom MCP extension is needed.

Pi owns automatic compaction, continuation after compaction, and prompt-cache warming.
Keep these native paths enabled; `/compact`, `/tree`, and `/session` provide the built-in controls.
`/usage` adds a rolling rate window and includes native `usage` entries without counting them as conversation turns.

`pi-btw@0.7.1` supports Pi 1.0 and seeds the child session through `SessionManager`; no local patch is needed.
Install `./node_modules/pi-btw` as a separate local Pi package to load its extension and skill.
Do not also install a second copy from npm.

## Development

Vite+ provides the package manager and unified validation commands. `vp check` runs Oxfmt, Oxlint, and type checks; `vp test` runs the Vitest-compatible test suite.

```bash
vp install
vp check
vp test
```

The extensions are loaded directly by Pi, so this project intentionally has no build step.
