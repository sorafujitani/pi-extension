import {
  formatSkillsForPrompt,
  type ExtensionAPI,
  type Skill,
} from "@earendil-works/pi-coding-agent";

const PI_DOCUMENTATION_HEADING =
  "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):";
const ORIGINAL_POLICY_LINES = [
  "- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing",
  "- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)",
] as const;
const REPLACED_POLICY_LINES = [
  "- When working on pi topics, read only the documentation sections and examples relevant to the task",
  "- For implementation, read the target API, its example, and only the cross-referenced sections needed for the task",
] as const;
const KNOWN_BLOCK_ANCHORS = ["- Main documentation:", "- Additional docs:", "- Examples:"] as const;

function formatCompactSkillsForPrompt(skills: Skill[]): string {
  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Each line inside <available_skills> is a JSON array with columns: name, filePath, description (in that order).",
    "When a skill matches the task, use the read tool to load its SKILL.md. Resolve relative references from the skill directory (the parent directory of SKILL.md).",
    "",
    "<available_skills>",
    ...skills.map((skill) => JSON.stringify([skill.name, skill.filePath, skill.description])),
    "</available_skills>",
  ];
  return lines.join("\n");
}

/** Replace only the known built-in Pi documentation policy block. */
export function replacePiDocumentationReadingPolicy(systemPrompt: string): string {
  const blockStart = systemPrompt.indexOf(PI_DOCUMENTATION_HEADING);
  if (blockStart < 0) return systemPrompt;

  const nextSection = systemPrompt.indexOf("\n\n", blockStart);
  const blockEnd = nextSection < 0 ? systemPrompt.length : nextSection;
  const block = systemPrompt.slice(blockStart, blockEnd);

  if (!KNOWN_BLOCK_ANCHORS.every((anchor) => block.includes(anchor))) return systemPrompt;
  if (!ORIGINAL_POLICY_LINES.every((line) => block.includes(line))) return systemPrompt;

  const replacedBlock = block
    .replace(ORIGINAL_POLICY_LINES[0], REPLACED_POLICY_LINES[0])
    .replace(ORIGINAL_POLICY_LINES[1], REPLACED_POLICY_LINES[1]);
  return `${systemPrompt.slice(0, blockStart)}${replacedBlock}${systemPrompt.slice(blockEnd)}`;
}

/** Replace exactly one SDK-generated skills block with a lossless compact index. */
export function compactSkillsForPrompt(systemPrompt: string, skills: Skill[] | undefined): string {
  if (!skills || skills.length === 0) return systemPrompt;

  const sdkSkillsBlock = formatSkillsForPrompt(skills);
  if (!sdkSkillsBlock) return systemPrompt;

  const blockStart = systemPrompt.indexOf(sdkSkillsBlock);
  if (blockStart < 0) return systemPrompt;
  if (systemPrompt.indexOf(sdkSkillsBlock, blockStart + sdkSkillsBlock.length) >= 0) {
    return systemPrompt;
  }

  const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
  if (visibleSkills.length === 0) return systemPrompt;

  const compactSkillsBlock = formatCompactSkillsForPrompt(visibleSkills);
  if (compactSkillsBlock.length >= sdkSkillsBlock.length) return systemPrompt;

  return `${systemPrompt.slice(0, blockStart)}${compactSkillsBlock}${systemPrompt.slice(
    blockStart + sdkSkillsBlock.length,
  )}`;
}

export default function docsReadingPolicyExtension(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    // A custom system prompt belongs to the user and must not be rewritten.
    if (event.systemPromptOptions.customPrompt !== undefined) return;

    let systemPrompt = replacePiDocumentationReadingPolicy(event.systemPrompt);
    systemPrompt = compactSkillsForPrompt(systemPrompt, event.systemPromptOptions.skills);
    if (systemPrompt === event.systemPrompt) return;
    return { systemPrompt };
  });
}
