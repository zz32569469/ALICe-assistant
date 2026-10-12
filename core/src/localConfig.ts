import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type KnowledgeBaseConfig = {
  path: string;
  summaryPage: string;
  rolesDir: string;
};

export type WorkerProjectConfig = {
  name: string;
  path: string;
  role: string;
  /** 專案以外、部下也可唯讀的資料夾（例如放在別處的更改紀錄）。 */
  readDirs: string[];
  /** 計畫可以派修改類工作到這個專案（Q11 白名單）。 */
  writable?: boolean;
  /** Claude 寫檔 worker 可執行的指令；未設定時用預設（C2-1）。 */
  testCommands?: string[];
  /** 改到這些路徑即視為高風險；未設定時用預設（C2-4）。 */
  highRiskPatterns?: string[];
  /** 禁止修改的路徑樣式；改到就暫停（R2-1）。 */
  forbiddenPatterns?: string[];
  /** git 看不到、要另外以檔案雜湊監看的路徑（repo 相對，可為 symlink；R2-1）。有變動就暫停。 */
  watchPaths?: string[];
  /** Codex 不可用或額度不足時：auto 自動改派 Claude（K7）；ask 一律暫停問主人（R2-3）。 */
  claudeFallback?: "auto" | "ask";
  /** 報告附更改紀錄草稿（R2-4）。 */
  changeLogDraft?: boolean;
  /** 這個專案（角色）對應的同事 session 名稱（§27 D-2），例：<專案> - 工程師。 */
  session?: string;
};

/** 艾莉絲可以直接寫 .md 文件的資料夾（§45），例：專案整理文件放在 Obsidian 可開的地方。不可以是知識庫。 */
export type DocRootConfig = { name: string; path: string };

export type LocalConfig = {
  path: string;
  knowledgeBase: KnowledgeBaseConfig | null;
  docRoots: DocRootConfig[];
  codexAvailable: boolean;
  projects: WorkerProjectConfig[];
  workerTimeoutMin: number;
  summaryEnabled: boolean;
  workersEnabled: boolean;
  /** §57：派工相關功能（部下、計畫、Codex 任務、傳訊給同事 session）要不要放進艾莉絲的提示；預設關，ALICE 以追蹤任務為主。 */
  dispatch: boolean;
  /** §58：從其他裝置開 Web Studio 的網址來源（例：Tailscale serve 的 https://<電腦>.<tailnet>.ts.net），加進允許的來源。 */
  remoteOrigins: string[];
  /** 專案卡的流程設定檔（JSON，見 games/workflow.ts）；null 用內建的通用流程。 */
  workflowFile: string | null;
  /** 選取翻譯的固定用語 [原文, 譯文]（團隊術語）。 */
  translateGlossary: Array<[string, string]>;
  reasons: string[];
};

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const parentDirectory = dirname(moduleDirectory);
const coreDirectory = parentDirectory.endsWith(`${resolve("/").slice(-1)}dist`)
  ? dirname(parentDirectory)
  : parentDirectory;
const repoRoot = dirname(coreDirectory);

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function disabled(path: string, reason: string): LocalConfig {
  return {
    path,
    knowledgeBase: null,
    docRoots: [],
    codexAvailable: false,
    projects: [],
    workerTimeoutMin: 5,
    summaryEnabled: false,
    workersEnabled: false,
    dispatch: false,
    remoteOrigins: [],
    workflowFile: null,
    translateGlossary: [],
    reasons: [reason],
  };
}

