// ALICE 選取翻譯（§48）的內容腳本：選取文字後在旁邊出現「譯」按鈕（或按 Alt+T），
// 翻譯結果顯示在選取的文字旁邊的小卡片，不開新分頁。介面放在 Shadow DOM 裡，不受網頁樣式影響。
(() => {
  if (window.__aliceTranslate) return;
  window.__aliceTranslate = true;

  const MAX_CHARS = 3000;
  const AUTO_HIDE_MS = 20000;

  const host = document.createElement("div");
  host.id = "alice-translate-root";
  host.style.cssText = "all: initial; position: fixed; inset: auto 0 0 auto; z-index: 2147483647; pointer-events: none;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { --bg: #ffffff; --fg: #1f2329; --muted: #6b7280; --border: #d9dde3; --accent: #a6416a; --shadow: 0 8px 28px rgb(0 0 0 / 18%); }
      @media (prefers-color-scheme: dark) { :host { --bg: #1d2026; --fg: #e8eaed; --muted: #9aa0a6; --border: #3a3f47; --accent: #e07aa3; --shadow: 0 8px 28px rgb(0 0 0 / 50%); } }
      * { box-sizing: border-box; font-family: "Segoe UI", "Microsoft JhengHei UI", "Microsoft JhengHei", system-ui, sans-serif; }
      .pill { position: fixed; pointer-events: auto; display: none; border: 1px solid var(--border); background: var(--bg); color: var(--accent);
        font-size: 13px; font-weight: 700; padding: 2px 9px; border-radius: 999px; box-shadow: var(--shadow); cursor: pointer; line-height: 1.6; }
      .pill:hover { background: var(--accent); color: #fff; }
      .card { position: fixed; left: 16px; top: 16px; width: min(380px, calc(100vw - 16px)); max-height: 50vh; display: none; flex-direction: column;
        pointer-events: auto; background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-left: 3px solid var(--accent);
        border-radius: 10px; box-shadow: var(--shadow); font-size: 14px; line-height: 1.6; }
      .card.show { display: flex; }
      header { display: flex; align-items: center; gap: 8px; padding: 7px 10px 4px 12px; font-size: 12px; color: var(--muted); }
      header b { color: var(--accent); }
      header .spacer { flex: 1; }
      button.icon { border: none; background: none; color: var(--muted); cursor: pointer; font-size: 12px; padding: 2px 6px; border-radius: 6px; }
      button.icon:hover { background: rgb(127 127 127 / 15%); color: var(--fg); }
      .source { padding: 0 12px; font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .result { padding: 6px 12px 12px; overflow-y: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
      .result.error { color: #c0392b; }
      .dots::after { content: "…"; animation: blink 1s steps(2) infinite; }
      @keyframes blink { 50% { opacity: 0.3; } }
    </style>
    <button class="pill" title="ALICE 翻譯（Alt+T）">譯</button>
    <section class="card" role="status" aria-live="polite">
      <header><b>ALICE 翻譯</b><span class="meta"></span><span class="spacer"></span>
        <button class="icon copy" title="複製譯文">複製</button><button class="icon close" title="關閉">✕</button></header>
      <div class="source"></div>
      <div class="result"></div>
    </section>`;
  const pill = root.querySelector(".pill");
  const card = root.querySelector(".card");
  const meta = root.querySelector(".meta");
  const source = root.querySelector(".source");
  const result = root.querySelector(".result");
  let hideTimer;
  let hovering = false;
  let request = 0;

  const mount = () => { if (!host.isConnected) (document.body || document.documentElement).appendChild(host); };
  const selectedText = () => (window.getSelection()?.toString() ?? "").trim();

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (!hovering) card.classList.remove("show"); }, AUTO_HIDE_MS);
  }

  function showPill() {
    const selection = window.getSelection();
    const text = selectedText();
    if (!selection || selection.rangeCount === 0 || text === "") { pill.style.display = "none"; return; }
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) { pill.style.display = "none"; return; }
    mount();
    pill.style.left = `${Math.min(window.innerWidth - 44, Math.max(4, rect.right + 4))}px`;
    pill.style.top = `${Math.min(window.innerHeight - 30, Math.max(4, rect.bottom + 4))}px`;
    pill.style.display = "block";
  }

  // 卡片放在選取的文字旁邊：預設在下方，下方放不下就放上方；左右不超出畫面。捲動時跟著那段文字移動。
  let anchor = null;
  const GAP = 8;
  const EDGE = 8;

  function placeCard() {
    if (anchor === null || !card.classList.contains("show")) return;
    const rect = anchor.getBoundingClientRect();
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    const left = Math.min(window.innerWidth - width - EDGE, Math.max(EDGE, rect.left));
    const below = rect.bottom + GAP;
    const above = rect.top - GAP - height;
    const top = below + height <= window.innerHeight - EDGE || above < EDGE ? below : above;
    card.style.left = `${left}px`;
    card.style.top = `${Math.max(EDGE, Math.min(top, window.innerHeight - height - EDGE))}px`;
  }

  async function translate(text) {
    if (text === "") return;
    const clipped = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
    const id = ++request;
    const selection = window.getSelection();
    anchor = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
    mount();
    pill.style.display = "none";
    clearTimeout(hideTimer);
    source.textContent = clipped.replace(/\s+/gu, " ");
    meta.textContent = text.length > MAX_CHARS ? `（只翻前 ${MAX_CHARS} 字）` : "";
    result.className = "result";
    result.innerHTML = '<span class="dots">翻譯中</span>';
    card.classList.add("show");
    placeCard();
    let answer;
    try {
      answer = await chrome.runtime.sendMessage({ type: "alice-translate", text: clipped });
    } catch {
      answer = { ok: false, error: "插件剛更新過，請重新整理這個頁面再試。" };
    }
    if (id !== request) return; // 已經有更新的翻譯
    if (answer?.ok) {
      result.textContent = answer.translation;
      meta.textContent = `${answer.target === "en" ? "→ 英文" : "→ 繁中"}・${(answer.durationMs / 1000).toFixed(1)} 秒`;
    } else {
      result.className = "result error";
      result.textContent = answer?.error || "翻譯失敗";
    }
    placeCard(); // 譯文出來後高度變了，重新決定放上方或下方
    scheduleHide();
  }

  document.addEventListener("mouseup", (event) => {
    if (event.composedPath().includes(host)) return;
    setTimeout(showPill, 0);
  });
  document.addEventListener("mousedown", (event) => {
    if (!event.composedPath().includes(host)) pill.style.display = "none";
  });
  document.addEventListener("scroll", () => { pill.style.display = "none"; placeCard(); }, true);
  window.addEventListener("resize", placeCard);
  document.addEventListener("keydown", (event) => {
    if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === "t" || event.key === "T")) {
      const text = selectedText();
      if (text !== "") { event.preventDefault(); translate(text); }
    } else if (event.key === "Escape") {
      card.classList.remove("show");
      pill.style.display = "none";
    }
  });
  pill.addEventListener("mousedown", (event) => event.preventDefault()); // 不要讓按鈕把選取清掉
  pill.addEventListener("click", () => translate(selectedText()));
  root.querySelector(".close").addEventListener("click", () => card.classList.remove("show"));
  root.querySelector(".copy").addEventListener("click", async (event) => {
    try {
      await navigator.clipboard.writeText(result.textContent);
      event.target.textContent = "已複製";
      setTimeout(() => { event.target.textContent = "複製"; }, 1200);
    } catch { /* 頁面不允許寫剪貼簿就算了 */ }
  });
  card.addEventListener("mouseenter", () => { hovering = true; clearTimeout(hideTimer); });
  card.addEventListener("mouseleave", () => { hovering = false; scheduleHide(); });
})();
