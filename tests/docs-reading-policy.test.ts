import {
  createSyntheticSourceInfo,
  formatSkillsForPrompt,
  type ExtensionAPI,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";
import docsReadingPolicyExtension, {
  compactSkillsForPrompt,
  replacePiDocumentationReadingPolicy,
} from "../extensions/docs-reading-policy.js";

const ORIGINAL_LINES = [
  "- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing",
  "- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)",
] as const;
const REPLACED_LINES = [
  "- When working on pi topics, read only the documentation sections and examples relevant to the task",
  "- For implementation, read the target API, its example, and only the cross-referenced sections needed for the task",
] as const;

function corePrompt(): string {
  return [
    "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
    "- Main documentation: /docs",
    "- Additional docs: /docs",
    "- Examples: /examples (extensions, custom tools, SDK)",
    ...ORIGINAL_LINES,
  ].join("\n");
}

function skill(
  name: string,
  filePath: string,
  description: string,
  disableModelInvocation = false,
): Skill {
  const baseDir = filePath.slice(0, filePath.lastIndexOf("/"));
  return {
    name,
    filePath,
    description,
    baseDir,
    sourceInfo: createSyntheticSourceInfo(filePath, { source: "test" }),
    disableModelInvocation,
  };
}

function compactSkillRows(prompt: string): unknown[][] {
  const startMarker = "<available_skills>\n";
  const endMarker = "\n</available_skills>";
  const start = prompt.indexOf(startMarker);
  const end = prompt.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error("compact skills index not found");

  return prompt
    .slice(start + startMarker.length, end)
    .split("\n")
    .map((line) => JSON.parse(line) as unknown[]);
}

describe("docs reading policy", () => {
  it("replaces only the known built-in block", () => {
    const projectContext = ["\n\n<project_context>", ...ORIGINAL_LINES, "</project_context>"].join(
      "\n",
    );
    const result = replacePiDocumentationReadingPolicy(`${corePrompt()}${projectContext}`);
    const contextStart = result.indexOf("\n\n<project_context>");

    expect(result.slice(0, contextStart)).toContain(REPLACED_LINES[0]);
    expect(result.slice(0, contextStart)).toContain(REPLACED_LINES[1]);
    expect(result.slice(contextStart)).toContain(ORIGINAL_LINES[0]);
    expect(result.slice(contextStart)).toContain(ORIGINAL_LINES[1]);
  });

  it("leaves an unknown or incomplete block unchanged", () => {
    const incomplete = corePrompt().replace(ORIGINAL_LINES[1], "- changed by another version");
    expect(replacePiDocumentationReadingPolicy(incomplete)).toBe(incomplete);
    expect(replacePiDocumentationReadingPolicy("unrelated prompt")).toBe("unrelated prompt");
  });

  it("compacts the exact SDK skills block without losing visible skill data", () => {
    const visible = skill(
      '日本語"<name>\n',
      "/skills/日本語\n/SKILL.md",
      '説明\nquotes " and <xml>& and </available_skills>',
    );
    const hidden = skill("hidden", "/skills/hidden/SKILL.md", "must not appear", true);
    const skills = [visible, hidden];
    const sdkBlock = formatSkillsForPrompt(skills);
    const prompt = `before\n${sdkBlock}\nafter`;

    const result = compactSkillsForPrompt(prompt, skills);

    expect(result).not.toContain(sdkBlock);
    expect(compactSkillRows(result)).toEqual([
      [visible.name, visible.filePath, visible.description],
    ]);
    expect(result).toContain("columns: name, filePath, description");
    expect(result).toContain("use the read tool to load its SKILL.md");
    expect(result).toContain("parent directory of SKILL.md");
    expect(result).not.toContain(hidden.name);
    expect(result).toContain("before\n");
    expect(result).toContain("\nafter");
    expect(result.length).toBeLessThan(prompt.length);
    expect(compactSkillsForPrompt(result, skills)).toBe(result);
  });

  it("leaves unknown, duplicate, empty, and hidden-only blocks unchanged", () => {
    const visible = skill("visible", "/skills/visible/SKILL.md", "visible");
    const sdkBlock = formatSkillsForPrompt([visible]);
    const duplicate = `before${sdkBlock}middle${sdkBlock}after`;

    expect(compactSkillsForPrompt(duplicate, [visible])).toBe(duplicate);
    expect(compactSkillsForPrompt(`before${sdkBlock}after`, [])).toBe(`before${sdkBlock}after`);
    expect(compactSkillsForPrompt("unknown", [visible])).toBe("unknown");
    expect(
      compactSkillsForPrompt("hidden-only", [
        skill("hidden", "/skills/hidden/SKILL.md", "hidden", true),
      ]),
    ).toBe("hidden-only");
  });

  it("composes the policy replacement with the skill index and preserves surrounding text", async () => {
    const skills = [skill("visible", "/skills/visible/SKILL.md", "visible")];
    const sdkBlock = formatSkillsForPrompt(skills);
    const systemPrompt = [
      corePrompt(),
      "contextFiles and AGENTS content",
      sdkBlock,
      "sentence appended by another hook",
    ].join("\n");
    const handlers: Array<(event: unknown) => unknown> = [];
    const pi = {
      on(_event: string, handler: (event: unknown) => unknown) {
        handlers.push(handler);
      },
    } as unknown as ExtensionAPI;

    docsReadingPolicyExtension(pi);
    const handler = handlers[0];
    if (!handler) throw new Error("before_agent_start handler was not registered");

    const result = (await handler({
      systemPrompt,
      systemPromptOptions: { skills },
    })) as { systemPrompt: string } | undefined;
    if (!result) throw new Error("before_agent_start did not return a prompt");

    expect(result.systemPrompt).toBe(
      compactSkillsForPrompt(replacePiDocumentationReadingPolicy(systemPrompt), skills),
    );
    expect(result.systemPrompt).toContain("contextFiles and AGENTS content");
    expect(result.systemPrompt).toContain("sentence appended by another hook");
    expect(result.systemPrompt).toContain(REPLACED_LINES[0]);
  });

  it("does not rewrite a user custom system prompt", async () => {
    const skills = [skill("visible", "/skills/visible/SKILL.md", "visible")];
    const handlers: Array<(event: unknown) => unknown> = [];
    const pi = {
      on(_event: string, handler: (event: unknown) => unknown) {
        handlers.push(handler);
      },
    } as unknown as ExtensionAPI;

    docsReadingPolicyExtension(pi);
    const handler = handlers[0];
    if (!handler) throw new Error("before_agent_start handler was not registered");

    const result = await handler({
      systemPrompt: `${corePrompt()}${formatSkillsForPrompt(skills)}`,
      systemPromptOptions: { customPrompt: corePrompt(), skills },
    });
    expect(result).toBeUndefined();
  });
});
