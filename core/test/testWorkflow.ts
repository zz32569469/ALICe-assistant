// 測試用的兩條線流程（和內建的單線通用流程分開，用來測多條線、別名、負責 session 與角色頁對照）。

import { parseWorkflow, type Workflow } from "../src/games/workflow.js";

export const TEST_WORKFLOW: Workflow = parseWorkflow({
  tracks: [
    {
      key: "build",
      label: "開發",
      stages: ["需求確認", "實作", "整合測試", "上線準備", "完成"],
      aliases: { "寫程式": "實作", "測試": "整合測試" },
      sessions: [{ pattern: "\\s-\\s*dev 2$", fromStage: "上線準備" }, { pattern: "\\s-\\s*dev$" }],
      guide: { page: "開發工程師.md", rows: { "需求確認": "1", "實作": "2", "整合測試": "3", "上線準備": "4" } },
    },
    {
      key: "docs",
      label: "文件",
      stages: ["等待實作", "撰寫", "審閱", "完成"],
      sessions: [{ pattern: "\\s-\\s*writer$" }],
      guide: { page: "文件工程師.md", rows: { "撰寫": "1", "審閱": "3" } },
    },
  ],
  taskSources: ["需求", "回饋", "客戶", "其他"],
  firstVersion: "1.0.0",
  rules: ["測試規則：兩條線都到「上線準備」才一起上線。"],
  newProjectQuestions: "測試欄位甲、測試欄位乙",
  newProjectSteps: ["固定加一個任務「設計文件」。"],
  meetingRules: ["- 測試會議規則。"],
});
