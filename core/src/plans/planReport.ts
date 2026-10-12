// 計畫報告檔與回寫候選檔（C3、Q27、Q24）。報告只存本機 data/，不進版控。

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { SnapshotDiff } from "../tasks/snapshot.js";
import type { Task } from "../tasks/taskStore.js";
import type { UsageRecord } from "../usage/usageStore.js";
import type { Plan, PlanItem } from "./planStore.js";

const STATUS_LABELS: Record<Plan["status"], string> = {
  pending_approval: "等待確認",
  queued: "排隊中",
  running: "執行中",
  paused: "暫停",
  completed: "完成",
  cancelled: "已取消",
  rejected: "主人拒絕",
  expired: "確認逾時",
  failed: "失敗",
};

const ITEM_LABELS: Record<PlanItem["status"], string> = {
  pending: "未開始",
  running: "執行中",
  done: "完成",
  failed: "失敗",
  cancelled: "已取消",
};

function localDate(iso: string): string {
  const date = new Date(iso);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

function localTime(iso: string | null): string {
  if (iso === null) return "—";
  const date = new Date(iso);
  return `${localDate(iso)} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function cell(text: string): string {
  return text.replace(/\|/gu, "\\|").replace(/\r?\n/gu, "<br>");
}

export function reportFileName(plan: Plan): string {
  return `${localDate(plan.createdAt)}-${plan.id.slice(0, 8)}.md`;
}

type ItemResult = {
  text?: string;
  summary?: string;
  verdict?: string;
  diff?: SnapshotDiff;
  highRisk?: string[];
  tests?: Array<{ command: string; result: string; detail: string }>;
  acceptance?: Array<{ criterion: string; met: boolean; evidence: string }>;
  unfinished?: string[];
  writeback?: string[];
  /** 不影響答案、不暫停計畫的差異（艾莉絲的建議，2026-10-01 採用）。 */
  differences?: string[];
  verification?: {
    commands: Array<{ command: string; exitCode: number | null; timedOut: boolean; durationMs: number; failures: number }>;
    newFailures: string[];
    fixed: string[];
    baselineFailures: number;
    afterFailures: number;
  };
};

/** Core 驗收的一行摘要，例：「`npx vue-tsc --noEmit` 通過；`npm run test:<核心合約測試>` 失敗 11 項（與開工前相同）」。 */
export function verificationSummary(verification: NonNullable<ItemResult["verification"]>): string {
  const parts = verification.commands.map((entry) => {
    if (entry.timedOut) return `\`${entry.command}\` 逾時`;
    return entry.failures === 0 && entry.exitCode === 0 ? `\`${entry.command}\` 通過` : `\`${entry.command}\` 失敗 ${entry.failures} 項`;
  });
  const notes: string[] = [];
  if (verification.newFailures.length > 0) notes.push(`新增失敗 ${verification.newFailures.length} 項`);
  else if (verification.baselineFailures > 0) notes.push("沒有新增失敗，其餘與開工前相同");
  if (verification.fixed.length > 0) notes.push(`比開工前少 ${verification.fixed.length} 項失敗`);
  return `${parts.join("；")}${notes.length === 0 ? "" : `（${notes.join("；")}）`}`;
}

