import { resolve } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  HERDR_AUTOSCALE_STATE_ENTRY,
  isRecord,
  trimmedString,
  type HerdrAutoscaleState,
} from "./contract.js";

export type LatestOwnership = HerdrAutoscaleState & {
  latestRunId: string;
  latestRepo: string;
};

export function restoreHerdrAutoscaleState(
  entries: readonly SessionEntry[],
): HerdrAutoscaleState | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== HERDR_AUTOSCALE_STATE_ENTRY) {
      continue;
    }
    if (!isRecord(entry.data)) continue;

    const next: HerdrAutoscaleState = {
      enabled: typeof entry.data.enabled === "boolean" ? entry.data.enabled : true,
    };
    const latestRunId = trimmedString(entry.data.latestRunId);
    const latestRepo = trimmedString(entry.data.latestRepo);
    const activeRunId = trimmedString(entry.data.activeRunId);
    const activeRepo = trimmedString(entry.data.activeRepo);
    if (latestRunId) next.latestRunId = latestRunId;
    if (latestRepo) next.latestRepo = latestRepo;
    if (activeRunId && activeRepo) {
      next.activeRunId = activeRunId;
      next.activeRepo = activeRepo;
    }
    return next;
  }

  return undefined;
}

export function resolveRepoPath(repo: string | undefined, cwd: string): string {
  const base = resolve(cwd);
  return repo ? resolve(base, repo) : base;
}

export function sameResolvedRepo(
  leftRepo: string,
  rightRepo: string,
  cwd = process.cwd(),
): boolean {
  return resolveRepoPath(leftRepo, cwd) === resolveRepoPath(rightRepo, cwd);
}

export function sameRepo(cwd: string, savedRepo: string): boolean {
  return resolveRepoPath(undefined, cwd) === resolveRepoPath(savedRepo, cwd);
}

export function hasLatestOwnership(state: HerdrAutoscaleState): state is LatestOwnership {
  return Boolean(
    typeof state.latestRunId === "string" &&
    state.latestRunId.length > 0 &&
    typeof state.latestRepo === "string" &&
    state.latestRepo.length > 0,
  );
}

export function hasMatchingActiveOwnership(
  state: HerdrAutoscaleState,
  cwd = process.cwd(),
): boolean {
  return Boolean(
    hasLatestOwnership(state) &&
    state.activeRunId &&
    state.activeRepo &&
    state.activeRunId === state.latestRunId &&
    sameResolvedRepo(state.activeRepo, state.latestRepo, cwd),
  );
}

export function ownsActiveRun(
  state: HerdrAutoscaleState,
  runId: string,
  repo: string,
  cwd = process.cwd(),
): boolean {
  if (
    !hasLatestOwnership(state) ||
    !state.activeRunId ||
    !state.activeRepo ||
    state.activeRunId !== state.latestRunId ||
    !sameResolvedRepo(state.activeRepo, state.latestRepo, cwd)
  ) {
    return false;
  }
  return state.activeRunId === runId && sameResolvedRepo(repo, state.latestRepo, cwd);
}
