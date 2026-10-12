import { execFile } from "node:child_process";

import type { Config } from "../config.js";
import { subscriptionOnlyEnv } from "../subscriptionEnv.js";

export type CodexAuthExec = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; shell: false; windowsHide: true },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: CodexAuthExec = async (command, args, options) =>
  await new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error !== null) {
        rejectPromise(error);
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });

export async function checkCodexAuth(
  config: Config,
  exec: CodexAuthExec = defaultExec,
): Promise<void> {
  let output: string;
  try {
    const result = await exec(config.tools.codex.codexPath, ["login", "status"], {
      env: subscriptionOnlyEnv(),
      shell: false,
      windowsHide: true,
    });
    output = `${result.stdout}\n${result.stderr}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      code === "ENOENT"
        ? `找不到 Codex 執行檔（${config.tools.codex.codexPath}）`
        : `無法檢查 Codex 登入狀態：${detail}`,
      { cause: error },
    );
  }

  if (!output.includes("ChatGPT")) {
    throw new Error("`codex login status` 未顯示 ChatGPT 訂閱登入");
  }
}
