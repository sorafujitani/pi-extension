import { readFileSync } from "node:fs";
import { join } from "node:path";
import safeRegex from "safe-regex";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const ACTIVATION_TOOL_NAME = "activate_tool_groups";
export const LAZY_TOOLS_STATE_ENTRY = "lazy-tools-state";
export const LAZY_TOOLS_CONFIG_FILE = "lazy-tools.json";
export const DEFAULT_WEB_TOOLS = [
  "web_search",
  "source_check",
  "fetch_content",
  "get_search_content",
] as const;
export const DEFAULT_WEB_URL_PATTERN = String.raw`https?://[^\s<>"']+`;
const MAX_PATTERN_LENGTH = 256;

export interface LazyToolGroupDefinition {
  tools: string[];
  patterns: string[];
}

export interface LazyToolGroup extends LazyToolGroupDefinition {
  regexes: RegExp[];
}

export interface LazyToolsConfigResult {
  groups: Map<string, LazyToolGroup>;
  warnings: string[];
}

export interface LazyToolsState {
  activeGroups: string[];
}

export interface LazyToolsExtensionOptions {
  agentDir?: string;
  configDirName?: string;
}

export interface LazyToolsActivationResult {
  requestedGroups: string[];
  activatedGroups: string[];
  unknownGroups: string[];
  addedTools: string[];
  unavailableTools: string[];
}

