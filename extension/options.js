// ALICE 選取翻譯（§48）的設定頁：Core 網址與 token 存在 chrome.storage.local。
const coreUrl = document.getElementById("coreUrl");
const token = document.getElementById("token");
const status = document.getElementById("status");

chrome.storage.local.get(["coreUrl", "token"]).then((stored) => {
  coreUrl.value = stored.coreUrl || "http://127.0.0.1:7788";
  token.value = stored.token || "";
});

async function save() {
  await chrome.storage.local.set({ coreUrl: coreUrl.value.trim() || "http://127.0.0.1:7788", token: token.value.trim() });
  status.textContent = "已儲存。";
}

document.getElementById("save").addEventListener("click", save);
document.getElementById("test").addEventListener("click", async () => {
  await save();
  status.textContent = "測試中：翻譯「Hello, ALICE.」…";
  const answer = await chrome.runtime.sendMessage({ type: "alice-translate", text: "Hello, ALICE." });
  status.textContent = answer?.ok
    ? `成功：${answer.translation}（${(answer.durationMs / 1000).toFixed(1)} 秒）`
    : `失敗：${answer?.error || "沒有回應"}`;
});
