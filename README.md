# pi-extension

Personal extensions for the [pi](https://pi.dev) coding agent.

## Included extensions

- `atlantis-brain.js` — Atlantis context, metrics, and handoff integration
- `git-ref-explorer.ts` — bounded search, reads, and diffs across historical Git refs
- `input-panel.ts` — model, thinking, context, rolling rate-window, and working-directory panel
- `lazy-tools.ts` — configuration-driven lazy tool groups with URL/pattern activation and session persistence
- `session-usage.ts` — session token and turn usage summaries plus the `/usage` rolling metrics report
- `subagent/` — isolated subagents with parent-model-family routing

## Lazy tool groups

`lazy-tools.ts` keeps configured tool groups out of the initial active-tool list and exposes both the `activate_tool_groups` tool and `/lazy-tools` commands:

```text
/lazy-tools status
/lazy-tools activate web
/lazy-tools reset
```

The built-in `web` group contains `web_search`, `source_check`, `fetch_content`, and `get_search_content`. A URL automatically activates it. Additional groups can be configured globally at `~/.pi/agent/lazy-tools.json` and, when the project is trusted, at `.pi/lazy-tools.json`:

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

The input panel shows the active branch's last-60-second request count, full prompt volume, uncached input, output, session cache rate, and session total. Use `/usage` to toggle a detailed report containing:

- rolling 60-second requests, prompt tokens, uncached input, cache reads, output, and largest request;
- session-wide totals across all entries, including compaction and summary requests;
- the latest request's provider/model and token split;
- current context-window usage;
- provider response health for the current session: 429/5xx counts, retry-after, and token reset headers when exposed.

The rolling window is a measurement aid, not a provider quota calculation: cache-read tokens may be treated differently by each provider. Use provider dashboards and `Retry-After`/remaining-quota headers for authoritative limits.

## Development

Vite+ provides the package manager and unified validation commands. `vp check` runs Oxfmt, Oxlint, and type checks; `vp test` runs the Vitest-compatible test suite.

```bash
vp install
vp check
vp test
```

The extensions are loaded directly by Pi, so this project intentionally has no build step.
