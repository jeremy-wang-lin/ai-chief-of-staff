-- ⚠️ 已套用過的 migration 一律不得再編輯。
--    journal 以資料夾內的 folderMillis 判斷「這支跑過了沒」,而不是檔案內容;
--    真實 DB 存在後才改內容,舊 DB 永遠不會補跑改動的部分、新 DB 卻跑得到 —— 兩邊 schema 靜靜地分岔。
--    要改就新增下一號 migration。

-- 1) briefings (kind,date) 唯一性改為只約束「活著的」列。
--    0000 建的是全表唯一索引,它與 soft delete 直接衝突:
--    刪掉的 briefing 仍占著 (kind,date),同一天就再也寫不進新的 briefing
--    (upsertBriefing 只看得見存活列,因此會走 insert 分支,然後撞上 UNIQUE constraint failed)。
--    改成 partial index 後,已刪除的舊列不再參與唯一性,存活列之間的唯一性完全不變。
--    註:drizzle 的 schema DSL 表達不出 partial index,因此 schema.ts 不再宣告這個索引,由本 migration 擁有。
DROP INDEX `briefings_kind_date`;--> statement-breakpoint
CREATE UNIQUE INDEX `briefings_kind_date` ON `briefings` (`kind`,`date`) WHERE `deleted_at` IS NULL;--> statement-breakpoint

-- 2) tasks.completed_at:完成時間的獨立時間戳。
--    在此之前「昨日完成/本週完成」是以 updated_at 推斷的,但 updated_at 會被任何編輯
--    (改標題、換負責人)推到今天,讓上週就完成的任務又出現在今天的快照裡。
--    純新增欄位(ALTER TABLE ADD COLUMN,不需重建表,因此與 foreign_keys=ON 無衝突):
--    舊列為 NULL,查詢端刻意排除 status=Done 但 completed_at IS NULL 的列。
ALTER TABLE `tasks` ADD `completed_at` text;
