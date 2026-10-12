---
type: tool
title: Obsidian
aliases: [vault, 儲存庫, wikilink, 關係圖, Graph view]
domain: 知識庫工具
tags: [工具/Obsidian]
projects: []
sources: ["[[_meta/LLM Wiki 構想]]"]
created: {{DATE}}
updated: {{DATE}}
status: draft
---

# Obsidian

> Obsidian 是以本機 Markdown 檔案為基礎的筆記軟體。在 [[LLM Wiki]] 的做法中，它扮演「IDE」：LLM 負責寫頁面，人用 Obsidian 瀏覽連結、看關係圖、檢查結果。

## 基本資訊

| 項目 | 內容 |
| --- | --- |
| 類別 | 筆記 / 知識管理軟體 |
| 儲存格式 | 一般 Markdown 檔 + `.obsidian/` 設定資料夾 |
| 官方文件 | https://help.obsidian.md |

## 核心用法

| 功能 | 用法 | 在知識庫中的用途 |
| --- | --- | --- |
| vault | 一個資料夾就是一個 vault，設定存在 `.obsidian/` | 整個知識庫資料夾 `{{KB_PATH}}` |
| wikilink | `[[頁名]]`、`[[頁名\|顯示文字]]`、`[[頁名#章節]]` | 頁面交叉連結 |
| aliases | frontmatter `aliases: [...]`，連結與搜尋時可用別名找到頁面 | 讓[[術語表]]的別名都能連到標準名稱頁 |
| 關係圖 | Graph view | 看出核心頁與孤兒頁 |
| 反向連結 | Backlinks 面板 | 檢查某概念被哪些頁面引用 |
| 模板 | 核心外掛 Templates，指定模板資料夾 | 各類頁面的固定結構 |
| 附件資料夾 | 設定 → 檔案與連結 → 附件資料夾路徑 | 集中存放圖片 |
| 排除檔案 | 設定 → 檔案與連結 → 排除的檔案（`userIgnoreFilters`） | 讓封存資料不出現在搜尋與關係圖 |

## 在本知識庫的設定

- `.obsidian/app.json`：`attachmentFolderPath = raw/assets`、`newLinkFormat = shortest`、`userIgnoreFilters = ["_meta/archive/"]`。
- `.obsidian/templates.json`：模板資料夾 `_meta/templates`。
- 下載剪輯文章的圖片：設定 → 快捷鍵，搜尋「Download attachments for current file」並綁定。

## 注意事項

- `newLinkFormat = shortest` 時，不同資料夾有同名檔案會讓連結指向不明確；知識庫規範要求頁名全庫唯一。
- 排除檔案只影響搜尋與關係圖，被排除資料夾裡的頁面仍可用連結開啟。
- LLM 無法一次讀取 Markdown 內嵌的圖片，需先讀文字，再個別讀取引用的圖片。

## 相關

- [[LLM Wiki]]
