// npm run studio：在瀏覽器開啟 Web Studio（W-2）。token 放在網址的 # 後面，不會送到伺服器；網頁讀到後存起來並清掉網址上的 token。

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { readToken } from "../auth/token.js";
import { loadConfig } from "../config.js";

const config = loadConfig(process.env.ALICE_CONFIG);
let token: string;
try {
  token = readToken(config.tokenPath);
} catch {
  console.error("找不到 Alice Core token；請先執行 npm start。");
  process.exit(1);
}

const base = `http://127.0.0.1:${config.port}`;
try {
  const response = await fetch(`${base}/api/health`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
} catch {
  console.error(`Alice Core 沒有在 ${base} 執行；請先執行 npm start。`);
  process.exit(1);
}
if (!existsSync(join(config.studioDir, "index.html"))) {
  console.error("Web Studio 尚未建置：在 repo 根目錄執行 cd studio && npm install && npm run build");
  process.exit(1);
}

const url = `${base}/#token=${encodeURIComponent(token)}`;
// rundll32 直接把網址交給預設瀏覽器，不經過 cmd 的字元解析（# 與 & 不會被吃掉）。
const opener = process.platform === "win32"
  ? spawn("rundll32", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore", windowsHide: true })
  : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" });
opener.on("error", () => {
  console.error("無法自動開啟瀏覽器，請手動開啟上面的網址。");
});
opener.unref();
console.log(`已開啟 Web Studio：${base}/`);
console.log("如果瀏覽器沒有開啟，請手動開啟這個網址（含登入用的 token，不要分享給別人）：");
console.log(url);