export const DEFAULT_GROUPS = new Map<string, LazyToolGroupDefinition>([
  [
    "web",
    {
      tools: [...DEFAULT_WEB_TOOLS],
      patterns: [DEFAULT_WEB_URL_PATTERN],
    },
  ],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function warning(warnings: string[], source: string, message: string): void {
  warnings.push(`${source}: ${message}`);
}

function parseStringList(
  value: unknown,
  field: string,
  source: string,
  warnings: string[],
): string[] {
  const values = typeof value === "string" ? [value] : value;
  if (!Array.isArray(values)) {
    warning(warnings, source, `${field} must be an array of strings`);
    return [];
  }

  const result: string[] = [];
  for (const item of values) {
    if (typeof item !== "string" || item.trim().length === 0) {
      warning(warnings, source, `${field} contains a non-empty string requirement`);
      continue;
    }
    result.push(item.trim());
  }
  return unique(result);
}

function parseGroup(
  name: string,
  raw: unknown,
  source: string,
  warnings: string[],
): LazyToolGroupDefinition | undefined {
  const groupName = name.trim();
  if (!groupName) {
    warning(warnings, source, "group names must not be empty");
    return undefined;
  }

  let toolsValue: unknown;
  let patternsValue: unknown;
  if (Array.isArray(raw)) {
    toolsValue = raw;
  } else if (isRecord(raw)) {
    toolsValue = raw.tools;
    if (raw.patterns !== undefined) patternsValue = raw.patterns;
    else if (raw.triggers !== undefined) patternsValue = raw.triggers;
    else if (raw.match !== undefined) patternsValue = raw.match;
  } else {
    warning(warnings, source, `group ${groupName} must be an object or a tool-name array`);
    return undefined;
  }

  if (toolsValue === undefined) {
    warning(warnings, source, `group ${groupName} is missing tools`);
    return undefined;
  }

  const tools = parseStringList(toolsValue, `group ${groupName}.tools`, source, warnings);
  const validTools = tools.filter((toolName) => {
    if (toolName !== ACTIVATION_TOOL_NAME) return true;
    warning(
      warnings,
      source,
      `group ${groupName}.tools contains reserved tool ${ACTIVATION_TOOL_NAME}; ignored`,
    );
    return false;
  });
  if (validTools.length === 0) {
    warning(warnings, source, `group ${groupName} has no valid tools`);
    return undefined;
  }

  const patterns =
    patternsValue === undefined
      ? []
      : parseStringList(patternsValue, `group ${groupName}.patterns`, source, warnings);
  const validPatterns: string[] = [];
  for (const pattern of patterns) {
    if (pattern.length > MAX_PATTERN_LENGTH) {
      warning(
        warnings,
        source,
        `group ${groupName} has a pattern longer than ${MAX_PATTERN_LENGTH} characters; ignored`,
      );
      continue;
    }
    try {
      new RegExp(pattern);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warning(
        warnings,
        source,
        `group ${groupName} has an invalid pattern ${JSON.stringify(pattern)} (${message})`,
      );
      continue;
    }
    if (!safeRegex(pattern)) {
      warning(
        warnings,
        source,
        `group ${groupName} has an unsafe pattern ${JSON.stringify(pattern)}; ignored`,
      );
      continue;
    }
    validPatterns.push(pattern);
  }

  return { tools: validTools, patterns: validPatterns };
}

export function parseLazyToolsConfig(
  value: unknown,
  source = LAZY_TOOLS_CONFIG_FILE,
): { groups: Map<string, LazyToolGroupDefinition>; warnings: string[] } {
  const warnings: string[] = [];
  const groups = new Map<string, LazyToolGroupDefinition>();
  if (!isRecord(value)) {
    warning(warnings, source, "the top level must be an object");
    return { groups, warnings };
  }

  if (value.groups === undefined) return { groups, warnings };
  if (!isRecord(value.groups)) {
    warning(warnings, source, "groups must be an object");
    return { groups, warnings };
  }

  for (const [name, raw] of Object.entries(value.groups)) {
    const group = parseGroup(name, raw, source, warnings);
    if (group) groups.set(name.trim(), group);
  }
  return { groups, warnings };
}

export function mergeLazyToolGroups(
  ...sources: ReadonlyArray<ReadonlyMap<string, LazyToolGroupDefinition>>
): Map<string, LazyToolGroupDefinition> {
  const merged = new Map<string, LazyToolGroupDefinition>();
  for (const source of sources) {
    for (const [name, group] of source) {
      const previous = merged.get(name);
      if (!previous) {
        merged.set(name, {
          tools: [...group.tools],
          patterns: [...group.patterns],
        });
        continue;
      }
      merged.set(name, {
        tools: unique([...previous.tools, ...group.tools]),
        patterns: unique([...previous.patterns, ...group.patterns]),
      });
    }
  }
  return merged;
}

function compileLazyToolGroups(
  groups: ReadonlyMap<string, LazyToolGroupDefinition>,
): Map<string, LazyToolGroup> {
  return new Map(
    [...groups].map(([name, group]) => [
      name,
      {
        tools: [...group.tools],
        patterns: [...group.patterns],
        regexes: group.patterns.map((pattern) => new RegExp(pattern)),
      },
    ]),
  );
}

export function readLazyToolsConfig(path: string): {
  groups: Map<string, LazyToolGroupDefinition>;
  warnings: string[];
} {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parseLazyToolsConfig(value, path);
  } catch (error) {
    const fileError = error as NodeJS.ErrnoException;
    if (fileError.code === "ENOENT") return { groups: new Map(), warnings: [] };
    const message = error instanceof Error ? error.message : String(error);
    return {
      groups: new Map(),
      warnings: [`${path}: ignored invalid configuration (${message})`],
    };
  }
}

export function loadLazyToolGroups(
  agentDir: string,
  cwd: string,
  projectTrusted: boolean,
  configDirName = CONFIG_DIR_NAME,
): LazyToolsConfigResult {
  const global = readLazyToolsConfig(join(agentDir, LAZY_TOOLS_CONFIG_FILE));
  const sources: ReadonlyMap<string, LazyToolGroupDefinition>[] = [DEFAULT_GROUPS, global.groups];
  const warnings = [...global.warnings];

  if (projectTrusted) {
    const project = readLazyToolsConfig(join(cwd, configDirName, LAZY_TOOLS_CONFIG_FILE));
    sources.push(project.groups);
    warnings.push(...project.warnings);
  }

  return {
    groups: compileLazyToolGroups(mergeLazyToolGroups(...sources)),
    warnings,
  };
}

export function matchingLazyToolGroups(
  groups: ReadonlyMap<string, LazyToolGroup>,
  input: string,
): string[] {
  const matches: string[] = [];
  for (const [name, group] of groups) {
    if (
      group.regexes.some((regex) => {
        regex.lastIndex = 0;
        return regex.test(input);
      })
    ) {
      matches.push(name);
    }
  }
  return matches;
}

function isLazyToolsState(value: unknown): value is LazyToolsState {
  return (
    isRecord(value) &&
    Array.isArray(value.activeGroups) &&
    value.activeGroups.every((group) => typeof group === "string")
  );
}

export function latestLazyToolsSnapshot(entries: readonly SessionEntry[]): string[] | undefined {
  let snapshot: string[] | undefined;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== LAZY_TOOLS_STATE_ENTRY) continue;
    if (isLazyToolsState(entry.data)) snapshot = unique(entry.data.activeGroups);
  }
  return snapshot;
}

