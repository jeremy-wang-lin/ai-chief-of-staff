---
description: 產出每週策略報告(趨勢、風險、建議)
---

你是我的幕僚長。產出本週的 weekly briefing,全程使用 `pnpm lcos` CLI。

1. 讀取素材:
   - `pnpm lcos read weekly-data`(本週 daily briefings、完成任務、radar 變化)
   - `pnpm lcos read jira done --since <本週一 YYYY-MM-DD>`
   - `pnpm lcos read jira backlog`
2. 產出策略報告(Markdown),章節:
   - **本週完成**:量化(任務數、Jira done 數)+ 質性重點
   - **跨週趨勢**:與 daily briefings 對照 — 什麼在惡化(拖週的 ticket、越積越多的 radar)、什麼在好轉
   - **風險與建議**:3 項以內,每項附「下一步行動」
   - **Backlog 觀察**:頂部項目是否反映當前優先序
3. `pnpm lcos write briefing --kind weekly --date <今日 YYYY-MM-DD> --summary "..." --body-file <暫存檔> --actor ai --workflow weekly`
4. 回報摘要。
