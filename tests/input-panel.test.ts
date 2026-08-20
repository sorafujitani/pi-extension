import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";
import inputPanel from "../extensions/input-panel.js";

type EditorFactory = NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;
type Handler = (...args: never[]) => unknown;
type Command = {
  handler(args: string, ctx: ExtensionContext): Promise<void>;
};

function placeholderFactory(): EditorFactory {
  return (() => undefined) as unknown as EditorFactory;
}

function createHarness(initialEditor?: EditorFactory) {
  const handlers = new Map<string, Handler>();
  const setCalls: Array<EditorFactory | undefined> = [];
  let footerCalls = 0;
  let editorFactory = initialEditor;
  const ui = {
    theme: {} as ExtensionContext["ui"]["theme"],
    getEditorComponent: () => editorFactory,
    setEditorComponent(factory: EditorFactory | undefined) {
      editorFactory = factory;
      setCalls.push(factory);
    },
    setFooter() {
      footerCalls += 1;
    },
    notify() {},
  };
  const context = {
    mode: "tui",
    ui,
    model: undefined,
    thinkingLevel: "off",
    cwd: "/tmp/pi-extension",
    sessionManager: { getEntries: () => [], getBranch: () => [] },
    getContextUsage: () => undefined,
  } as unknown as ExtensionContext;
  let command: Command | undefined;
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, options: Command) {
      if (name === "input-panel") command = options;
    },
  } as unknown as ExtensionAPI;
  inputPanel(pi);

  return {
    context,
    setCalls,
    get footerCalls() {
      return footerCalls;
    },
    get editorFactory() {
      return editorFactory;
    },
    async startSession() {
      const handler = handlers.get("session_start");
      if (!handler) throw new Error("missing session_start handler");
      await (handler as unknown as (event: unknown, ctx: ExtensionContext) => unknown)({}, context);
    },
    async toggle() {
      if (!command) throw new Error("missing input-panel command");
      await command.handler("", context);
    },
    replaceEditor(factory: EditorFactory | undefined) {
      ui.setEditorComponent(factory);
    },
  };
}

describe("input panel editor ownership", () => {
  it("does not replace an existing custom editor", async () => {
    const existing = placeholderFactory();
    const harness = createHarness(existing);

    await harness.startSession();
    await harness.toggle();
    await harness.toggle();

    expect(harness.editorFactory).toBe(existing);
    expect(harness.setCalls).toHaveLength(0);
    expect(harness.footerCalls).toBe(0);
  });

  it("restores the default editor when its panel factory is still active", async () => {
    const harness = createHarness();
    await harness.startSession();
    harness.setCalls.length = 0;

    await harness.toggle();

    expect(harness.editorFactory).toBeUndefined();
    expect(harness.setCalls).toEqual([undefined]);
  });

  it("does not remove another extension's editor on disable", async () => {
    const harness = createHarness();
    await harness.startSession();
    const otherEditor = placeholderFactory();
    harness.replaceEditor(otherEditor);
    harness.setCalls.length = 0;

    await harness.toggle();

    expect(harness.editorFactory).toBe(otherEditor);
    expect(harness.setCalls).toHaveLength(0);
  });
});
