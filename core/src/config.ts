import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type WritableRepo = {
  path: string;
  description: string;
  /** Claude 寫檔 worker 可執行的指令（C2-1）。 */
  testCommands?: string[];
  /** 改到這些路徑即視為高風險（C2-4）。 */
  highRiskPatterns?: string[];
  /** 禁止修改的路徑樣式；改到就暫停（R2-1）。 */
  forbiddenPatterns?: string[];
  /** git 看不到、要另外以檔案雜湊監看的路徑（repo 相對，可為 symlink；R2-1）。有變動就暫停。 */
  watchPaths?: string[];
  /** Codex 不可用或額度不足時：auto 自動改派 Claude（K7）；ask 一律暫停問主人（R2-3）。 */
  claudeFallback?: "auto" | "ask";
  /** 報告附更改紀錄草稿（R2-4）。 */
  changeLogDraft?: boolean;
};

export const DEFAULT_TEST_COMMANDS = ["npm test"];
export const DEFAULT_HIGH_RISK_PATTERNS = ["**/*.xls", "**/*.xlsx", "docs/**", "**/*spec*", "**/config/**", "**/*.config.*"];

export type Config = {
  idleTimeoutMin: number;
  nightStart: string;
  nightEnd: string;
  nightIdleMin: number;
  failuresToSleep: number;
  energyHighWindowMin: number;
  energyLowStart: string;
  energyLowEnd: string;
  longTalkMin: number;
  historyLimit: number;
  port: number;
  host: string;
  model: string;
  effort: "low" | "medium" | "high" | "max";
  claudePath: string;
  replyTimeoutMs: number;
  requireThinking: boolean;
  maxReplyAttempts: number;
  personaPath: string;
  factsPath: string;
  /** 艾莉絲的自我改進建議檔（Q23，只附加）。 */
  suggestionsPath: string;
  dataDir: string;
  /** Web Studio 建置後的靜態檔目錄（studio/dist）。 */
  studioDir: string;
  /** §50：艾莉絲對話時可以用 Read 看的資料夾（美術圖），其他路徑一律讀不到。 */
  artDirs: string[];
  /** 轉接 session 的名稱（同事回覆艾莉絲時 SendMessage 的對象，§27）。 */
  relaySession: string;
  tokenPath: string;
  allowedOrigins: string[];
  /** §65 Codex 任務看板伺服器與啟動腳本（找不到腳本時 Studio 不顯示 Codex 分頁的資料）。 */
  codexBoardUrl: string;
  codexBoardScript: string | null;
  plans: {
    approvalTimeoutMin: number;
    /** Codex 額度門檻（已用百分比），達到即視為不足（C2-3）。 */
    codexPrimaryMaxPercent: number;
    codexSecondaryMaxPercent: number;
  };
  tools: {
    codex: {
      enabled: boolean;
      /** 是否使用 Codex：auto 依登入狀態判定；false 時寫程式一律改派 Claude 寫檔 worker（K7）。 */
      use: "auto" | boolean;
      /** 執行期由 main 判定後填入；未判定時視為不可用。 */
      available?: boolean;
      codexPath: string;
      repos: Record<string, WritableRepo>;
      approvalTimeoutMin: number;
      taskTimeoutMin: number;
    };
  };
};

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const parentDirectory = dirname(moduleDirectory);
const coreDirectory = parentDirectory.endsWith(`${resolve("/").slice(-1)}dist`)
  ? dirname(parentDirectory)
  : parentDirectory;
const repoRoot = dirname(coreDirectory);
const defaultTokenPath = platform() === "win32"
  ? resolve(process.env.APPDATA ?? resolve(homedir(), "AppData", "Roaming"), "alice", "token")
  : resolve(homedir(), ".config", "alice", "token");

export const defaultConfig: Config = {
  idleTimeoutMin: 30,
  nightStart: "01:00",
  nightEnd: "07:00",
  nightIdleMin: 5,
  failuresToSleep: 3,
  energyHighWindowMin: 120,
  energyLowStart: "22:00",
  energyLowEnd: "07:00",
  longTalkMin: 120,
  historyLimit: 50,
  port: 7788,
  host: "127.0.0.1",
  model: "claude-opus-5-5",
  effort: "medium",
  claudePath: "claude",
  replyTimeoutMs: 180_000,
  requireThinking: true,
  maxReplyAttempts: 3,
  personaPath: resolve(repoRoot, "persona", "alice.md"),
  factsPath: resolve(repoRoot, "memory", "facts.md"),
  suggestionsPath: resolve(repoRoot, "docs", "艾莉絲的建議.md"),
  dataDir: resolve(repoRoot, "data"),
  studioDir: resolve(repoRoot, "studio", "dist"),
  artDirs: [resolve(repoRoot, "art"), resolve(repoRoot, "studio", "src", "assets", "alice-pixel"), resolve(repoRoot, "docs", "art")],
  relaySession: "ALICE",
  tokenPath: defaultTokenPath,
  allowedOrigins: [],
  codexBoardUrl: "http://127.0.0.1:47777",
  codexBoardScript: resolve(homedir(), ".claude", "scripts", "codex-board.mjs"),
  plans: {
    approvalTimeoutMin: 10,
    codexPrimaryMaxPercent: 85,
    codexSecondaryMaxPercent: 90,
  },
  tools: {
    codex: {
      enabled: true,
      use: "auto",
      codexPath: "codex",
      // 預設不放任何可修改的 repo（新電腦上未必有 alice-sandbox，2026-10-01 實測）。
      // 要開放修改的專案寫在 alice.local.json：projects[].writable = true。
      repos: {},
      approvalTimeoutMin: 5,
      taskTimeoutMin: 30,
    },
  },
};

export function loadConfig(overridePath?: string): Config {
  if (!overridePath || !existsSync(overridePath)) {
    return { ...defaultConfig };
  }

  const override = JSON.parse(readFileSync(overridePath, "utf8")) as Partial<Config> & {
    tools?: { codex?: Partial<Config["tools"]["codex"]> };
    plans?: Partial<Config["plans"]>;
  };
  return {
    ...defaultConfig,
    ...override,
    plans: { ...defaultConfig.plans, ...override.plans },
    tools: {
      codex: {
        ...defaultConfig.tools.codex,
        ...override.tools?.codex,
        repos: override.tools?.codex?.repos ?? defaultConfig.tools.codex.repos,
      },
    },
  };
}
