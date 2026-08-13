# 步驟:更新專案知識庫(summarize-projects)

共用步驟定義,被 /daily(Step 2)與 /summarize-projects 引用。

1. `pnpm lcos read projects --status Active` 取得 Active 專案。
2. **增量判斷**(/daily 模式;/summarize-projects 指定專案時跳過此判斷):對每個專案執行
   `pnpm lcos read project-context --project-id <id>`,比較關聯 notes/tasks/radar 的 updatedAt 與
   `pnpm lcos read revisions --table projects --row-id <id> --field body_md` 最新一筆的 createdAt;
   無新素材的專案跳過(控制每日 token 成本)。
3. 對每個入選專案,基於 project-context(現有 body_md + 關聯項目全文)按主題合併知識:
   - 保留仍有效的舊決策;更新已變動的;完成項移至「已完成成果」;每段附來源(哪篇筆記/任務)
   - 章節建議:專案概況 / 架構與技術決策 / 當前風險 / 已完成成果
4. 將新版全文寫入暫存檔後執行:
   `pnpm lcos write project-body --project-id <id> --body-file <暫存檔> --actor ai --workflow summarize-projects`
   (覆寫自動留 revision,舊版永遠可還原 — 放心覆寫,但內容必須是「合併」而非「重寫遺忘」。)
5. 回報:更新了哪些專案、各自的重點變化;跳過了哪些(無新素材)。
