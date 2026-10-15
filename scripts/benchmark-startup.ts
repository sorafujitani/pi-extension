/*
 * Capture a resource snapshot after an RPC get_state response without making
 * an LLM request. The RPC prompt below only dispatches the slash command.
 *
 * Normal configuration:
 *   PI_STARTUP_BENCHMARK_CONFIGURATION=normal pi --mode rpc --no-session --offline -e ./scripts/benchmark-startup.ts
 * Minimal configuration:
 *   PI_STARTUP_BENCHMARK_CONFIGURATION=minimal pi --mode rpc --no-session --offline --no-extensions -e ./scripts/benchmark-startup.ts
 *
 * In each process, an external RPC client must wait for a successful
 * `{"type":"get_state"}` response, then send
 * `{"type":"prompt","message":"/benchmark-startup"}`. This is a
 * checkpoint snapshot, not a guarantee that all deferred initialization has
 * completed. `systemPromptChars` is measured before policy conversion because
 * this command does not fire `before_agent_start`.
 *
 * The command does not call `ctx.shutdown()`; the external client owns stdin
 * closure/process termination and any timeout. JSON is written to stderr so
 * the RPC protocol on stdout remains valid.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function serializedBytes(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : Buffer.byteLength(serialized);
  } catch {
    return null;
  }
}

export default function startupBenchmark(pi: ExtensionAPI): void {
  pi.registerCommand("benchmark-startup", {
    description: "Capture a resource snapshot at the RPC checkpoint",
    handler: async (_args, ctx) => {
      const tools = pi.getAllTools();
      const report = {
        configuration: process.env.PI_STARTUP_BENCHMARK_CONFIGURATION ?? "unspecified",
        checkpoint: "after_rpc_get_state",
        systemPromptStage: "before_policy_conversion",
        systemPromptChars: ctx.getSystemPrompt().length,
        activeToolCount: pi.getActiveTools().length,
        toolDefinitionCount: tools.length,
        toolDefinitionBytes: serializedBytes(tools),
        commandCount: pi.getCommands().length,
      };
      process.stderr.write(`${JSON.stringify(report)}\n`);
    },
  });
}
