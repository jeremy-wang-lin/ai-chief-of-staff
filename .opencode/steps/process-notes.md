# 步驟:處理筆記(process-notes)

此檔為共用步驟定義,被 /daily(Step 1)與 /process-notes 引用 — 修改此檔即同時生效,不得複製。

1. 執行 `pnpm lcos read unprocessed-notes` 取得待處理筆記(所有類型,含 Scratch)。若為空,回報「沒有待處理筆記」並結束此步驟。
2. 逐筆閱讀 bodyMd,提案三類動作(**寧可少偵測,不過度推斷**):
   - **建任務**:明確的 action item(AR、「要做」、「下週前」)→ 提案 title/priority/dueDate/projectId
   - **浮雷達**:發現的問題或風險(還沒成單、不適合放 Jira 的)→ 提案 title/severity/projectId
   - **Scratch 歸類升級**:這其實是 Meeting/Discussion/Thinking?→ 提案 type/title/projectId
3. 將全部提案一次列給使用者(表格:筆記 → 動作 → 內容),等待逐項或整批批准。**未經批准不得寫入。**
4. 依批准結果執行:
   - `pnpm lcos write task --title "..." --origin ai --note-id <id> [--priority P1 --due-date YYYY-MM-DD --project-id <id>]`
   - `pnpm lcos write radar --title "..." --note-id <id> [--severity P1 --project-id <id>]`
   - `pnpm lcos update note --id <id> --type Meeting --title "..." [--project-id <id>]`(歸類升級)
5. 每筆筆記處理完(無論是否建立任何項目):`pnpm lcos update note --id <id> --processed true`
6. 回報:處理了幾筆、建立了什麼、略過了什麼。
