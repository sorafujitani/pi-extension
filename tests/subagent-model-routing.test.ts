import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { discoverAgents } from "../extensions/subagent/agents.js";
import { getModelFamily, resolveAgentModel } from "../extensions/subagent/model-routing.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("subagent model routing", () => {
  it.each([
    ["openai-codex/gpt-5.6-sol", "gpt"],
    ["openai/gpt-5", "gpt"],
    ["anthropic/claude-opus-5", "claude"],
    ["xai/grok-4.6", "grok"],
    ["grok-cli/grok-composer-2.5-fast", "grok"],
  ] as const)("maps %s to the %s family", (model, family) => {
    expect(getModelFamily(model)).toBe(family);
  });

  it("keeps the configured GPT model for a GPT parent", () => {
    expect(
      resolveAgentModel({ model: "openai-codex/gpt-5.6-luna" }, "openai-codex/gpt-5.6-sol"),
    ).toBe("openai-codex/gpt-5.6-luna");
  });

  it("routes within the Claude family for a Claude parent", () => {
    expect(
      resolveAgentModel(
        {
          model: "openai-codex/gpt-5.6-sol",
          modelRoutes: { claude: "anthropic/claude-opus-5" },
        },
        "anthropic/claude-fable-5",
      ),
    ).toBe("anthropic/claude-opus-5");
  });

  it("uses one Grok family route for xAI and Grok CLI parents", () => {
    const agent = {
      model: "openai-codex/gpt-5.6-sol",
      modelRoutes: { grok: "xai/grok-4.6" },
    };

    expect(resolveAgentModel(agent, "xai/grok-4.5")).toBe("xai/grok-4.6");
    expect(resolveAgentModel(agent, "grok-cli/grok-4.20-0309-reasoning")).toBe("xai/grok-4.6");
  });

  it("prefers an exact provider route over a family route", () => {
    expect(
      resolveAgentModel(
        {
          modelRoutes: {
            grok: "xai/grok-4.6",
            "grok-cli": "grok-cli/grok-composer-2.5-fast",
          },
        },
        "grok-cli/grok-4.20-0309-reasoning",
      ),
    ).toBe("grok-cli/grok-composer-2.5-fast");
  });

  it("inherits the parent model when no same-family route exists", () => {
    expect(
      resolveAgentModel({ model: "openai-codex/gpt-5.6-sol" }, "anthropic/claude-fable-5"),
    ).toBe("anthropic/claude-fable-5");
  });

  it("loads modelRoutes from agent frontmatter", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-extension-routing-"));
    temporaryDirectories.push(root);
    const agentsDirectory = join(root, ".pi", "agents");
    await mkdir(agentsDirectory, { recursive: true });
    await writeFile(
      join(agentsDirectory, "planner.md"),
      `---\nname: planner\ndescription: Plan work\nmodel: openai-codex/gpt-5.6-sol\nmodelRoutes:\n  claude: anthropic/claude-opus-5\n  grok: xai/grok-4.6\n---\n\nPlan carefully.\n`,
    );

    const { agents } = discoverAgents(root, "project");

    expect(agents).toHaveLength(1);
    expect(agents[0].modelRoutes).toEqual({
      claude: "anthropic/claude-opus-5",
      grok: "xai/grok-4.6",
    });
  });
});
