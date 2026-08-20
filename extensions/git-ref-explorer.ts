import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_LIMIT = 120;
const MAX_LIMIT = 500;
const MAX_OUTPUT_BYTES = 30 * 1024;
const MAX_LINE_BYTES = 8 * 1024;
const MAX_GIT_BUFFER_BYTES = 256 * 1024;
const GIT_TIMEOUT_MS = 10_000;

type Action = "search" | "read" | "diff";

export type GitRefExplorerParams = {
  action: Action;
  ref?: string;
  baseRef?: string;
  headRef?: string;
  query?: string;
  path?: string;
  fixed?: boolean;
  startLine?: number;
  offset?: number;
  limit?: number;
  context?: number;
};

type ExecResult = {
  stdout: string;
  stderr: string;
  code: number | null;
};

export type GitExecutor = (
  command: string,
  args: string[],
  options?: { signal?: AbortSignal },
) => Promise<ExecResult>;

type ChildProcessError = Error & {
  code?: string | number | null;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
};

type GitExecutionLimit = "maxBuffer" | "timeout";

class GitExecutionLimitError extends Error {
  constructor(
    readonly limit: GitExecutionLimit,
    message: string,
  ) {
    super(message);
    this.name = "GitExecutionLimitError";
  }
}

const execFileAsync = promisify(execFile);

export function createBoundedGitExecutor(cwd: string): GitExecutor {
  return async (command, args, options) => {
    try {
      const result = await execFileAsync(command, args, {
        cwd,
        encoding: "utf8",
        maxBuffer: MAX_GIT_BUFFER_BYTES,
        timeout: GIT_TIMEOUT_MS,
        signal: options?.signal,
      });
      return {
        stdout: toText(result.stdout),
        stderr: toText(result.stderr),
        code: 0,
      };
    } catch (error) {
      if (isAbortError(error)) throw error;
      const failure = error as ChildProcessError;
      if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        throw new GitExecutionLimitError(
          "maxBuffer",
          `Git output exceeded the ${MAX_GIT_BUFFER_BYTES}-byte buffer limit`,
        );
      }
      if (failure.killed && failure.signal === "SIGTERM") {
        throw new GitExecutionLimitError(
          "timeout",
          `Git command exceeded the ${GIT_TIMEOUT_MS}ms timeout`,
        );
      }
      return {
        stdout: toText(failure.stdout),
        stderr: toText(failure.stderr),
        code: typeof failure.code === "number" ? failure.code : null,
      };
    }
  };
}

export type GitRefExplorerDetails = {
  action: Action;
  ref?: string;
  baseRef?: string;
  headRef?: string;
  path?: string;
  query?: string;
  totalLines: number;
  offset: number;
  returnedLines: number;
  nextOffset?: number;
};

type ExplorerResult = {
  text: string;
  details: GitRefExplorerDetails;
};

const Parameters = Type.Object({
  action: StringEnum(["search", "read", "diff"] as const, {
    description: "search text at a ref, read a file at a ref, or diff two refs",
  }),
  ref: Type.Optional(Type.String({ description: "Git ref for search/read (default: HEAD)" })),
  baseRef: Type.Optional(Type.String({ description: "Base Git ref for diff" })),
  headRef: Type.Optional(Type.String({ description: "Head Git ref for diff (default: HEAD)" })),
  query: Type.Optional(Type.String({ description: "Pattern required by search" })),
  path: Type.Optional(
    Type.String({ description: "Repository-relative file or directory to limit the operation" }),
  ),
  fixed: Type.Optional(
    Type.Boolean({ description: "Treat search query as a literal string (default: true)" }),
  ),
  startLine: Type.Optional(
    Type.Integer({ minimum: 1, description: "First source line for read (default: 1)" }),
  ),
  offset: Type.Optional(
    Type.Integer({ minimum: 0, description: "Zero-based result offset for pagination" }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_LIMIT,
      description: `Maximum rows (default: ${DEFAULT_LIMIT})`,
    }),
  ),
  context: Type.Optional(
    Type.Integer({ minimum: 0, maximum: 20, description: "Diff context lines (default: 3)" }),
  ),
});

