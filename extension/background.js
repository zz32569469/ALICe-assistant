// ALICE 選取翻譯（§48）的背景程式：收到內容腳本的文字，送到本機 ALICE Core 的 /api/translate。
// 只連本機（manifest 的 host_permissions 只有 127.0.0.1／localhost）；token 存在 chrome.storage.local。

const DEFAULT_CORE_URL = "http://127.0.0.1:7788";

async function settings() {
  const stored = await chrome.storage.local.get(["coreUrl", "token"]);
  return { coreUrl: (stored.coreUrl || DEFAULT_CORE_URL).replace(/\/+$/u, ""), token: stored.token || "" };
}

async function translate(text) {
  const { coreUrl, token } = await settings();
  if (token === "") return { ok: false, error: "還沒設定 token：在插件圖示上按右鍵 →「選項」貼上 ALICE Core 的 token。" };
  let response;
  try {
    response = await fetch(`${coreUrl}/api/translate`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ text }),
    });
  } catch {
    return { ok: false, error: `連不到 ALICE Core（${coreUrl}）。請確認 Core 有在執行。` };
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401) return { ok: false, error: "token 不對：請到插件「選項」重新貼上 ALICE Core 的 token。" };
    return { ok: false, error: body?.error?.message || `翻譯失敗（HTTP ${response.status}）` };
  }
  return { ok: true, translation: body.translation, target: body.target, durationMs: body.durationMs };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "alice-translate" || typeof message.text !== "string") return false;
  translate(message.text).then(sendResponse);
  return true; // 非同步回覆
});

// 點工具列圖示時打開設定頁。
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