export function formatLazyToolsStatus(
  groups: ReadonlyMap<string, LazyToolGroup>,
  activeGroups: ReadonlySet<string>,
  registeredTools: ReadonlySet<string>,
): string {
  const active = [...groups.keys()].filter((name) => activeGroups.has(name));
  const inactive = [...groups.keys()].filter((name) => !activeGroups.has(name));
  const lazyTools = unique(
    [...groups.values()]
      .flatMap((group) => group.tools)
      .filter((name) => registeredTools.has(name)),
  );
  return [
    `active: ${active.length > 0 ? active.join(", ") : "(none)"}`,
    `inactive: ${inactive.length > 0 ? inactive.join(", ") : "(none)"}`,
    `registered lazy tools: ${lazyTools.length > 0 ? lazyTools.join(", ") : "(none)"}`,
  ].join("\n");
}

function formatActivationResult(result: LazyToolsActivationResult): string {
  const lines: string[] = [];
  if (result.activatedGroups.length > 0) {
    lines.push(`activated groups: ${result.activatedGroups.join(", ")}`);
  }
  if (result.addedTools.length > 0) lines.push(`added tools: ${result.addedTools.join(", ")}`);
  if (result.unknownGroups.length > 0) {
    lines.push(`unknown groups: ${result.unknownGroups.join(", ")}`);
  }
  if (result.unavailableTools.length > 0) {
    lines.push(`unregistered tools ignored: ${result.unavailableTools.join(", ")}`);
  }
  if (lines.length === 0) lines.push("no changes");
  return lines.join("\n");
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
  ctx.ui.notify(`[lazy-tools] ${message}`, level);
}

