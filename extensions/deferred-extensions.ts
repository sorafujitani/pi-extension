import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as _bundledPiAgentCore from "@earendil-works/pi-agent-core";
import * as _bundledPiAiCompat from "@earendil-works/pi-ai/compat";
import * as _bundledPiAiOauth from "@earendil-works/pi-ai/oauth";
import * as _bundledPiAiProviders from "@earendil-works/pi-ai/providers/all";
import * as _bundledPiCodingAgent from "@earendil-works/pi-coding-agent";
import * as _bundledPiTui from "@earendil-works/pi-tui";
import { createJiti } from "jiti/static";
import * as _bundledTypebox from "typebox";
import * as _bundledTypeboxCompile from "typebox/compile";
import * as _bundledTypeboxValue from "typebox/value";
import {
  getAgentDir,
  type BeforeAgentStartEvent,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  type ExtensionHandler,
  type RegisteredCommand,
  type SessionStartEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { isInteractiveSession } from "./host-compat.js";

export interface DeferredPackageSpec {
  readonly name: string;
  readonly entry: string;
  readonly commands?: readonly string[];
}

export const DEFERRED_PACKAGE_SPECS: readonly DeferredPackageSpec[] = [
  {
    name: "pi-web-access",
    entry: "index.ts",
    commands: ["websearch", "curator", "google-account", "search"],
  },
  {
    name: "pi-lens",
    entry: "dist/index.js",
    commands: [
      "lens-allow-edit",
      "lens-context-toggle",
      "lens-health",
      "lens-map",
      "lens-perf",
      "lens-tdi",
      "lens-toggle",
      "lens-tools",
      "lens-widget-toggle",
    ],
  },
];

export type ImportModule = (specifier: string) => Promise<unknown>;

export interface DeferredExtensionsOptions {
  readonly agentDir?: string;
  readonly packageSpecs?: readonly DeferredPackageSpec[];
  readonly importModule?: ImportModule;
  readonly timeoutMs?: number;
  /** Skip specs whose entry is absent. Injected so virtual importers can opt out. */
  readonly entryExists?: (entry: string) => boolean;
}

const VIRTUAL_MODULES: Record<string, unknown> = {
  typebox: _bundledTypebox,
  "typebox/compile": _bundledTypeboxCompile,
  "typebox/value": _bundledTypeboxValue,
  "@sinclair/typebox": _bundledTypebox,
  "@sinclair/typebox/compile": _bundledTypeboxCompile,
  "@sinclair/typebox/value": _bundledTypeboxValue,
  "@earendil-works/pi-agent-core": _bundledPiAgentCore,
  "@earendil-works/pi-tui": _bundledPiTui,
  "@earendil-works/pi-ai": _bundledPiAiCompat,
  "@earendil-works/pi-ai/compat": _bundledPiAiCompat,
  "@earendil-works/pi-ai/oauth": _bundledPiAiOauth,
  "@earendil-works/pi-ai/providers/all": _bundledPiAiProviders,
  "@earendil-works/pi-coding-agent": _bundledPiCodingAgent,
  "@mariozechner/pi-agent-core": _bundledPiAgentCore,
  "@mariozechner/pi-tui": _bundledPiTui,
  "@mariozechner/pi-ai": _bundledPiAiCompat,
  "@mariozechner/pi-ai/compat": _bundledPiAiCompat,
  "@mariozechner/pi-ai/oauth": _bundledPiAiOauth,
  "@mariozechner/pi-ai/providers/all": _bundledPiAiProviders,
  "@mariozechner/pi-coding-agent": _bundledPiCodingAgent,
};

export function createDefaultImportModule(): ImportModule {
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    tryNative: false,
    virtualModules: VIRTUAL_MODULES,
  });
  return (specifier) => jiti.import(specifier, { default: true });
}

type SessionStartHandler = ExtensionHandler<SessionStartEvent>;
type CommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;

