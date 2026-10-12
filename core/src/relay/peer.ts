// 同事 session（S-1）：透過轉接 session 傳給艾莉絲的訊息，開頭加「［來自 session〈名稱〉］」，Core 與提示據此和主人區分。

const PEER_PREFIX = /^［來自 session〈([^〉\r\n]{1,40})〉］[ \t]*\r?\n?/u;

export const PEER_CLIENT_PREFIX = "session:";

export function peerText(name: string, body: string): string {
  return `［來自 session〈${name}〉］\n${body}`;
}

export function parsePeer(text: string): { name: string; body: string } | undefined {
  const match = PEER_PREFIX.exec(text);
  return match === null ? undefined : { name: match[1]!, body: text.slice(match[0].length) };
}

/** session 名稱：1～40 字，不可含換行與「〉」（避免偽造前綴）。 */
export function validPeerName(name: string): boolean {
  return /^[^〉\r\n]{1,40}$/u.test(name.trim()) && name.trim() !== "";
}