function changeCategory(paths: string[]): string {
  if (paths.length > 0 && paths.every((path) => /^docs\//u.test(path) || /\.md$/iu.test(path))) return "文件";
  if (paths.some((path) => /^(electron\/simulation\/stats|src\/components\/reports)\//u.test(path))) return "統計";
  if (paths.some((path) => /\.xlsx?$/iu.test(path))) return "設定表";
  return "程式";
}

/** 更改紀錄草稿（R2-4）：依知識庫模板〈更改紀錄頁〉「紀錄」段的寫法，每個專案一段。 */
export function renderChangeLogDraft(plan: Plan, items: PlanItem[], projects: readonly string[], tasks: readonly Task[] = []): string[] {
  const lines: string[] = [];
  for (const project of projects) {
    const done = items.filter((item) => item.kind === "modify" && item.project === project && item.status === "done");
    if (done.length === 0) continue;
    lines.push("", `## 更改紀錄草稿（${project}）`, "",
      "> 依知識庫模板〈更改紀錄頁〉「紀錄」段的寫法。確認內容後由主人或工程師貼進該專案的更改紀錄（知識庫外），需要時一併更新「目前進度」表。");
    const byDate = new Map<string, Map<string, string[]>>();
    for (const item of done) {
      const result = (item.result ?? {}) as ItemResult;
      // 重做過的項目：前面嘗試新增的檔，最後一次快照會看成「修改」；以 git 的角度仍是新增。
      const addedEarlier = new Set(tasks
        .filter((task) => task.planId === plan.id && task.goal.includes(`・${item.key}）`))
        .flatMap((task) => (task.diff as SnapshotDiff | null)?.added ?? []));
      const diffView = result.diff === undefined ? undefined : {
        added: [...new Set([...result.diff.added, ...addedEarlier])].filter((path) => !result.diff!.deleted.includes(path)).sort(),
        modified: result.diff.modified.filter((path) => !addedEarlier.has(path)),
        deleted: result.diff.deleted,
      };
      const paths = diffView === undefined ? [] : [...diffView.added, ...diffView.modified, ...diffView.deleted];
      const date = localDate(item.endedAt ?? plan.createdAt);
      const category = changeCategory(paths);
      const review = items.find((candidate) => candidate.reviewOf === item.key && candidate.status === "done");
      const changes = diffView === undefined ? "（沒有快照差異）" : [
        diffView.added.length > 0 ? `新增 ${diffView.added.join("、")}` : "",
        diffView.modified.length > 0 ? `修改 ${diffView.modified.join("、")}` : "",
        diffView.deleted.length > 0 ? `刪除 ${diffView.deleted.join("、")}` : "",
      ].filter((part) => part !== "").join("；");
      const outcome = [
        result.verification === undefined ? "" : `Core 驗收：${verificationSummary(result.verification)}`,
        review === undefined ? "" : "審查通過",
      ].filter((part) => part !== "").join("；");
      const entry = [
        `- **${item.title}**`,
        `  - 改動：${changes}（計畫 ${plan.id.slice(0, 8)}・${item.key}，${item.executor ?? "—"} 執行）`,
        `  - 結果：${outcome === "" ? "完成" : outcome}。（未提交）`,
      ];
      const categories = byDate.get(date) ?? new Map<string, string[]>();
      categories.set(category, [...(categories.get(category) ?? []), ...entry]);
      byDate.set(date, categories);
    }
    for (const [date, categories] of [...byDate].sort(([left], [right]) => left.localeCompare(right))) {
      lines.push("", `### ${date}`);
      for (const category of ["設定表", "程式", "統計", "驗證腳本", "文件"]) {
        const entries = categories.get(category);
        if (entries !== undefined) lines.push("", `#### ${category}`, ...entries);
      }
    }
  }
  return lines;
}

export function collectWriteback(items: PlanItem[]): Array<{ item: PlanItem; candidate: string }> {
  return items.flatMap((item) => ((item.result as ItemResult | null)?.writeback ?? []).map((candidate) => ({ item, candidate })));
}

export function renderPlanReport(input: { plan: Plan; items: PlanItem[]; tasks: Task[]; usage: UsageRecord[]; now: Date; changeLogProjects?: readonly string[] }): string {
  const { plan, items, tasks, usage } = input;
  const usageFor = (item: PlanItem): UsageRecord[] => {
    const ids = new Set<string>();
    if (item.refId !== null) ids.add(item.refId);
    for (const task of tasks) if (task.goal.includes(`・${item.key}）`)) ids.add(task.id);
    return usage.filter((record) => ids.has(record.refId));
  };
  const tokens = (records: UsageRecord[]): number => records.reduce((sum, record) => sum + record.inputTokens + record.outputTokens, 0);
  const cacheTokens = (records: UsageRecord[]): number => records.reduce((sum, record) => sum + record.cacheReadInputTokens, 0);

  const lines: string[] = [
    `# 計畫報告：${plan.goal}`,
    "",
    `- 計畫：\`${plan.id}\``,
    `- 狀態：${STATUS_LABELS[plan.status]}${plan.pauseReason ? `（${plan.pauseReason}）` : ""}`,
    `- 建立：${localTime(plan.createdAt)}；核准：${localTime(plan.decidedAt)}（${plan.decidedBy ?? "—"}）；結束：${localTime(plan.endedAt)}`,
    `- 報告產生：${localTime(input.now.toISOString())}`,
    ...(plan.pauseDetail ? [`- 暫停／結束原因：${plan.pauseDetail}`] : []),
    "",
    "## 項目總覽",
    "",
    "| # | 項目 | 類型 | 專案 | 執行者 | 嘗試 | 狀態 | token（輸入＋輸出／快取讀取） |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...items.map((item) => {
      const records = usageFor(item);
      return `| ${item.key} | ${cell(item.title)} | ${item.kind}${item.risk === "high" ? "（高風險）" : ""} | ${cell(item.project)} | ${item.executor ?? "—"} | ${item.attempts} | ${ITEM_LABELS[item.status]} | ${tokens(records)}／${cacheTokens(records)} |`;
    }),
    "",
    "## 各項目結果",
  ];

  for (const item of items) {
    const result = (item.result ?? {}) as ItemResult;
    lines.push("", `### ${item.key}. ${item.title}`, "");
    if (item.dependsOn.length > 0) lines.push(`- 依賴：${item.dependsOn.join("、")}`);
    lines.push("- 驗收標準：", ...item.acceptance.map((criterion) => `  - ${criterion}`));
    if (result.acceptance !== undefined) {
      lines.push("- 驗收結果：", ...result.acceptance.map((entry) => `  - ${entry.met ? "✅" : "❌"} ${entry.criterion}（${entry.evidence}）`));
    }
    if (result.tests !== undefined && result.tests.length > 0) {
      lines.push("- 測試：", ...result.tests.map((entry) => `  - \`${entry.command}\`：${entry.result}（${entry.detail}）`));
    }
    if (result.diff !== undefined) {
      lines.push(
        `- 變更（快照）：新增 ${result.diff.added.join("、") || "無"}；修改 ${result.diff.modified.join("、") || "無"}；刪除 ${result.diff.deleted.join("、") || "無"}`,
      );
    }
    if (result.verification !== undefined) {
      lines.push(`- Core 驗收：${verificationSummary(result.verification)}`);
      if (result.verification.newFailures.length > 0) lines.push(...result.verification.newFailures.slice(0, 20).map((key) => `  - 新增失敗：${key}`));
    }
    if (result.highRisk !== undefined && result.highRisk.length > 0) lines.push(`- 高風險路徑：${result.highRisk.join("、")}`);
    if (result.summary !== undefined) lines.push(`- 執行者摘要：${result.summary}`);
    if (result.verdict !== undefined) lines.push(`- 審查結論：${result.verdict}`);
    if (result.text !== undefined) lines.push("- 回報：", "", ...result.text.split(/\r?\n/u).map((line) => `  > ${line}`));
    if (result.differences !== undefined && result.differences.length > 0) {
      lines.push("- 發現的差異（不影響本項目，未暫停）：", ...result.differences.map((entry) => `  - ${entry}`));
    }
    if (result.unfinished !== undefined && result.unfinished.length > 0) {
      lines.push("- 未完成：", ...result.unfinished.map((entry) => `  - ${entry}`));
    }
    if (item.error !== null) lines.push(`- 錯誤：${item.error}`);
  }

  const unfinished = items.filter((item) => item.status !== "done");
  lines.push("", "## 未完成事項", "");
  lines.push(...(unfinished.length === 0 ? ["- 無"] : unfinished.map((item) => `- ${item.key}. ${item.title}：${ITEM_LABELS[item.status]}${item.error ? `（${item.error}）` : ""}`)));

  const writeback = collectWriteback(items);
  lines.push("", "## 知識庫回寫候選", "");
  lines.push(...(writeback.length === 0 ? ["- 無"] : writeback.map(({ item, candidate }) => `- （${item.key}）${candidate}`)));

  lines.push(...renderChangeLogDraft(plan, items, input.changeLogProjects ?? [], tasks));

  lines.push("", "## 用量", "", `- 合計 token（輸入＋輸出）：${tokens(usage)}；快取讀取：${cacheTokens(usage)}`,
    `- 工作筆數：${usage.length}（艾莉絲本身的回覆不計入）`, "");
  if (plan.risks.length > 0) lines.push("## 計畫時列出的風險", "", ...plan.risks.map((risk) => `- ${risk}`), "");
  if (plan.decisions.length > 0) lines.push("## 計畫時需要主人決定的事", "", ...plan.decisions.map((decision) => `- ${decision}`), "");
  return lines.join("\n");
}

export function renderWriteback(plan: Plan, items: PlanItem[], now: Date): string | undefined {
  const writeback = collectWriteback(items);
  if (writeback.length === 0) return undefined;
  return [
    `# 知識庫回寫候選：${plan.goal}`,
    "",
    `- 計畫：\`${plan.id}\`（${STATUS_LABELS[plan.status]}）`,
    `- 整理時間：${localTime(now.toISOString())}`,
    "- 用法：由主人決定要不要送；要送時把這個檔案的路徑交給「知識庫管理員」session，由管理員整理並經主人同意後寫入（Q4、Q24）。",
    "",
    ...writeback.map(({ item, candidate }) => `- （${item.key}．${item.title}・${item.project}）${candidate}`),
    "",
  ].join("\n");
}

/** 寫出報告（同一個計畫覆寫同一個檔）與回寫候選檔；回傳兩個路徑。 */
export function writePlanFiles(dataDir: string, input: { plan: Plan; items: PlanItem[]; tasks: Task[]; usage: UsageRecord[]; now: Date; changeLogProjects?: readonly string[] }): {
  reportPath: string;
  writebackPath: string | undefined;
} {
  const reportDir = resolve(dataDir, "reports");
  mkdirSync(reportDir, { recursive: true });
  const reportPath = resolve(reportDir, reportFileName(input.plan));
  writeFileSync(reportPath, renderPlanReport(input), "utf8");
  const writeback = renderWriteback(input.plan, input.items, input.now);
  let writebackPath: string | undefined;
  if (writeback !== undefined) {
    const writebackDir = resolve(dataDir, "writeback");
    mkdirSync(writebackDir, { recursive: true });
    writebackPath = resolve(writebackDir, reportFileName(input.plan));
    writeFileSync(writebackPath, writeback, "utf8");
  }
  return { reportPath, writebackPath };
}