interface PackageState {
  readonly spec: DeferredPackageSpec;
  readonly readyPromise: Promise<void>;
  readonly resolveReady: () => void;
  readonly capturedSessionStartHandlers: SessionStartHandler[];
  readonly commands: Map<string, CommandOptions>;
  factoryPromise: Promise<void>;
  factoryCompleted: boolean;
  finalized: boolean;
  finalizing?: Promise<void>;
  failed: boolean;
  cancelled: boolean;
  timeout?: ReturnType<typeof setTimeout>;
}

export function resolveDeferredPackageEntry(agentDir: string, spec: DeferredPackageSpec): string {
  return join(agentDir, "npm", "node_modules", spec.name, spec.entry);
}

function moduleDefault(module: unknown): ExtensionFactory | undefined {
  if (typeof module === "function") return module as ExtensionFactory;
  if (
    !module ||
    typeof module !== "object" ||
    !("default" in module) ||
    typeof module.default !== "function"
  ) {
    return undefined;
  }
  return module.default as ExtensionFactory;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function deferredToolExposure(packageName: string): "codemode" | "deferred" | undefined {
  if (packageName === "pi-web-access") return "codemode";
  if (packageName === "pi-lens") return "deferred";
  return undefined;
}

function wrapTool(
  tool: ToolDefinition,
  packageName: string,
  ready: Promise<void>,
  isBootstrapContext: () => boolean,
): ToolDefinition {
  const exposure = deferredToolExposure(packageName);
  return {
    ...tool,
    ...(exposure ? { exposure } : {}),
    ...(packageName === "pi-web-access"
      ? {
          namespace: {
            name: "web",
            description: "External web tools. Call from codemode and return only the needed text.",
          },
        }
      : {}),
    execute: async (...args: Parameters<ToolDefinition["execute"]>) => {
      if (!isBootstrapContext()) await ready;
      return tool.execute(...args);
    },
  };
}

function createPackageAPI(
  pi: ExtensionAPI,
  state: PackageState,
  isBootstrapContext: () => boolean,
): ExtensionAPI {
  return new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "on") {
        return (event: string, handler: unknown) => {
          if (state.cancelled) return;
          if (event === "session_start" && !state.finalized) {
            state.capturedSessionStartHandlers.push(handler as SessionStartHandler);
            return;
          }
          // SAFETY: ExtensionAPI.on is overloaded by event name; this forwards the
          // original runtime pair after intercepting only session_start.
          const on = target.on.bind(target) as unknown as (event: string, handler: unknown) => void;
          return on(event, handler);
        };
      }

      if (property === "registerTool") {
        return (tool: ToolDefinition) => {
          if (state.cancelled) return;
          target.registerTool(
            wrapTool(tool, state.spec.name, state.readyPromise, isBootstrapContext),
          );
        };
      }

      if (property === "registerCommand") {
        return (name: string, options: CommandOptions) => {
          if (state.cancelled) return;
          state.commands.set(name, options);
          target.registerCommand(name, {
            ...options,
            handler: async (args, ctx) => {
              if (!isBootstrapContext()) await state.readyPromise;
              await options.handler(args, ctx);
            },
          });
        };
      }

      if (
        typeof property === "string" &&
        (property.startsWith("register") || property === "unregisterProvider")
      ) {
        return (...args: unknown[]) => {
          if (state.cancelled) return;
          const method = Reflect.get(target, property, receiver) as (
            ...values: unknown[]
          ) => unknown;
          return method.apply(target, args);
        };
      }

      return Reflect.get(target, property, receiver);
    },
  });
}

