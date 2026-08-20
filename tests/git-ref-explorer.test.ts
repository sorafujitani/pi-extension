import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  createBoundedGitExecutor,
  type GitExecutor,
  runGitRefExplorer,
} from "../extensions/git-ref-explorer.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

type GitFixture = {
  directory: string;
  baseRef: string;
  headRef: string;
  literalPath: string;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function runGitSetup(directory: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: directory,
    encoding: "utf8",
  });
  return result.stdout;
}

async function createGitFixture(includeLargeFile = false): Promise<GitFixture> {
  const directory = await mkdtemp(join(tmpdir(), "git-ref-explorer-test-"));
  temporaryDirectories.push(directory);

  const literalPath = "docs/[guide].md";
  await mkdir(join(directory, "docs"), { recursive: true });
  await runGitSetup(directory, ["init", "--quiet"]);
  await runGitSetup(directory, ["config", "user.name", "Git Ref Explorer Test"]);
  await runGitSetup(directory, ["config", "user.email", "git-ref-explorer@example.test"]);

  await writeFile(
    join(directory, "README.md"),
    "# pi-extension\nline two\nline three\nline four\n",
  );
  await writeFile(join(directory, "package.json"), '{"version":1}\n');
  await writeFile(join(directory, literalPath), "needle in literal path\n");
  await writeFile(join(directory, "docs", "g.md"), "not target\n");
  await runGitSetup(directory, ["add", "--all"]);
  await runGitSetup(directory, ["commit", "--quiet", "--message", "base"]);
  const baseRef = (await runGitSetup(directory, ["rev-parse", "HEAD"])).trim();

  await writeFile(join(directory, "package.json"), '{"version":2}\n');
  await writeFile(join(directory, literalPath), "needle in literal path\nchanged\n");
  if (includeLargeFile) {
    await writeFile(join(directory, "large.txt"), "x".repeat(300 * 1024));
  }
  await runGitSetup(directory, ["add", "--all"]);
  await runGitSetup(directory, ["commit", "--quiet", "--message", "head"]);
  const headRef = (await runGitSetup(directory, ["rev-parse", "HEAD"])).trim();

  return { directory, baseRef, headRef, literalPath };
}

describe("git ref explorer", () => {
  it("searches committed content and reports source lines", async () => {
    const fixture = await createGitFixture();
    const result = await runGitRefExplorer(
      { action: "search", ref: fixture.headRef, query: "# pi-extension", path: "README.md" },
      createBoundedGitExecutor(fixture.directory),
    );

    expect(result.text).toContain("README.md:1:# pi-extension");
    expect(result.details).toMatchObject({
      action: "search",
      path: "README.md",
      totalLines: 1,
      returnedLines: 1,
    });
    expect(result.details.ref).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reads a bounded line range from a historical file", async () => {
    const fixture = await createGitFixture();
    const exec = createBoundedGitExecutor(fixture.directory);
    const first = await runGitRefExplorer(
      { action: "read", ref: fixture.headRef, path: "README.md", startLine: 2, limit: 2 },
      exec,
    );

    expect(first.text).toContain("2\t");
    expect(first.details).toMatchObject({
      action: "read",
      offset: 0,
      returnedLines: 2,
      nextOffset: 2,
    });

    const second = await runGitRefExplorer(
      {
        action: "read",
        ref: fixture.headRef,
        path: "README.md",
        startLine: 2,
        offset: first.details.nextOffset,
        limit: 1,
      },
      exec,
    );
    expect(second.text).toContain("4\t");
  });

  it("diffs two fixture refs with pagination metadata", async () => {
    const fixture = await createGitFixture();
    const result = await runGitRefExplorer(
      {
        action: "diff",
        baseRef: fixture.baseRef,
        headRef: fixture.headRef,
        path: "package.json",
        limit: 3,
      },
      createBoundedGitExecutor(fixture.directory),
    );

    expect(result.text).toContain("diff --git");
    expect(result.details.action).toBe("diff");
    expect(result.details.returnedLines).toBeLessThanOrEqual(3);
  });

  it("treats search and diff paths as literal pathspecs", async () => {
    const fixture = await createGitFixture();
    const exec = createBoundedGitExecutor(fixture.directory);

    const search = await runGitRefExplorer(
      {
        action: "search",
        ref: fixture.headRef,
        query: "needle",
        path: fixture.literalPath,
      },
      exec,
    );
    expect(search.text).toContain("needle in literal path");
    expect(search.text).not.toContain("not target");

    const diff = await runGitRefExplorer(
      {
        action: "diff",
        baseRef: fixture.baseRef,
        headRef: fixture.headRef,
        path: fixture.literalPath,
      },
      exec,
    );
    expect(diff.text).toContain("+changed");
  });

  it("rejects traversal paths before invoking git", async () => {
    let called = false;
    const spy: GitExecutor = async () => {
      called = true;
      return { stdout: "", stderr: "", code: 0 };
    };

    await expect(
      runGitRefExplorer({ action: "read", path: "../secret", ref: "HEAD" }, spy),
    ).rejects.toThrow("repository-relative");
    expect(called).toBe(false);
  });

  it("rejects unknown refs with a focused error", async () => {
    const fixture = await createGitFixture();
    await expect(
      runGitRefExplorer(
        { action: "read", path: "README.md", ref: "definitely-missing" },
        createBoundedGitExecutor(fixture.directory),
      ),
    ).rejects.toThrow("Unknown or non-commit Git ref");
  });

  it("rejects output over the Git buffer limit with a path hint", async () => {
    const fixture = await createGitFixture(true);
    await expect(
      runGitRefExplorer(
        { action: "read", ref: fixture.headRef, path: "large.txt" },
        createBoundedGitExecutor(fixture.directory),
      ),
    ).rejects.toThrow(/Git output exceeded .*path=large\.txt/);
  });

  it("does not return partial output when aborting after an exec", async () => {
    const controller = new AbortController();
    const hash = "a".repeat(40);
    let commandCount = 0;
    const abortingExec: GitExecutor = async (_command, args) => {
      commandCount++;
      if (args[0] === "rev-parse") {
        return { stdout: `${hash}\n`, stderr: "", code: 0 };
      }
      controller.abort();
      return { stdout: `${hash}:README.md:1:partial\n`, stderr: "", code: 0 };
    };

    await expect(
      runGitRefExplorer(
        { action: "search", ref: "HEAD", query: "partial", path: "README.md" },
        abortingExec,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(commandCount).toBe(2);
  });

  it("does not split a surrogate pair when truncating UTF-8 output", async () => {
    const hash = "b".repeat(40);
    const line = `${"a".repeat(8184)}😀x😀`;
    const fakeExec: GitExecutor = async (_command, args) => {
      if (args[0] === "rev-parse") {
        return { stdout: `${hash}\n`, stderr: "", code: 0 };
      }
      return { stdout: `${line}\n`, stderr: "", code: 0 };
    };

    const result = await runGitRefExplorer(
      { action: "read", ref: "HEAD", path: "emoji.txt" },
      fakeExec,
    );

    expect(result.text).toContain("…");
    expect(Buffer.from(result.text, "utf8").toString("utf8")).toBe(result.text);
  });
});