export function createLazyToolsExtension(
  pi: ExtensionAPI,
  options: LazyToolsExtensionOptions = {},
): void {
  let groups = new Map<string, LazyToolGroup>();
  let activeGroups = new Set<string>();
  let registeredTools = new Set<string>();

  function refreshRegisteredTools(): void {
    registeredTools = new Set(pi.getAllTools().map((tool) => tool.name));
  }

  function groupTools(groupNames: Iterable<string>): string[] {
    return unique(
      [...groupNames]
        .flatMap((name) => groups.get(name)?.tools ?? [])
        .filter((name) => name !== ACTIVATION_TOOL_NAME && registeredTools.has(name)),
    );
  }

  function allRegisteredGroupTools(): Set<string> {
    return new Set(groupTools(groups.keys()));
  }

  function persistState(): void {
    pi.appendEntry<LazyToolsState>(LAZY_TOOLS_STATE_ENTRY, {
      activeGroups: [...activeGroups],
    });
  }

  function applySessionTools(): void {
    refreshRegisteredTools();
    const current = pi.getActiveTools();
    const groupToolNames = allRegisteredGroupTools();
    const next = unique([
      ...current.filter((name) => !groupToolNames.has(name)),
      ...(registeredTools.has(ACTIVATION_TOOL_NAME) ? [ACTIVATION_TOOL_NAME] : []),
      ...groupTools(activeGroups),
    ]);
    pi.setActiveTools(next);
  }

  function activateGroupNames(requestedNames: readonly string[]): LazyToolsActivationResult {
    refreshRegisteredTools();
    const requestedGroups = unique(requestedNames.map((name) => name.trim()).filter(Boolean));
    const unknownGroups = requestedGroups.filter((name) => !groups.has(name));
    const knownGroups = requestedGroups.filter((name) => groups.has(name));
    const activatedGroups = knownGroups.filter((name) => !activeGroups.has(name));
    const unavailableTools = unique(
      knownGroups.flatMap((name) =>
        (groups.get(name)?.tools ?? []).filter((toolName) => !registeredTools.has(toolName)),
      ),
    );

    for (const name of knownGroups) activeGroups.add(name);

    const current = pi.getActiveTools();
    const toolsToAdd = groupTools(knownGroups).filter((name) => !current.includes(name));
    if (toolsToAdd.length > 0) {
      // Dynamic loading requires this update to be additive.
      pi.setActiveTools(unique([...current, ...toolsToAdd]));
    }
    if (activatedGroups.length > 0) persistState();

    return {
      requestedGroups,
      activatedGroups,
      unknownGroups,
      addedTools: toolsToAdd,
      unavailableTools,
    };
  }

  function resetGroups(): void {
    activeGroups.clear();
    refreshRegisteredTools();
    const groupToolNames = allRegisteredGroupTools();
    const next = [
      ...pi.getActiveTools().filter((name) => !groupToolNames.has(name)),
      ...(registeredTools.has(ACTIVATION_TOOL_NAME) ? [ACTIVATION_TOOL_NAME] : []),
    ];
    pi.setActiveTools(unique(next));
    persistState();
  }

  function restoreFromBranch(ctx: ExtensionContext): void {
    const snapshot = latestLazyToolsSnapshot(ctx.sessionManager.getBranch());
    activeGroups = new Set((snapshot ?? []).filter((name) => groups.has(name)));
    applySessionTools();
  }

  function registerActivationTool(): void {
    const availableGroups = [...groups.keys()].join(", ") || "(none)";
    pi.registerTool({
      name: ACTIVATION_TOOL_NAME,
      label: "Activate Tool Groups",
      description: `Activate one or more configured lazy tool groups. Available groups: ${availableGroups}.`,
      promptSnippet: "Activate configured tool groups when the current tools are not enough",
      promptGuidelines: [
        "Use activate_tool_groups to activate a configured group before calling one of its tools.",
      ],
      parameters: Type.Object({
        groups: Type.Array(Type.String({ minLength: 1 }), {
          minItems: 1,
          description: `Configured group names to activate: ${availableGroups}`,
        }),
      }),
      async execute(_toolCallId, params) {
        const result = activateGroupNames(params.groups);
        return {
          content: [{ type: "text", text: formatActivationResult(result) }],
          details: result,
        };
      },
    });
  }

  pi.registerCommand("lazy-tools", {
    description: "Show or change lazy tool groups: status, activate <groups...>, reset",
    handler: async (args, ctx) => {
      refreshRegisteredTools();
      const words = args.trim().split(/\s+/).filter(Boolean);
      const action = words[0] ?? "status";

      if (action === "status") {
        notify(ctx, formatLazyToolsStatus(groups, activeGroups, registeredTools), "info");
        return;
      }
      if (action === "activate") {
        if (words.length < 2) {
          notify(ctx, "usage: /lazy-tools activate <groups...>", "warning");
          return;
        }
        const result = activateGroupNames(words.slice(1));
        notify(ctx, formatActivationResult(result), "info");
        return;
      }
      if (action === "reset") {
        resetGroups();
        notify(ctx, "all lazy tool groups reset", "info");
        return;
      }

      notify(ctx, "usage: /lazy-tools status | activate <groups...> | reset", "warning");
    },
  });

  let reconciledForSession = false;

  pi.on("session_start", (_event, ctx) => {
    reconciledForSession = false;
    const loaded = loadLazyToolGroups(
      options.agentDir ?? getAgentDir(),
      ctx.cwd,
      ctx.isProjectTrusted(),
      options.configDirName ?? CONFIG_DIR_NAME,
    );
    groups = loaded.groups;
    for (const message of loaded.warnings) notify(ctx, message, "warning");
    registerActivationTool();
    restoreFromBranch(ctx);
  });

  pi.on("before_agent_start", () => {
    if (reconciledForSession) return;
    reconciledForSession = true;
    applySessionTools();
  });

  pi.on("session_tree", (_event, ctx) => {
    restoreFromBranch(ctx);
  });

  pi.on("input", (event, ctx) => {
    const matches = matchingLazyToolGroups(groups, event.text);
    if (matches.length === 0) return { action: "continue" };

    const result = activateGroupNames(matches);
    if (result.activatedGroups.length > 0 && ctx.hasUI) {
      notify(ctx, `auto-activated groups: ${result.activatedGroups.join(", ")}`, "info");
    }
    return { action: "continue" };
  });
}

export default function lazyToolsExtension(pi: ExtensionAPI): void {
  createLazyToolsExtension(pi);
}