export async function createDeferredExtensionsExtension(
  pi: ExtensionAPI,
  options: DeferredExtensionsOptions = {},
): Promise<void> {
  const agentDir = options.agentDir ?? getAgentDir();
  const entryExists = options.entryExists ?? existsSync;
  // A host that installs only some of the packages defers only those.
  const packageSpecs = (options.packageSpecs ?? DEFERRED_PACKAGE_SPECS).filter((spec) =>
    entryExists(resolveDeferredPackageEntry(agentDir, spec)),
  );
  const importModule = options.importModule ?? createDefaultImportModule();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const states = new Map<string, PackageState>();
  const pendingWarnings: string[] = [];
  let latestContext: ExtensionContext | undefined;
  let activeSessionStarts = 0;
  let sessionGeneration = 0;
  const bootstrapContext = new AsyncLocalStorage<PackageState>();

  function notify(ctx: ExtensionContext | undefined, message: string): void {
    try {
      ctx?.ui.notify(`[deferred-extensions] ${message}`, "warning");
    } catch {
      // Notification must not make extension loading fail.
    }
  }

  function reportWarning(message: string, ctx = latestContext): void {
    if (ctx) {
      notify(ctx, message);
    } else {
      pendingWarnings.push(message);
    }
  }

  function flushWarnings(ctx: ExtensionContext): void {
    const warnings = pendingWarnings.splice(0);
    for (const warning of warnings) notify(ctx, warning);
  }

  function reportPackageFailure(state: PackageState, error: unknown): void {
    reportWarning(`failed to load ${state.spec.name}: ${errorMessage(error)}`);
  }

  function registerSessionStartHandlers(
    state: PackageState,
    skippedEvent?: SessionStartEvent,
  ): void {
    if (state.cancelled) return;
    const handlers = [...state.capturedSessionStartHandlers];
    for (const handler of handlers) {
      const registeredHandler: SessionStartHandler =
        skippedEvent === undefined
          ? handler
          : (event, ctx) => {
              if (event === skippedEvent) return;
              return handler(event, ctx);
            };
      try {
        pi.on("session_start", registeredHandler);
      } catch (error) {
        reportWarning(
          `failed to register ${state.spec.name} session_start handler: ${errorMessage(error)}`,
        );
      }
    }
  }

  function completeWithoutReplay(state: PackageState): void {
    if (state.finalized) return;
    if (!state.failed && !state.cancelled) registerSessionStartHandlers(state);
    state.finalized = true;
    state.resolveReady();
  }

  function cancelState(state: PackageState): void {
    if (state.finalized) return;
    state.cancelled = true;
    state.failed = true;
    state.finalized = true;
    state.resolveReady();
  }

  async function replaySessionStart(
    state: PackageState,
    event: SessionStartEvent,
    ctx: ExtensionContext,
    generation: number,
  ): Promise<void> {
    if (state.finalized || state.cancelled || generation !== sessionGeneration) return;
    if (state.finalizing) return state.finalizing;

    state.finalizing = (async () => {
      try {
        if (!state.failed && !state.cancelled && generation === sessionGeneration) {
          const handlersToReplay = [...state.capturedSessionStartHandlers];
          await bootstrapContext.run(state, async () => {
            for (const handler of handlersToReplay) {
              if (state.cancelled || generation !== sessionGeneration) return;
              try {
                await handler(event, ctx);
              } catch (error) {
                reportWarning(
                  `${state.spec.name} session_start handler failed: ${errorMessage(error)}`,
                  ctx,
                );
              }
            }
          });
          if (!state.cancelled && generation === sessionGeneration) {
            registerSessionStartHandlers(state, event);
          }
        }
      } catch (error) {
        reportPackageFailure(state, error);
      } finally {
        state.finalized = true;
        state.resolveReady();
      }
    })();

    await state.finalizing;
  }

  async function loadFactory(state: PackageState): Promise<void> {
    try {
      const entry = resolveDeferredPackageEntry(agentDir, state.spec);
      const module = await importModule(pathToFileURL(entry).href);
      if (state.cancelled) return;
      const factory = moduleDefault(module);
      if (!factory) {
        throw new Error(`module does not export a factory: ${entry}`);
      }
      await bootstrapContext.run(state, () =>
        factory(createPackageAPI(pi, state, () => bootstrapContext.getStore() === state)),
      );
    } catch (error) {
      state.failed = true;
      reportPackageFailure(state, error);
    } finally {
      state.factoryCompleted = true;
      if (state.failed || activeSessionStarts === 0) {
        completeWithoutReplay(state);
      }
    }
  }

  function ensureState(spec: DeferredPackageSpec): PackageState {
    const existing = states.get(spec.name);
    if (existing) return existing;

    let settleReady!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      settleReady = resolve;
    });
    const state: PackageState = {
      spec,
      readyPromise,
      resolveReady: () => {
        if (state.timeout) clearTimeout(state.timeout);
        settleReady();
      },
      capturedSessionStartHandlers: [],
      commands: new Map(),
      factoryPromise: Promise.resolve(),
      factoryCompleted: false,
      finalized: false,
      failed: false,
      cancelled: false,
    };
    states.set(spec.name, state);

    for (const name of spec.commands ?? []) {
      pi.registerCommand(name, {
        description: `Load ${spec.name} and run /${name}`,
        handler: async (args, ctx) => {
          await state.readyPromise;
          const command = state.commands.get(name);
          if (!command) {
            notify(ctx, `/${name} is unavailable because ${spec.name} did not load it`);
            return;
          }
          await command.handler(args, ctx);
        },
      });
    }

    const timeout = new Promise<void>((resolve) => {
      state.timeout = setTimeout(() => {
        if (!state.finalized) {
          state.failed = true;
          reportWarning(`${state.spec.name} timed out after ${timeoutMs}ms`);
          completeWithoutReplay(state);
        }
        resolve();
      }, timeoutMs);
      state.timeout.unref?.();
    });
    state.factoryPromise = Promise.race([loadFactory(state), timeout]);
    return state;
  }

  function ensureAllStates(): PackageState[] {
    return packageSpecs.map((spec) => ensureState(spec));
  }

  async function loadForSession(
    event: SessionStartEvent,
    ctx: ExtensionContext,
    generation: number,
  ): Promise<void> {
    const packageStates = ensureAllStates();
    await Promise.all(packageStates.map((state) => state.factoryPromise));
    if (generation !== sessionGeneration) return;
    for (const state of packageStates) {
      await replaySessionStart(state, event, ctx, generation);
    }
  }

  async function loadAllReady(): Promise<void> {
    const packageStates = ensureAllStates();
    await Promise.all(packageStates.map((state) => state.readyPromise));
  }

  function finishSessionStart(): void {
    activeSessionStarts -= 1;
    if (activeSessionStarts !== 0) return;
    for (const state of states.values()) {
      if (state.factoryCompleted && !state.finalized) completeWithoutReplay(state);
    }
  }

  function handleSessionStart(
    event: SessionStartEvent,
    ctx: ExtensionContext,
  ): Promise<void> | void {
    latestContext = ctx;
    flushWarnings(ctx);
    activeSessionStarts += 1;
    const generation = ++sessionGeneration;
    const loading = loadForSession(event, ctx, generation).finally(finishSessionStart);
    if (isInteractiveSession(ctx)) {
      void loading.catch((error) => {
        notify(ctx, `session_start loading failed: ${errorMessage(error)}`);
      });
      return;
    }
    return loading;
  }

  function handleBeforeAgentStart(
    _event: BeforeAgentStartEvent,
    ctx: ExtensionContext,
  ): Promise<void> {
    latestContext = ctx;
    flushWarnings(ctx);
    return loadAllReady().catch((error) => {
      notify(ctx, `before_agent_start loading failed: ${errorMessage(error)}`);
    });
  }

  pi.on("session_shutdown", () => {
    sessionGeneration += 1;
    for (const state of states.values()) {
      if (!state.finalized) cancelState(state);
    }
  });
  pi.on("session_start", handleSessionStart);
  pi.on("before_agent_start", handleBeforeAgentStart);
}

export default createDeferredExtensionsExtension;
