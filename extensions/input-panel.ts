import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  collectRecentUsage,
  collectUsageMetrics,
  formatTokens,
  getCacheHitRate,
} from "./session-usage.js";

const ANSI_ESCAPE_PATTERN = new RegExp(String.fromCharCode(0x1b) + "\\[[0-?]*[ -/]*[@-~]", "g");

function formatCwd(cwd: string): string {
  const home = homedir();
  if (cwd === home) return "~";
  if (cwd.startsWith(`${home}/`)) return `~/${cwd.slice(home.length + 1)}`;
  return cwd;
}

function contextLabel(ctx: ExtensionContext): string {
  const usage = ctx.getContextUsage();
  if (!usage) return "context ?";
  const percent = usage.percent === null ? "?" : `${usage.percent.toFixed(1)}%`;
  return `${percent}/${formatTokens(usage.contextWindow)}`;
}

function buildTopBorder(width: number, ctx: ExtensionContext, theme: Theme): string {
  if (width <= 0) return "";

  const model = ctx.model?.id ?? "no-model";
  const thinking = ctx.thinkingLevel ?? "off";
  const separator = theme.fg("borderMuted", "  ·  ");
  const session = collectUsageMetrics(ctx.sessionManager.getEntries());
  const recent = collectRecentUsage(ctx.sessionManager.getBranch());
  const cache = getCacheHitRate(session);
  const windowLabel = recent.requests
    ? `1m ${recent.requests}r in${formatTokens(recent.promptTokens)}/u${formatTokens(recent.uncachedInput)} out${formatTokens(recent.output)}`
    : "1m —";
  const cacheLabel = cache === undefined ? "—" : `${cache.toFixed(1)}%`;
  const prefixSegments = [
    theme.fg("accent", model),
    theme.getThinkingBorderColor(thinking)(`◐ ${thinking}`),
    theme.fg("text", contextLabel(ctx)),
  ];
  const cwdSegment = theme.fg("muted", `⌂ ${formatCwd(ctx.cwd)}`);
  const buildContent = (usageLabel: string): string =>
    `─ ${[...prefixSegments, theme.fg("muted", usageLabel), cwdSegment].join(separator)} `;

  let content = buildContent(
    `${windowLabel} · cache${cacheLabel} · session${formatTokens(session.total)}`,
  );
  if (visibleWidth(content) > width) {
    content = buildContent(`${windowLabel} · c${cacheLabel} · s${formatTokens(session.total)}`);
  }
  content = truncateToWidth(content, width, "");
  return content + theme.fg("borderMuted", "─".repeat(Math.max(0, width - visibleWidth(content))));
}

type EditorConstructor = ConstructorParameters<typeof CustomEditor>;
type EditorFactory = NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;

class InputPanelEditor extends CustomEditor {
  constructor(
    tui: EditorConstructor[0],
    theme: EditorConstructor[1],
    keybindings: EditorConstructor[2],
    private readonly metadata: (width: number) => string,
  ) {
    super(tui, theme, keybindings);
  }

  render(width: number): string[] {
    if (width < 5) return super.render(width);

    const innerWidth = width - 4;
    const lines = super.render(innerWidth);
    const bottomBorder = lines.findIndex((line, index) => {
      if (index === 0) return false;
      const plain = line.replace(ANSI_ESCAPE_PATTERN, "");
      return /^─+$/.test(plain) || plain.startsWith("─── ↓ ");
    });
    if (bottomBorder >= 0) lines.splice(bottomBorder, 1);
    if (lines.length === 0) return [""];

    lines[0] = this.borderColor("╭") + this.metadata(width - 1);
    for (let index = 1; index < lines.length; index++) {
      const prefix = index === 1 ? this.borderColor("╰─") + " " : "   ";
      lines[index] = `${prefix}${lines[index]} `;
    }
    lines.push("");
    return lines;
  }
}

export default function (pi: ExtensionAPI) {
  let enabled = true;
  let panelContext: ExtensionContext | undefined;
  const panelFactory: EditorFactory = (tui, editorTheme, keybindings) =>
    new InputPanelEditor(tui, editorTheme, keybindings, (width) => {
      if (!panelContext) return "";
      return buildTopBorder(width, panelContext, panelContext.ui.theme);
    });

  function apply(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;

    const currentEditorFactory = ctx.ui.getEditorComponent();
    if (!enabled) {
      if (currentEditorFactory === panelFactory) {
        ctx.ui.setEditorComponent(undefined);
      }
      panelContext = undefined;
      return;
    }

    if (currentEditorFactory === panelFactory) {
      panelContext = ctx;
      return;
    }
    // Arbitrary custom editors cannot be safely composed without a delegation contract.
    if (currentEditorFactory) return;

    panelContext = ctx;
    ctx.ui.setEditorComponent(panelFactory);
  }

  pi.on("session_start", (_event, ctx) => apply(ctx));

  pi.registerCommand("input-panel", {
    description: "上部情報付きの入力パネルを切り替える",
    handler: (_args, ctx) => {
      enabled = !enabled;
      apply(ctx);
      ctx.ui.notify(`Input panel ${enabled ? "enabled" : "disabled"}`, "info");
      return Promise.resolve();
    },
  });
}
