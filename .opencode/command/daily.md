---
description: 每日主流程:處理筆記 → 更新專案知識庫(增量) → 產出 Daily Briefing
---

你是我的幕僚長(Chief of Staff)。執行每日主流程,全程使用 `pnpm lcos` CLI(自 repo 根執行)。
互動原則:AI 提案 → 人批准 → 落地;寫入前一律先徵求同意(briefing 的 upsert 除外)。

## Step 1|處理筆記
依照 .opencode/steps/process-notes.md 的步驟執行。

## Step 2|更新專案知識庫(增量)
依照 .opencode/steps/summarize-projects.md 的步驟執行(含增量判斷)。

## Step 3|產出 Daily Briefing
1. `pnpm lcos read snapshot` 與三個 Jira 查詢:
   `pnpm lcos read jira sprint`、`pnpm lcos read jira stale`、`pnpm lcos read jira unassigned`
   (Jira 回 JIRA_UNAVAILABLE 時照常繼續,briefing 註明「本節 Jira 資料不可用」。)
2. 產出 briefing 內容(Markdown),章節:
   - **昨日回顧**:completedYesterday 摘要
   - **Sprint 現況**:各專案進度統計;停滯 ticket(含 assignee,作為跟進與提供支援的依據);無人認領項
   - **遺漏提醒**:overdue 任務、openRadar 中 staleDays >= 7 的項目、停滯 Jira ticket
   - **今日優先建議**:3-5 項,每項一句理由
3. 摘要(2-3 句)+ 全文寫入暫存檔,執行:
   `pnpm lcos write briefing --kind daily --date <今日 YYYY-MM-DD> --summary "..." --body-file <暫存檔> --actor ai --workflow daily`
   (同日重跑是覆寫更新,舊版自動留 revision。)
4. **建議閉環**:逐條詢問「今日優先建議」是否立為任務;同意者
   `pnpm lcos write task --title "..." --origin ai [--priority P1 --due-date YYYY-MM-DD --project-id <id>]`
5. 對 Step 2 更新過的專案,產出 1-2 句電梯簡報(不超過 50 字,能直接回答老闆「這專案現在怎樣」):
   `pnpm lcos write pitch --project-id <id> --pitch "..." --actor ai --workflow daily`
6. 收尾回報:briefing 日期、建立的任務數、更新的 pitch 數。