export function loadLocalConfig(
  overridePath = process.env.ALICE_LOCAL,
  warn: (message: string) => void = console.warn,
): LocalConfig {
  const path = resolve(overridePath ?? resolve(repoRoot, "alice.local.json"));
  if (!existsSync(path)) {
    const result = disabled(path, `本機設定不存在：${path}`);
    warn(`知識庫摘要與部下功能停用：${result.reasons[0]}`);
    return result;
  }

  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("根層必須是 JSON 物件");
    }
    raw = parsed as Record<string, unknown>;
  } catch (error) {
    const reason = `本機設定無法解析：${error instanceof Error ? error.message : String(error)}`;
    warn(`知識庫摘要與部下功能停用：${reason}`);
    return disabled(path, reason);
  }

  const reasons: string[] = [];
  const knowledge = typeof raw.knowledgeBase === "object" && raw.knowledgeBase !== null
    ? raw.knowledgeBase as Record<string, unknown>
    : {};
  let knowledgeBase: KnowledgeBaseConfig | null = null;
  if (nonBlank(knowledge.path) && nonBlank(knowledge.summaryPage) && nonBlank(knowledge.rolesDir)) {
    knowledgeBase = {
      path: resolve(knowledge.path),
      summaryPage: knowledge.summaryPage,
      rolesDir: knowledge.rolesDir,
    };
  } else {
    reasons.push("knowledgeBase.path、summaryPage、rolesDir 必須是非空白字串");
  }

  const projects: WorkerProjectConfig[] = [];
  if (!Array.isArray(raw.projects)) {
    reasons.push("projects 必須是陣列");
  } else {
    raw.projects.forEach((value, index) => {
      const project = typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
      if (!nonBlank(project.name) || !nonBlank(project.path) || !nonBlank(project.role)) {
        reasons.push(`projects[${index}] 的 name、path、role 必須是非空白字串`);
        return;
      }
      const readDirs = project.readDirs ?? [];
      if (!Array.isArray(readDirs) || !readDirs.every(nonBlank)) {
        reasons.push(`projects[${index}].readDirs 必須是非空白字串陣列`);
        return;
      }
      const optionalList = (key: "testCommands" | "highRiskPatterns" | "forbiddenPatterns" | "watchPaths"): string[] | undefined | null => {
        const value = project[key];
        if (value === undefined) return undefined;
        return Array.isArray(value) && value.every(nonBlank) ? value : null;
      };
      const testCommands = optionalList("testCommands");
      const highRiskPatterns = optionalList("highRiskPatterns");
      const forbiddenPatterns = optionalList("forbiddenPatterns");
      const watchPaths = optionalList("watchPaths");
      if (testCommands === null || highRiskPatterns === null || forbiddenPatterns === null || watchPaths === null
          || (project.writable !== undefined && typeof project.writable !== "boolean")
          || (project.changeLogDraft !== undefined && typeof project.changeLogDraft !== "boolean")
          || (project.session !== undefined && !nonBlank(project.session))
          || (project.claudeFallback !== undefined && project.claudeFallback !== "auto" && project.claudeFallback !== "ask")) {
        reasons.push(`projects[${index}] 的 writable、changeLogDraft 必須是布林值，claudeFallback 必須是 auto 或 ask，testCommands、highRiskPatterns、forbiddenPatterns、watchPaths 必須是非空白字串陣列`);
        return;
      }
      const toAbsolute = (value: string) => (isAbsolute(value) ? resolve(value) : resolve(dirname(path), value));
      projects.push({
        name: project.name,
        path: toAbsolute(project.path),
        role: project.role,
        readDirs: readDirs.map(toAbsolute),
        ...(project.writable === true ? { writable: true } : {}),
        ...(testCommands === undefined ? {} : { testCommands }),
        ...(highRiskPatterns === undefined ? {} : { highRiskPatterns }),
        ...(forbiddenPatterns === undefined ? {} : { forbiddenPatterns }),
        ...(watchPaths === undefined ? {} : { watchPaths }),
        ...(project.claudeFallback === undefined ? {} : { claudeFallback: project.claudeFallback as "auto" | "ask" }),
        ...(project.changeLogDraft === true ? { changeLogDraft: true } : {}),
        ...(nonBlank(project.session) ? { session: project.session.trim() } : {}),
      });
    });
  }
  if (projects.length === 0) reasons.push("沒有可用的部下專案設定");

  const docRoots: DocRootConfig[] = [];
  if (raw.docRoots !== undefined) {
    if (!Array.isArray(raw.docRoots)) reasons.push("docRoots 必須是陣列");
    else raw.docRoots.forEach((value, index) => {
      const entry = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
      if (!nonBlank(entry.name) || !nonBlank(entry.path)) {
        reasons.push(`docRoots[${index}] 的 name、path 必須是非空白字串`);
        return;
      }
      const rootPath = isAbsolute(entry.path) ? resolve(entry.path) : resolve(dirname(path), entry.path);
      // 知識庫只能由知識庫管理員寫入（全域規則），文件資料夾不能在知識庫裡面。
      const kb = knowledgeBase?.path;
      const insideKb = kb !== undefined && (() => {
        const rel = relative(kb.toLowerCase(), rootPath.toLowerCase());
        return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
      })();
      if (insideKb) {
        reasons.push(`docRoots[${index}] 在知識庫裡面，已略過（知識庫只能由知識庫管理員寫入）`);
        return;
      }
      docRoots.push({ name: entry.name.trim(), path: rootPath });
    });
  }

  const codex = typeof raw.codex === "object" && raw.codex !== null
    ? raw.codex as Record<string, unknown>
    : {};
  if (typeof codex.available !== "boolean") reasons.push("codex.available 必須是布林值");
  const timeout = raw.workerTimeoutMin === undefined ? 5 : raw.workerTimeoutMin;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
    reasons.push("workerTimeoutMin 必須是正數，已使用預設值 5");
  }

  if (raw.dispatch !== undefined && typeof raw.dispatch !== "boolean") reasons.push("dispatch 必須是布林值，已使用預設值 false");
  const remoteOrigins: string[] = [];
  if (raw.remoteOrigins !== undefined) {
    if (!Array.isArray(raw.remoteOrigins)) reasons.push("remoteOrigins 必須是陣列");
    else for (const value of raw.remoteOrigins) {
      // 只收 https 的來源（協定＋主機＋選用的埠，沒有路徑）：Tailscale serve 有憑證，瀏覽器才會給 crypto 等安全環境才有的功能。
      if (typeof value === "string" && /^https:\/\/[a-z0-9.-]+(:\d+)?$/iu.test(value.trim())) remoteOrigins.push(value.trim().toLowerCase());
      else reasons.push(`remoteOrigins 裡的「${String(value)}」不是 https://主機 的格式，已略過`);
    }
  }
  let workflowFile: string | null = null;
  if (raw.workflowFile !== undefined) {
    if (nonBlank(raw.workflowFile)) workflowFile = resolve(dirname(path), raw.workflowFile);
    else reasons.push("workflowFile 必須是非空白字串（流程設定檔的路徑），已改用內建的通用流程");
  }
  const translateGlossary: Array<[string, string]> = [];
  if (raw.translateGlossary !== undefined) {
    if (Array.isArray(raw.translateGlossary)) {
      for (const entry of raw.translateGlossary) {
        if (Array.isArray(entry) && entry.length === 2 && nonBlank(entry[0]) && nonBlank(entry[1])) translateGlossary.push([entry[0], entry[1]]);
        else reasons.push("translateGlossary 的每一項要是 [原文, 譯文]，格式不對的已略過");
      }
    } else reasons.push("translateGlossary 必須是陣列");
  }
  for (const reason of reasons) warn(`本機功能設定：${reason}`);
  const summaryEnabled = knowledgeBase !== null;
  const workersEnabled = knowledgeBase !== null && projects.length > 0;
  return {
    path,
    knowledgeBase,
    docRoots,
    codexAvailable: codex.available === true,
    projects,
    workerTimeoutMin: typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 ? timeout : 5,
    summaryEnabled,
    workersEnabled,
    dispatch: raw.dispatch === true,
    remoteOrigins,
    workflowFile,
    translateGlossary,
    reasons,
  };
}

