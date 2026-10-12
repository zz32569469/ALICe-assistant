// ALICE_PLAN 區塊的解析與結構驗證（spec-plans §2）。與設定相關的檢查（專案、角色、白名單）在 PlanService。

export const PLAN_BLOCK_MARKERS = { start: "<<<ALICE_PLAN", end: "ALICE_PLAN>>>" } as const;

export type PlanItemRequest = {
  key: string;
  title: string;
  /** read：Core 的唯讀部下；modify：Codex／Claude 寫檔 worker；session：派給該專案的同事 session（§27）。 */
  kind: "read" | "modify" | "session";
  project: string;
  role?: string;
  instructions: string;
  acceptance: string[];
  dependsOn: string[];
  risk: "normal" | "high";
  estimateMin?: number;
};

export type PlanRequest = {
  goal: string;
  items: PlanItemRequest[];
  risks: string[];
  decisions: string[];
  preauthorizeClaudeFallback: boolean;
  /** 要等這些計畫（id 或前 8 碼）完成才開始（§27 #3）。 */
  after: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export const GOAL_MAX_CHARS = 40;
export const ITEM_TITLE_MAX_CHARS = 24;

function checkReadableTitle(text: string, field: string, max: number): void {
  const length = Array.from(text.trim()).length;
  if (length > max) throw new Error(`${field} 太長（${length} 字，上限 ${max} 字）：請改成主人一眼看得懂的白話短標題，技術細節寫在 instructions 或 risks`);
  if (text.includes("`")) throw new Error(`${field} 不要放程式碼（反引號）：請改成白話，程式名稱寫在 instructions`);
}

function stringList(value: unknown, field: string, min: number, max: number): string[] {
  if (value === undefined && min === 0) return [];
  if (!Array.isArray(value) || value.length < min || value.length > max || !value.every(nonBlank)) {
    throw new Error(`${field} 必須是 ${min}～${max} 條非空白字串`);
  }
  return value.map((entry) => entry.trim());
}

export function parsePlanBlock(blockText: string): PlanRequest {
  if (!blockText.startsWith(PLAN_BLOCK_MARKERS.start) || !blockText.endsWith(PLAN_BLOCK_MARKERS.end)) {
    throw new Error("計畫區塊標記不完整");
  }
  let value: unknown;
  try {
    value = JSON.parse(blockText.slice(PLAN_BLOCK_MARKERS.start.length, -PLAN_BLOCK_MARKERS.end.length).trim());
  } catch {
    throw new Error("計畫區塊 JSON 格式錯誤");
  }
  if (!isRecord(value)) throw new Error("計畫內容必須是 JSON 物件");
  const allowed = new Set(["goal", "items", "risks", "decisions", "preauthorizeClaudeFallback", "after"]);
  const unknownKey = Object.keys(value).find((key) => !allowed.has(key));
  if (unknownKey !== undefined) throw new Error(`計畫包含不支援的欄位：${unknownKey}`);
  if (!nonBlank(value.goal)) throw new Error("goal 必須是非空白字串");
  // 標題要主人一眼看得懂（主人 2026-10-01 要求）：短、白話、不放程式碼。細節寫在 items 與 risks。
  checkReadableTitle(value.goal, "goal", GOAL_MAX_CHARS);
  if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > 10) {
    throw new Error("items 必須有 1～10 項");
  }
  if (value.preauthorizeClaudeFallback !== undefined && typeof value.preauthorizeClaudeFallback !== "boolean") {
    throw new Error("preauthorizeClaudeFallback 必須是布林值");
  }

  const seen = new Set<string>();
  const items = value.items.map((raw, index): PlanItemRequest => {
    if (!isRecord(raw)) throw new Error(`items[${index}] 必須是物件`);
    const itemAllowed = new Set(["key", "title", "kind", "project", "role", "instructions", "acceptance", "dependsOn", "risk", "estimateMin"]);
    const badKey = Object.keys(raw).find((key) => !itemAllowed.has(key));
    if (badKey !== undefined) throw new Error(`items[${index}] 包含不支援的欄位：${badKey}`);
    if (typeof raw.key !== "string" || !/^[a-z0-9-]{1,20}$/u.test(raw.key)) {
      throw new Error(`items[${index}].key 必須是 1～20 個小寫英數字或連字號`);
    }
    if (raw.key.endsWith("-review")) throw new Error(`items[${index}].key 不可用 -review 結尾（保留給自動審查）`);
    if (seen.has(raw.key)) throw new Error(`items[${index}].key 重複：${raw.key}`);
    for (const field of ["title", "project", "instructions"] as const) {
      if (!nonBlank(raw[field])) throw new Error(`items[${index}].${field} 必須是非空白字串`);
    }
    checkReadableTitle(raw.title as string, `items[${index}].title`, ITEM_TITLE_MAX_CHARS);
    if (raw.kind !== "read" && raw.kind !== "modify" && raw.kind !== "session") {
      throw new Error(`items[${index}].kind 必須是 read、modify 或 session`);
    }
    if (raw.kind === "read" && !nonBlank(raw.role)) throw new Error(`items[${index}] 是 read，必須指定 role`);
    if (raw.role !== undefined && !nonBlank(raw.role)) throw new Error(`items[${index}].role 必須是非空白字串`);
    const dependsOn = stringList(raw.dependsOn, `items[${index}].dependsOn`, 0, 10);
    for (const dependency of dependsOn) {
      if (!seen.has(dependency)) throw new Error(`items[${index}].dependsOn 只能引用前面的項目：${dependency}`);
    }
    if (raw.risk !== undefined && raw.risk !== "normal" && raw.risk !== "high") {
      throw new Error(`items[${index}].risk 必須是 normal 或 high`);
    }
    if (raw.estimateMin !== undefined
        && (typeof raw.estimateMin !== "number" || !Number.isFinite(raw.estimateMin) || raw.estimateMin <= 0)) {
      throw new Error(`items[${index}].estimateMin 必須是正數`);
    }
    seen.add(raw.key);
    return {
      key: raw.key,
      title: (raw.title as string).trim(),
      kind: raw.kind,
      project: (raw.project as string).trim(),
      ...(nonBlank(raw.role) ? { role: raw.role.trim() } : {}),
      instructions: (raw.instructions as string).trim(),
      acceptance: stringList(raw.acceptance, `items[${index}].acceptance`, 1, 10),
      dependsOn,
      risk: raw.risk === "high" ? "high" : "normal",
      ...(typeof raw.estimateMin === "number" ? { estimateMin: raw.estimateMin } : {}),
    };
  });

  return {
    goal: value.goal.trim(),
    items,
    risks: stringList(value.risks, "risks", 0, 10),
    decisions: stringList(value.decisions, "decisions", 0, 10),
    preauthorizeClaudeFallback: value.preauthorizeClaudeFallback === true,
    after: stringList(value.after, "after", 0, 5).map((id) => {
      if (!/^[0-9a-f-]{8,36}$/u.test(id)) throw new Error(`after 的計畫 id 格式錯誤：${id}`);
      return id;
    }),
  };
}

