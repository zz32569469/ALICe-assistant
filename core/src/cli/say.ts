// 轉接 session 的指令：
//   node core/dist/src/cli/say.js [--from <session 名稱>] [--text <訊息>]   （沒有 --text 時從 stdin 讀）
//   node core/dist/src/cli/say.js --approve [<id 前綴>] | --reject [<id 前綴>] | --pending
// 結束碼：0 正常；1 錯誤；2 超過等待時間（艾莉絲還在想）。

import { readToken } from "../auth/token.js";
import { loadConfig } from "../config.js";
import { validPeerName } from "../relay/peer.js";
import {
  checkWork, decide, markOutbox, outboxPending, pendingConfirmations, relayMessage, waitForWork, watchOutbox, type RelayConnection,
} from "../relay/relayClient.js";

/** 旗標後面到下一個 -- 旗標之前的字串，以空格接起來（session 名稱可能有空格而沒加引號，實測發現）。 */
function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const parts: string[] = [];
  for (const value of args.slice(index + 1)) {
    if (value.startsWith("--")) break;
    parts.push(value);
  }
  return parts.join(" ");
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const config = loadConfig(process.env.ALICE_CONFIG);
  let token: string;
  try {
    token = readToken(config.tokenPath);
  } catch {
    console.log("【錯誤】找不到 Alice Core token；請主人先在 core 資料夾執行 npm start。");
    return 1;
  }
  const connection: RelayConnection = { baseUrl: `http://127.0.0.1:${config.port}`, token };
  // §42：--wait 在背景等到有事才結束；Core 沒開時也繼續等（自動重連），不能馬上結束，否則轉接 session 會一直被叫醒。
  if (args.includes("--wait")) {
    await waitForWork(connection);
    console.log("有待處理的事，請執行 --check。");
    return 0;
  }
  try {
    await fetch(`${connection.baseUrl}/api/health`);
  } catch {
    console.log(`【錯誤】Alice Core 沒有在 ${connection.baseUrl} 執行；請主人先在 core 資料夾執行 npm start。`);
    return 1;
  }

  // §27：待送信件。轉接 session 用 --watch 在背景監看，被喚醒後用 --outbox 取出、SendMessage 送出，再用 --sent／--failed 回報。
  // §42：--check 列出要做的事。
  if (args.includes("--check")) {
    if (await checkWork(connection) === 0) console.log("目前沒有要處理的事。");
    return 0;
  }
  if (args.includes("--watch")) {
    await watchOutbox(connection);
    return 0;
  }
  if (args.includes("--outbox")) {
    const messages = await outboxPending(connection);
    if (messages.length === 0) console.log("目前沒有待送信件。");
    for (const message of messages) {
      console.log(`=== 信件 ${message.id} ===\n收件：${message.recipient}\n---\n${message.text}\n=== 信件結束 ===\n`);
    }
    return 0;
  }
  for (const [flag, status] of [["--sent", "sent"], ["--failed", "failed"]] as const) {
    if (args.includes(flag)) {
      const index = args.indexOf(flag);
      const id = args[index + 1];
      if (id === undefined || id.startsWith("--")) {
        console.log(`【錯誤】${flag} 後面要接信件 id。`);
        return 1;
      }
      const reason = status === "failed" ? args.slice(index + 2).filter((part) => !part.startsWith("--")).join(" ") : undefined;
      console.log(await markOutbox(connection, id, status, reason));
      return 0;
    }
  }

  if (args.includes("--pending")) {
    const pending = await pendingConfirmations(connection);
    console.log(pending.length === 0 ? "目前沒有待確認的計畫或任務。" : pending.map((item) => `- ${item.label}`).join("\n"));
    return 0;
  }
  for (const [flag, action] of [["--approve", "approve"], ["--reject", "reject"]] as const) {
    if (args.includes(flag)) {
      console.log(await decide(connection, action, argValue(args, flag)));
      return 0;
    }
  }

  const from = argValue(args, "--from");
  if (from !== undefined && !validPeerName(from)) {
    console.log("【錯誤】--from 的 session 名稱要 1～40 字，不能有換行或「〉」。");
    return 1;
  }
  const text = (argValue(args, "--text") ?? await readStdin()).trim();
  if (text === "") {
    console.log("【錯誤】沒有訊息內容（用 --text 或從 stdin 傳入）。");
    return 1;
  }
  const outcome = await relayMessage(connection, text, from === undefined ? {} : { from });
  if (outcome.error !== undefined) console.log(`【錯誤】艾莉絲沒有回覆：${outcome.error}`);
  if (outcome.replyText !== undefined) console.log(`【艾莉絲】\n${outcome.replyText}`);
  for (const confirmation of outcome.confirmations) console.log(`\n【需要主人確認】\n${confirmation}`);
  if (outcome.systemNotes.length > 0) console.log(`\n【系統】\n${outcome.systemNotes.map((note) => `- ${note}`).join("\n")}`);
  if (outcome.timedOut) {
    console.log(`【還在想】艾莉絲超過 3 分鐘還沒回完；完成後可在 Web Studio（${connection.baseUrl}/）看到回覆，或稍後用 --pending 查待確認項目。`);
    return 2;
  }
  return outcome.error === undefined ? 0 : 1;
}

process.exitCode = await main();
