# pi-extension

Personal extensions for the [pi](https://pi.dev) coding agent.

## Included extensions

- `atlantis-brain.js` — Atlantis context, metrics, and handoff integration
- `input-panel.ts` — model, thinking, context, session, and working-directory panel
- `session-usage.ts` — session token and turn usage summaries

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

## Development

Vite+ provides the package manager and unified validation commands. `vp check` runs Oxfmt, Oxlint, and type checks; `vp test` runs the Vitest-compatible test suite.

```bash
vp install
vp check
vp test
```

The extensions are loaded directly by Pi, so this project intentionally has no build step.
