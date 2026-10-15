/**
 * Host capability shims.
 *
 * pi and omp-based hosts share the extension API but not all of it: omp drops
 * `CONFIG_DIR_NAME`, `ctx.isProjectTrusted`, and `ctx.mode`. Probe instead of
 * importing or calling directly — a named import of a missing export fails at
 * module link time and takes the whole extension down.
 */

import { homedir } from "node:os";
import { relative, sep } from "node:path";
import * as hostAgent from "@earendil-works/pi-coding-agent";

const DOT_DIR = /^\.[A-Za-z0-9_-]+$/;

/**
 * Project-local config directory name (`.pi`, `.omp`, …). Derived from the
 * agent directory (`~/.pi/agent`, `~/.omp/agent`, `~/.omp/profiles/x/agent`)
 * when the host exports no constant.
 */
export function hostConfigDirName(agentDir: string = hostAgent.getAgentDir()): string {
  if ("CONFIG_DIR_NAME" in hostAgent) {
    const exported = hostAgent.CONFIG_DIR_NAME;
    if (typeof exported === "string" && exported.length > 0) return exported;
  }
  const segment = relative(homedir(), agentDir).split(sep)[0] ?? "";
  return DOT_DIR.test(segment) ? segment : ".omp";
}

/** Hosts without a trust API never get project-local config read for them. */
export function isProjectTrusted(ctx: object): boolean {
  if ("isProjectTrusted" in ctx) {
    const probe = ctx.isProjectTrusted;
    if (typeof probe === "function") return probe.call(ctx) === true;
  }
  return false;
}

/** True for an interactive session, whose startup must never be blocked. */
export function isInteractiveSession(ctx: object): boolean {
  if ("mode" in ctx && typeof ctx.mode === "string") return ctx.mode === "tui";
  return "hasUI" in ctx && ctx.hasUI === true;
}

/** `getAllTools()` yields tool definitions on pi and plain names on omp. */
export function hostToolNames(tools: readonly unknown[]): string[] {
  const names: string[] = [];
  for (const tool of tools) {
    if (typeof tool === "string") {
      names.push(tool);
      continue;
    }
    if (tool && typeof tool === "object" && "name" in tool && typeof tool.name === "string") {
      names.push(tool.name);
    }
  }
  return names;
}