/**
 * 取出「<標籤>：」段落：同一行的文字；同一行空白時，取緊接在後的條列行（- • * 或數字開頭）。
 * 空白或「無／沒有／none」視為沒有。
 */
export function extractLabeledSection(text: string, label: RegExp, maxChars = 500): string | undefined {
  const lines = text.split(/\r?\n/u);
  const marker = new RegExp(`${label.source}[：:]`, "u");
  const index = lines.findIndex((line) => marker.test(line));
  if (index < 0) return undefined;
  // 部下常把標籤寫成 Markdown 粗體（**規格衝突：**），冒號後的 ** 不是內容（2026-10-01 實測，衝突內容因此遺失）。
  const sameLine = lines[index]!.replace(new RegExp(`^.*?${label.source}[：:]\\s*`, "u"), "").replace(/^[*_]+|[*_]+$/gu, "").trim();
  const parts: string[] = sameLine === "" ? [] : [sameLine];
  if (sameLine === "") {
    // 同一行沒有內容：往下收到空行或下一個段落標籤為止（條列或一般文字都收）。
    // 第一行是條列就只收條列（條列後的一般文字不算）；第一行是一般文字就收到空行為止。
    const nextLabel = /^\s*(?:#+\s*)?[*_]*\s*(需要決定|規格衝突|發現的差異|(?:知識庫)?回寫候選|審查結論)[：:]/u;
    const bullet = /^\s*(?:[-•*]|\d+[.)、])\s*\S/u;
    let bulletsOnly: boolean | undefined;
    for (const line of lines.slice(index + 1)) {
      if (line.trim() === "" || nextLabel.test(line)) break;
      bulletsOnly ??= bullet.test(line);
      if (bulletsOnly && !bullet.test(line)) break;
      parts.push(line.trim());
    }
  }
  const body = parts.join("\n").trim();
  if (body === "" || /^[-•*]?\s*(無|沒有|none|n\/a)[。.]?$/iu.test(body)) return undefined;
  return Array.from(body).slice(0, maxChars).join("");
}

/** 規格衝突的內容會成為暫停原因，保留較多文字讓主人與艾莉絲看得到完整原文（艾莉絲的建議）。 */
export function extractSpecConflict(text: string): string | undefined {
  return extractLabeledSection(text, /規格衝突/u, 2_000);
}

/**
 * 什麼才算「規格衝突」（艾莉絲的建議，主人 2026-10-01 採用）：會影響這一題答案或這次修改、
 * 或與規格書、需求清單、驗收標準互相矛盾的才暫停；其他差異列在「發現的差異」，照常完成。
 */
export const SPEC_CONFLICT_RULE = "「規格衝突」只寫會影響這一題答案或這次修改、或與規格書、需求清單、驗收標準互相矛盾的地方（寫了計畫會暫停等主人決定）。其他不影響本題的差異（例如摘要和知識庫內容對不上、文件寫法不一致），寫在「發現的差異：」段落，照常完成回答。";

/** 知識庫回寫候選（C3、Q24）：每一條候選一個元素。 */
export function extractWritebackCandidates(text: string): string[] {
  return extractListSection(text, /(?:知識庫)?回寫候選/u);
}

/** 不影響答案的差異（不暫停計畫，只記錄）：每一條一個元素。 */
export function extractDifferences(text: string): string[] {
  return extractListSection(text, /發現的差異/u);
}

function extractListSection(text: string, label: RegExp): string[] {
  const section = extractLabeledSection(text, label, 2_000);
  if (section === undefined) return [];
  return section
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s*(?:[-•*]|\d+[.)、])\s*/u, "").trim())
    .filter((line) => line !== "" && !/^(無|沒有|none|n\/a)[。.]?$/iu.test(line));
}

/** 審查 worker 的結論：最後一個「審查結論：」行。 */
export function extractReviewVerdict(text: string): { passed: boolean; reason: string } | undefined {
  const matches = [...text.matchAll(/審查結論[：:]\s*(通過|不通過)(.*)$/gmu)];
  const last = matches.at(-1);
  if (last === undefined) return undefined;
  return { passed: last[1] === "通過", reason: (last[2] ?? "").replace(/^[（(]|[）)]$/gu, "").trim() };
}