export async function runGitRefExplorer(
  params: GitRefExplorerParams,
  exec: GitExecutor,
  signal?: AbortSignal,
): Promise<ExplorerResult> {
  signal?.throwIfAborted();
  const path = normalizePath(params.path);
  const limit = params.limit ?? DEFAULT_LIMIT;
  const offset = params.offset ?? 0;

  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`limit must be between 1 and ${MAX_LIMIT}`);
  }
  if (!Number.isInteger(offset) || offset < 0) throw new Error("offset must be zero or greater");

  if (params.action === "search") {
    if (!params.query) throw new Error("query is required for search");
    const ref = await resolveCommit(params.ref ?? "HEAD", exec, signal, path);
    const args = [
      "grep",
      "--line-number",
      "--full-name",
      "--no-color",
      "-I",
      params.fixed === false ? "--extended-regexp" : "--fixed-strings",
      "-e",
      params.query,
      ref,
    ];
    if (path) args.push("--", literalPathspec(path));

    const result = await executeGit(exec, "git", args, signal, path);
    if (result.code !== 0 && result.code !== 1) throw gitError("git grep", result);
    const prefix = `${ref}:`;
    const lines = splitOutput(result.stdout).map((line) =>
      line.startsWith(prefix) ? line.slice(prefix.length) : line,
    );
    return formatResult(lines, offset, limit, {
      action: "search",
      ref,
      path,
      query: params.query,
    });
  }

  if (params.action === "read") {
    if (!path) throw new Error("path is required for read");
    const ref = await resolveCommit(params.ref ?? "HEAD", exec, signal, path);
    const result = await executeGit(exec, "git", ["show", `${ref}:${path}`], signal, path);
    if (result.code !== 0) throw gitError("git show", result);
    if (result.stdout.includes("\0")) throw new Error(`Cannot read binary file: ${path}`);

    const startLine = params.startLine ?? 1;
    if (!Number.isInteger(startLine) || startLine < 1) {
      throw new Error("startLine must be 1 or greater");
    }
    const sourceLines = splitFile(result.stdout);
    const numbered = sourceLines.map((line, index) => `${index + 1}\t${line}`);
    return formatResult(numbered.slice(startLine - 1), offset, limit, {
      action: "read",
      ref,
      path,
    });
  }

  if (params.action === "diff") {
    if (!params.baseRef) throw new Error("baseRef is required for diff");
    const baseRef = await resolveCommit(params.baseRef, exec, signal, path);
    const headRef = await resolveCommit(params.headRef ?? "HEAD", exec, signal, path);
    const context = params.context ?? 3;
    if (!Number.isInteger(context) || context < 0 || context > 20) {
      throw new Error("context must be between 0 and 20");
    }

    const args = ["diff", "--no-ext-diff", "--no-color", `--unified=${context}`, baseRef, headRef];
    if (path) args.push("--", literalPathspec(path));
    const result = await executeGit(exec, "git", args, signal, path);
    if (result.code !== 0) throw gitError("git diff", result);
    return formatResult(splitOutput(result.stdout), offset, limit, {
      action: "diff",
      baseRef,
      headRef,
      path,
    });
  }

  throw new Error(`Unsupported action: ${String(params.action)}`);
}

async function resolveCommit(
  ref: string,
  exec: GitExecutor,
  signal?: AbortSignal,
  path?: string,
): Promise<string> {
  if (!ref.trim()) throw new Error("Git ref cannot be empty");
  const result = await executeGit(
    exec,
    "git",
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
    signal,
    path,
  );
  const hash = result.stdout.trim();
  if (result.code !== 0 || !/^[0-9a-f]{40,64}$/i.test(hash)) {
    throw new Error(`Unknown or non-commit Git ref: ${ref}`);
  }
  return hash;
}

function normalizePath(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const normalized = path.replace(/^@/, "").replace(/^\.\//, "");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    normalized.split(/[\\/]/).includes("..")
  ) {
    throw new Error(`path must be repository-relative without '..': ${path}`);
  }
  return normalized;
}

