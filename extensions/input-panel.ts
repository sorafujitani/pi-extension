import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  collectSessionUsage,
  formatSessionUsageCompact,
  formatSessionUsageTotal,
} from "./session-usage.js";

type ThinkingColor =
  | "thinkingOff"
  | "thinkingMinimal"
  | "thinkingLow"
  | "thinkingMedium"
  | "thinkingHigh"
  | "thinkingXhigh"
  | "thinkingMax";

const THINKING_COLORS: Record<string, ThinkingColor> = {
  off: "thinkingOff",
  minimal: "thinkingMinimal",
  low: "thinkingLow",
  medium: "thinkingMedium",
  high: "thinkingHigh",
  xhigh: "thinkingXhigh",
  max: "thinkingMax",
};
const ANSI_ESCAPE_PATTERN = new RegExp(String.fromCharCode(0x1b) + "\\[[0-?]*[ -/]*[@-~]", "g");

function formatTokens(count: number): string {
  if (count < 1_000) return `${count}`;
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 1 : 0)}M`;
}

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
  const thinkingColor = THINKING_COLORS[thinking] ?? "thinkingOff";
  const separator = theme.fg("borderMuted", "  ·  ");
  const sessionUsage = collectSessionUsage(ctx.sessionManager.getEntries());
  const prefixSegments = [
    theme.fg("accent", model),
    theme.fg(thinkingColor, `◐ ${thinking}`),
    theme.fg("text", contextLabel(ctx)),
  ];
  const cwdSegment = theme.fg("muted", `⌂ ${formatCwd(ctx.cwd)}`);
  const buildContent = (sessionLabel: string): string =>
    `─ ${[...prefixSegments, theme.fg("muted", sessionLabel), cwdSegment].join(separator)} `;

  let content = buildContent(formatSessionUsageCompact(sessionUsage));
  if (visibleWidth(content) > width) {
    content = buildContent(formatSessionUsageTotal(sessionUsage));
  }
  content = truncateToWidth(content, width, "");
  return content + theme.fg("borderMuted", "─".repeat(Math.max(0, width - visibleWidth(content))));
}

type EditorConstructor = ConstructorParameters<typeof CustomEditor>;

class InputPanelEditor extends CustomEditor {
  constructor(
    tui: EditorConstructor[0],
    theme: EditorConstructor[1],
    keybindings: EditorConstructor[2],
    metadata: (width: number) => string,
  ) {
    super(tui, theme, keybindings);
    this.metadata = metadata;
  }

  private readonly metadata: (width: number) => string;

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

  function apply(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;

    if (!enabled) {
      ctx.ui.setEditorComponent(undefined);
      ctx.ui.setFooter(undefined);
      return;
    }

    ctx.ui.setEditorComponent(
      (tui, editorTheme, keybindings) =>
        new InputPanelEditor(tui, editorTheme, keybindings, (width) =>
          buildTopBorder(width, ctx, ctx.ui.theme),
        ),
    );
    ctx.ui.setFooter(() => ({
      invalidate() {},
      render: () => [],
    }));
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
