import { execFile } from "node:child_process";

import type { Config } from "../config.js";
import { claudeSubscriptionEnv } from "./claudeCodeProvider.js";

export type ClaudeAuthStatus = {
  loggedIn?: boolean;
  authMethod?: string;
  subscriptionType?: string;
};

export type ClaudeAuthExec = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; shell: false; windowsHide: true },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ClaudeAuthExec = async (command, args, options) =>
  await new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error !== null) {
        rejectPromise(error);
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });

export async function checkClaudeCodeAuth(
  config: Config,
  exec: ClaudeAuthExec = defaultExec,
): Promise<ClaudeAuthStatus> {
  let stdout: string;
  try {
    ({ stdout } = await exec(config.claudePath, ["auth", "status"], {
      env: claudeSubscriptionEnv(),
      shell: false,
      windowsHide: true,
    }));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      code === "ENOENT"
        ? `找不到 Claude Code 執行檔（${config.claudePath}），請安裝或設定 claudePath。`
        : `無法檢查 Claude Code 登入狀態：${detail}`,
      { cause: error },
    );
  }

  let status: ClaudeAuthStatus;
  try {
    status = JSON.parse(stdout) as ClaudeAuthStatus;
  } catch (error) {
    throw new Error("無法解析 `claude auth status` 的 JSON 輸出。", { cause: error });
  }
  if (status.loggedIn !== true || status.authMethod !== "claude.ai") {
    throw new Error(
      "Alice Core 只允許 Claude Code 的 claude.ai 訂閱登入；請先執行 `claude auth login`，且不要使用 API 憑證。",
    );
  }
  return status;
}
