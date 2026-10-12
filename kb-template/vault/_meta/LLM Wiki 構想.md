---
type: meta
title: LLM Wiki 構想
tags: [meta]
created: {{DATE}}
---

> 本知識庫的原始設計理念（唯讀參考）。實際落地的規範見 `CLAUDE.md`。

<!-- 範本不附原文：請把 Andrej Karpathy 的〈LLM Wiki〉原文自行貼在這裡（原作者的文章，不隨範本散布）。 -->

## 重點（範本附註，非原文）

- 讓 LLM 持續撰寫與維護一組互相連結的 Markdown 頁面，而不是每次查詢才檢索原文。
- 三層：`raw/`（原始文件，不可變）、`wiki/`（LLM 維護的頁面）、schema（本 vault 的 `CLAUDE.md`）。
- 四種操作：Ingest（納入新來源）、Query（查詢，有價值的答案回存）、Lint（健康檢查）、index／log 維護。
