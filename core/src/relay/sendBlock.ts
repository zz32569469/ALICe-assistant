// ALICE_SEND 區塊（§27 D-4）：艾莉絲直接傳訊息給同事 session 或 Library，放進待送信件。

export const SEND_BLOCK_MARKERS = { start: "<<<ALICE_SEND", end: "ALICE_SEND>>>" } as const;

export type SendRequest = { to: string; message: string };

export function parseSendBlock(blockText: string): SendRequest {
  if (!blockText.startsWith(SEND_BLOCK_MARKERS.start) || !blockText.endsWith(SEND_BLOCK_MARKERS.end)) {
    throw new Error("傳訊區塊標記不完整");
  }
  let value: unknown;
  try {
    value = JSON.parse(blockText.slice(SEND_BLOCK_MARKERS.start.length, -SEND_BLOCK_MARKERS.end.length).trim());
  } catch {
    throw new Error("傳訊區塊 JSON 格式錯誤");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("傳訊內容必須是 JSON 物件");
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).find((key) => key !== "to" && key !== "message");
  if (extra !== undefined) throw new Error(`傳訊包含不支援的欄位：${extra}`);
  if (typeof record.to !== "string" || record.to.trim() === "") throw new Error("to 必須是非空白字串");
  if (typeof record.message !== "string" || record.message.trim() === "") throw new Error("message 必須是非空白字串");
  if (Array.from(record.message).length > 4_000) throw new Error("message 最多 4,000 字");
  return { to: record.to.trim(), message: record.message.trim() };
}

/** 可以傳訊的對象：專案名稱、角色名稱或 session 名稱都對應到 session 名稱。 */
export type SessionTarget = { project: string; role: string; session: string };

export function resolveRecipient(to: string, targets: readonly SessionTarget[]): SessionTarget | undefined {
  const wanted = to.trim().toLowerCase();
  return targets.find((target) => [target.session, target.project, target.role].some((name) => name.toLowerCase() === wanted));
}
