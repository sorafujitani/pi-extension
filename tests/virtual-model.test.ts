import { describe, expect, it } from "vite-plus/test";
import { deferredToolExposure } from "../extensions/deferred-extensions.js";
import { routeTarget } from "../extensions/virtual-model.js";

describe("router/auto", () => {
  it("keeps tool follow-ups and retries on the physical model", () => {
    const previous = { provider: "openai-codex", id: "gpt-6-luna", thinkingLevel: "low" } as const;
    expect(routeTarget({ reason: "continuation", thinkingLevel: "high", previous })).toEqual(
      previous,
    );
    const failed = {
      provider: "openai-codex",
      id: "gpt-6.1-sol",
      thinkingLevel: "medium",
    } as const;
    expect(routeTarget({ reason: "retry", thinkingLevel: "medium", failed })).toEqual(failed);
  });

  it("uses Luna for cheap work and Sol otherwise", () => {
    expect(routeTarget({ reason: "user", thinkingLevel: "low" }).id).toBe("gpt-6-luna");
    expect(
      routeTarget({ reason: "user", thinkingLevel: "medium", complexity: "standard" }).id,
    ).toBe("gpt-6-luna");
    expect(routeTarget({ reason: "user", thinkingLevel: "medium" }).id).toBe("gpt-6.1-sol");
    expect(routeTarget({ reason: "user", thinkingLevel: "max" }).id).toBe("gpt-6.1-sol");
  });
});

describe("deferred package exposure", () => {
  it("hides web tools behind codemode and lens tools behind tool search", () => {
    expect(deferredToolExposure("pi-web-access")).toBe("codemode");
    expect(deferredToolExposure("pi-lens")).toBe("deferred");
    expect(deferredToolExposure("other")).toBeUndefined();
  });
});
