import * as sdk from "@earendil-works/pi-coding-agent";
import * as ai from "@earendil-works/pi-ai";
import * as tui from "@earendil-works/pi-tui";
import { createJiti } from "jiti/static";
import { expect, it } from "vite-plus/test";

it("seeds BTW's canonical context, including edits, before the first request", async () => {
  const parent = sdk.SessionManager.inMemory();
  const removed = parent.appendMessage({ role: "user", content: "omit me", timestamp: 1 });
  parent.appendMessage({ role: "user", content: "keep me", timestamp: 2 });
  parent.appendContextEdit(removed, null);
  let child: sdk.SessionManager | undefined;
  let initialMessages: unknown;
  let requestMessages: unknown;
  const jiti = createJiti(import.meta.url, {
    tryNative: false,
    moduleCache: false,
    virtualModules: {
      "@earendil-works/pi-ai": ai,
      "@earendil-works/pi-tui": tui,
      "@earendil-works/pi-coding-agent": {
        ...sdk,
        createAgentSession: async (options: sdk.CreateAgentSessionOptions) => {
          child = options.sessionManager;
          initialMessages = child?.buildSessionContext().messages;
          return {
            session: {
              sessionManager: child,
              agent: { state: { messages: [] } },
              async prompt() {
                requestMessages = child?.buildSessionContext().messages;
                throw new Error("test stops before contacting a provider");
              },
              async abort() {},
              dispose() {},
            },
          };
        },
      },
    },
  });
  const factory = await jiti.import<sdk.ExtensionFactory>("pi-btw/extensions/btw.ts", {
    default: true,
  });
  const commands = new Map<string, sdk.RegisteredCommand>();
  await factory({
    on() {},
    registerShortcut() {},
    registerMessageRenderer() {},
    registerCommand(name: string, command: sdk.RegisteredCommand) {
      commands.set(name, command);
    },
    getThinkingLevel: () => "off",
  } as unknown as sdk.ExtensionAPI);
  const context = {
    hasUI: false,
    mode: "print",
    cwd: "/tmp",
    isProjectTrusted: () => false,
    model: { provider: "test", id: "test-model", api: "openai-responses" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-only" }),
      getRegisteredNativeProvider: () => undefined,
      getRegisteredProviderConfig: () => undefined,
      getProviderAuthStatus: () => ({ source: "none" }),
    },
    sessionManager: parent,
    getSystemPrompt: () => "test prompt",
    isIdle: () => true,
  } as unknown as sdk.ExtensionCommandContext;

  await commands.get("btw")!.handler("What did I ask?", context);

  expect(child).toBeDefined();
  expect(initialMessages).toEqual([{ role: "user", content: "keep me", timestamp: 2 }]);
  expect(requestMessages).toEqual([{ role: "user", content: "keep me", timestamp: 2 }]);
  expect(parent.getEntries().filter((entry) => entry.type === "message")).toHaveLength(2);
});
