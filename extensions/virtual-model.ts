import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROVIDER = "openai-codex";
const SOL = "gpt-6.1-sol";
const LUNA = "gpt-6-luna";

const CLASSIFIERS = [
  ["typesafe", "jev-latest"],
  ["openrouter", "typesafe/jev-1.13"],
  ["opencode", "jev-1.13"],
  ["opencode-go", "jev-1.13"],
] as const;

export type RouteReason = "user" | "continuation" | "retry" | "direct";

export interface RouteChoice {
  provider: string;
  id: string;
  thinkingLevel: ModelThinkingLevel;
}

/** Cheap thinking stays on Luna. Strong thinking stays on Sol. Medium uses a classifier when one exists. */
export function routeTarget(input: {
  reason: RouteReason;
  thinkingLevel: ModelThinkingLevel;
  previous?: RouteChoice;
  failed?: RouteChoice;
  complexity?: "standard" | "complex";
}): RouteChoice {
  if (input.reason === "retry" && input.failed) return input.failed;
  if (input.reason === "continuation" && input.previous) return input.previous;
  if (
    input.reason === "direct" ||
    input.thinkingLevel === "high" ||
    input.thinkingLevel === "xhigh" ||
    input.thinkingLevel === "max"
  ) {
    return { provider: PROVIDER, id: SOL, thinkingLevel: input.thinkingLevel };
  }
  if (
    input.thinkingLevel === "off" ||
    input.thinkingLevel === "minimal" ||
    input.thinkingLevel === "low" ||
    input.complexity === "standard"
  ) {
    return { provider: PROVIDER, id: LUNA, thinkingLevel: input.thinkingLevel };
  }
  return { provider: PROVIDER, id: SOL, thinkingLevel: input.thinkingLevel };
}

function lastUserText(messages: readonly { role?: string; content?: unknown }[]): string {
  const content = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) =>
      block &&
      typeof block === "object" &&
      "type" in block &&
      block.type === "text" &&
      "text" in block
        ? [String(block.text)]
        : [],
    )
    .join("\n");
}

async function complexityOf(
  ctx: ExtensionContext,
  prompt: string,
  signal: AbortSignal | undefined,
): Promise<"standard" | "complex" | undefined> {
  const registry = ctx.modelRegistry;
  if (typeof registry.findOfType !== "function" || typeof registry.classify !== "function")
    return undefined;
  const model = CLASSIFIERS.map(([provider, id]) =>
    registry.findOfType("classifier", provider, id),
  ).find(Boolean);
  if (!model) return undefined;
  try {
    const result = await registry.classify(
      model,
      {
        state: { prompt: prompt.slice(0, 16_000) },
        questions: {
          complexity: {
            type: "choice",
            instructions: "How demanding is the software engineering work requested in `prompt`?",
            criteria: {
              standard: "Ordinary features, fixes, reviews, or questions",
              complex: "Subtle design, cross-cutting changes, or hard debugging",
            },
          },
        },
      },
      { signal },
    );
    const answer = result.stopReason === "stop" ? result.answers?.complexity : undefined;
    if (answer?.type !== "choice") return undefined;
    return (answer.probabilities?.complex ?? 0) >= 0.5 ? "complex" : "standard";
  } catch {
    return undefined;
  }
}

export default function (pi: ExtensionAPI) {
  if (typeof pi.registerVirtualModel !== "function") return;

  pi.registerVirtualModel({
    provider: "router",
    id: "auto",
    name: "Auto",
    thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    contextWindow: 272_000,
    maxTokens: 128_000,
    async route(request, ctx) {
      const previous = request.previous
        ? {
            provider: request.previous.model.provider,
            id: request.previous.model.id,
            thinkingLevel: request.previous.thinkingLevel ?? request.thinkingLevel,
          }
        : undefined;
      const failed = request.failed
        ? {
            provider: request.failed.model.provider,
            id: request.failed.model.id,
            thinkingLevel: request.failed.thinkingLevel ?? request.thinkingLevel,
          }
        : undefined;
      const complexity =
        request.reason === "user" && request.thinkingLevel === "medium"
          ? await complexityOf(ctx, lastUserText(request.messages), request.signal)
          : undefined;
      const choice = routeTarget({
        reason: request.reason,
        thinkingLevel: request.thinkingLevel,
        previous,
        failed,
        complexity,
      });
      const model = ctx.modelRegistry.find(choice.provider, choice.id);
      if (!model) throw new Error(`Model ${choice.provider}/${choice.id} is not in the catalog`);
      return { model, thinkingLevel: choice.thinkingLevel };
    },
  });
}