function literalPathspec(path: string): string {
  return `:(literal)${path}`;
}

function splitOutput(output: string): string[] {
  if (output.length === 0) return [];
  return output.replace(/\n$/, "").split("\n");
}

function splitFile(output: string): string[] {
  const lines = output.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function formatResult(
  lines: string[],
  offset: number,
  limit: number,
  metadata: Omit<GitRefExplorerDetails, "totalLines" | "offset" | "returnedLines" | "nextOffset">,
): ExplorerResult {
  const selected = lines.slice(offset, offset + limit);
  const output: string[] = [];
  let bytes = 0;

  for (const rawLine of selected) {
    const line = truncateUtf8(rawLine, MAX_LINE_BYTES);
    const lineBytes = Buffer.byteLength(line) + (output.length > 0 ? 1 : 0);
    if (output.length > 0 && bytes + lineBytes > MAX_OUTPUT_BYTES) break;
    output.push(line);
    bytes += lineBytes;
  }

  const nextOffset = offset + output.length < lines.length ? offset + output.length : undefined;
  const details: GitRefExplorerDetails = {
    ...metadata,
    totalLines: lines.length,
    offset,
    returnedLines: output.length,
    nextOffset,
  };

  const provenance = formatProvenance(details);
  const body = output.length > 0 ? output.join("\n") : "No matching content.";
  const pagination =
    nextOffset === undefined
      ? `Showing ${output.length} of ${lines.length} lines.`
      : `Showing ${offset + 1}-${offset + output.length} of ${lines.length} lines; continue with offset=${nextOffset}.`;

  return { text: `${provenance}\n${pagination}\n\n${body}`, details };
}

function formatProvenance(details: GitRefExplorerDetails): string {
  const path = details.path ? ` path=${details.path}` : "";
  if (details.action === "diff") {
    return `diff ${details.baseRef}..${details.headRef}${path}`;
  }
  return `${details.action} ref=${details.ref}${path}`;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  const suffix = "…";
  const target = maxBytes - Buffer.byteLength(suffix);
  const retained: string[] = [];
  let bytes = 0;
  for (const codePoint of value) {
    const codePointBytes = Buffer.byteLength(codePoint, "utf8");
    if (bytes + codePointBytes > target) break;
    bytes += codePointBytes;
    retained.push(codePoint);
  }
  return `${retained.join("")}${suffix}`;
}

async function executeGit(
  exec: GitExecutor,
  command: string,
  args: string[],
  signal?: AbortSignal,
  path?: string,
): Promise<ExecResult> {
  signal?.throwIfAborted();
  try {
    const result = await exec(command, args, { signal });
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof GitExecutionLimitError) {
      const pathHint = path
        ? ` Narrow the request with path=${path}.`
        : " Narrow the request with the path parameter.";
      throw new Error(`${error.message}.${pathHint}`, { cause: error });
    }
    throw error;
  }
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || (error as ChildProcessError).code === "ABORT_ERR")
  );
}

function toText(value: string | Buffer | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : value.toString("utf8");
}

function gitError(operation: string, result: ExecResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${String(result.code)}`;
  return new Error(`${operation} failed: ${detail}`);
}

export default function gitRefExplorer(pi: ExtensionAPI) {
  pi.registerTool({
    name: "git_ref_explorer",
    label: "Git Ref Explorer",
    description:
      "Search, read, or diff committed Git content at arbitrary refs without changing the worktree. Results include resolved commit hashes, source line numbers where applicable, and bounded pagination (maximum 500 rows and 30KB per call).",
    promptSnippet: "Search, read, or diff historical Git refs with bounded output",
    promptGuidelines: [
      "Use git_ref_explorer instead of bash pipelines such as git show | sed or git grep when inspecting committed content at historical refs.",
      "Narrow git_ref_explorer with path and continue using offset rather than requesting broad repeated Git output.",
    ],
    parameters: Parameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await runGitRefExplorer(params, createBoundedGitExecutor(ctx.cwd), signal);
      return {
        content: [{ type: "text", text: result.text }],
        details: result.details,
      };
    },
  });
}
