import type { ExtensionAPI, ExecResult } from "@earendil-works/pi-coding-agent";
import {
  compactJson,
  compactRunState,
  type FlowInvocation,
  type OrchestrateAction,
  parseJsonOutput,
  stringValue,
} from "./contract.js";

export type FlowBackendOptions = {
  cwd: string;
  signal?: AbortSignal;
};

export interface FlowBackend {
  invoke(
    action: OrchestrateAction,
    args: readonly string[],
    options: FlowBackendOptions,
  ): Promise<FlowInvocation>;
}

const PANOPTICON_COMMAND = "panopticon";

function abortError(action: OrchestrateAction): Error {
  return new Error(`panopticon ${action} の待機を中断しました。run は cancel していません。`);
}

export function createPanopticonBackend(pi: Pick<ExtensionAPI, "exec">): FlowBackend {
  return {
    async invoke(
      action: OrchestrateAction,
      args: readonly string[],
      { cwd, signal }: FlowBackendOptions,
    ): Promise<FlowInvocation> {
      let result: ExecResult;
      try {
        result = await pi.exec(PANOPTICON_COMMAND, [...args], { cwd, signal });
      } catch (error) {
        if (signal?.aborted) throw abortError(action);
        const message = stringValue(error instanceof Error ? error.message : String(error));
        throw new Error(
          `panopticon ${action} を実行できませんでした: ${message ?? "不明なエラー"}. panopticon がPATHにあり、Herdr管理セッション(HERDR_ENV=1)で実行しているか確認してください。`,
        );
      }

      if (result.killed && signal?.aborted) throw abortError(action);

      const parsed = parseJsonOutput(action, result);
      const bounded = compactJson(compactRunState(parsed));
      return {
        state: bounded.state,
        text: bounded.text,
        exitCode: result.code,
        timedOut: action === "wait" && result.code === 124,
        truncated: bounded.truncated,
      };
    },
  };
}
