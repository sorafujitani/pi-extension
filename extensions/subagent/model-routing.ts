import type { AgentConfig } from "./agents.js";

export type ModelFamily = "gpt" | "claude" | "grok";

const PROVIDER_FAMILIES: Record<string, ModelFamily> = {
  anthropic: "claude",
  "grok-cli": "grok",
  openai: "gpt",
  "openai-codex": "gpt",
  xai: "grok",
};

function getProvider(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const separator = model.indexOf("/");
  if (separator <= 0) return undefined;
  return model.slice(0, separator).toLowerCase();
}

export function getModelFamily(model: string | undefined): ModelFamily | undefined {
  const provider = getProvider(model);
  return provider ? PROVIDER_FAMILIES[provider] : undefined;
}

export function resolveAgentModel(
  agent: Pick<AgentConfig, "model" | "modelRoutes">,
  parentModel: string | undefined,
): string | undefined {
  const parentProvider = getProvider(parentModel);
  const parentFamily = getModelFamily(parentModel);
  const routedModel =
    (parentProvider ? agent.modelRoutes?.[parentProvider] : undefined) ??
    (parentFamily ? agent.modelRoutes?.[parentFamily] : undefined);

  if (routedModel) return routedModel;
  if (!parentModel) return agent.model;

  const configuredProvider = getProvider(agent.model);
  const configuredFamily = getModelFamily(agent.model);
  if (
    configuredProvider === parentProvider ||
    (configuredFamily !== undefined && configuredFamily === parentFamily)
  ) {
    return agent.model;
  }

  return parentModel;
}
