-- Custom SQL migration file, put your code below! --
-- ⚠️ 已套用過的 migration 一律不得再編輯。
--    journal 以資料夾內的 folderMillis 判斷「這支跑過了沒」,而不是檔案內容;
--    真實 DB 存在後才改內容,舊 DB 永遠不會補跑改動的部分、新 DB 卻跑得到 —— 兩邊 schema 靜靜地分岔。
--    要改就新增下一號 migration(例如要調整 trigger,就在新 migration 裡 DROP 後重建)。
-- FTS5 全文索引:主索引 fts_main(所有內容表)+ 歷史索引 fts_revisions(舊值)。
-- 由 trigger 自動維護,repos 無需改動;soft-deleted 的列不會重新進入主索引。
CREATE VIRTUAL TABLE fts_main USING fts5(tbl UNINDEXED, rid UNINDEXED, title, body, tokenize='trigram');--> statement-breakpoint
CREATE VIRTUAL TABLE fts_revisions USING fts5(rid UNINDEXED, old_value, created_at UNINDEXED, tbl UNINDEXED, field UNINDEXED, tokenize='trigram');--> statement-breakpoint
-- _ai:新增即進索引。_au:先刪後補,補的條件是 deleted_at IS NULL —
--   soft delete 因此自動退出索引,trashRestore(UPDATE … deleted_at = NULL)自動回到索引。
-- _ad:硬刪的保險。目前程式沒有 hard delete 路徑,但將來若加 purge 不必再回頭改 trigger。
-- 效能註記:_au/_ad 的 DELETE 以 UNINDEXED 欄位(tbl/rid)過濾,fts5 無法用索引,
--   每次更新等同一次全索引掃描。個人規模(數千列)完全可接受;若日後量級變大,
--   再改成 external-content FTS(以 rowid 對應原表)即可。
CREATE TRIGGER projects_fts_ai AFTER INSERT ON projects BEGIN
  INSERT INTO fts_main(tbl,rid,title,body) VALUES ('projects', NEW.id, NEW.name, COALESCE(NEW.elevator_pitch,'') || ' ' || COALESCE(NEW.body_md,''));
END;--> statement-breakpoint
CREATE TRIGGER projects_fts_au AFTER UPDATE ON projects BEGIN
  DELETE FROM fts_main WHERE tbl='projects' AND rid=OLD.id;
  INSERT INTO fts_main(tbl,rid,title,body)
    SELECT 'projects', NEW.id, NEW.name, COALESCE(NEW.elevator_pitch,'') || ' ' || COALESCE(NEW.body_md,'')
    WHERE NEW.deleted_at IS NULL;
END;--> statement-breakpoint
CREATE TRIGGER projects_fts_ad AFTER DELETE ON projects BEGIN
  DELETE FROM fts_main WHERE tbl='projects' AND rid=OLD.id;
END;--> statement-breakpoint
CREATE TRIGGER tasks_fts_ai AFTER INSERT ON tasks BEGIN
  INSERT INTO fts_main(tbl,rid,title,body) VALUES ('tasks', NEW.id, NEW.title, COALESCE(NEW.body_md,''));
END;--> statement-breakpoint
CREATE TRIGGER tasks_fts_au AFTER UPDATE ON tasks BEGIN
  DELETE FROM fts_main WHERE tbl='tasks' AND rid=OLD.id;
  INSERT INTO fts_main(tbl,rid,title,body)
    SELECT 'tasks', NEW.id, NEW.title, COALESCE(NEW.body_md,'') WHERE NEW.deleted_at IS NULL;
END;--> statement-breakpoint
CREATE TRIGGER tasks_fts_ad AFTER DELETE ON tasks BEGIN
  DELETE FROM fts_main WHERE tbl='tasks' AND rid=OLD.id;
END;--> statement-breakpoint
CREATE TRIGGER radar_fts_ai AFTER INSERT ON radar BEGIN
  INSERT INTO fts_main(tbl,rid,title,body) VALUES ('radar', NEW.id, NEW.title, COALESCE(NEW.body_md,''));
END;--> statement-breakpoint
CREATE TRIGGER radar_fts_au AFTER UPDATE ON radar BEGIN
  DELETE FROM fts_main WHERE tbl='radar' AND rid=OLD.id;
  INSERT INTO fts_main(tbl,rid,title,body)
    SELECT 'radar', NEW.id, NEW.title, COALESCE(NEW.body_md,'') WHERE NEW.deleted_at IS NULL;
END;--> statement-breakpoint
CREATE TRIGGER radar_fts_ad AFTER DELETE ON radar BEGIN
  DELETE FROM fts_main WHERE tbl='radar' AND rid=OLD.id;
END;--> statement-breakpoint
CREATE TRIGGER notes_fts_ai AFTER INSERT ON notes BEGIN
  INSERT INTO fts_main(tbl,rid,title,body) VALUES ('notes', NEW.id, COALESCE(NEW.title,''), NEW.body_md);
END;--> statement-breakpoint
CREATE TRIGGER notes_fts_au AFTER UPDATE ON notes BEGIN
  DELETE FROM fts_main WHERE tbl='notes' AND rid=OLD.id;
  INSERT INTO fts_main(tbl,rid,title,body)
    SELECT 'notes', NEW.id, COALESCE(NEW.title,''), NEW.body_md WHERE NEW.deleted_at IS NULL;
END;--> statement-breakpoint
CREATE TRIGGER notes_fts_ad AFTER DELETE ON notes BEGIN
  DELETE FROM fts_main WHERE tbl='notes' AND rid=OLD.id;
END;--> statement-breakpoint
CREATE TRIGGER briefings_fts_ai AFTER INSERT ON briefings BEGIN
  INSERT INTO fts_main(tbl,rid,title,body) VALUES ('briefings', NEW.id, NEW.kind || ' ' || NEW.date, NEW.summary || ' ' || NEW.body_md);
END;--> statement-breakpoint
CREATE TRIGGER briefings_fts_au AFTER UPDATE ON briefings BEGIN
  DELETE FROM fts_main WHERE tbl='briefings' AND rid=OLD.id;
  INSERT INTO fts_main(tbl,rid,title,body)
    SELECT 'briefings', NEW.id, NEW.kind || ' ' || NEW.date, NEW.summary || ' ' || NEW.body_md WHERE NEW.deleted_at IS NULL;
END;--> statement-breakpoint
CREATE TRIGGER briefings_fts_ad AFTER DELETE ON briefings BEGIN
  DELETE FROM fts_main WHERE tbl='briefings' AND rid=OLD.id;
END;--> statement-breakpoint
CREATE TRIGGER revisions_fts_ai AFTER INSERT ON revisions WHEN NEW.old_value IS NOT NULL BEGIN
  INSERT INTO fts_revisions(rid, old_value, created_at, tbl, field)
  VALUES (NEW.id, NEW.old_value, NEW.created_at, NEW.table_name, NEW.field);
END;--> statement-breakpoint
-- Backfill:trigger 只負責之後的寫入,既有資料要在這裡補進索引。
-- 每條 SELECT 的欄位組合必須與對應的 _ai trigger 完全一致 —
-- test/search.test.ts 會把這幾條 INSERT 從本檔抽出來重跑,驗證它們真的能重建索引。
INSERT INTO fts_main(tbl,rid,title,body)
  SELECT 'projects', id, name, COALESCE(elevator_pitch,'') || ' ' || COALESCE(body_md,'') FROM projects WHERE deleted_at IS NULL;--> statement-breakpoint
INSERT INTO fts_main(tbl,rid,title,body)
  SELECT 'tasks', id, title, COALESCE(body_md,'') FROM tasks WHERE deleted_at IS NULL;--> statement-breakpoint
INSERT INTO fts_main(tbl,rid,title,body)
  SELECT 'radar', id, title, COALESCE(body_md,'') FROM radar WHERE deleted_at IS NULL;--> statement-breakpoint
INSERT INTO fts_main(tbl,rid,title,body)
  SELECT 'notes', id, COALESCE(title,''), body_md FROM notes WHERE deleted_at IS NULL;--> statement-breakpoint
INSERT INTO fts_main(tbl,rid,title,body)
  SELECT 'briefings', id, kind || ' ' || date, summary || ' ' || body_md FROM briefings WHERE deleted_at IS NULL;--> statement-breakpoint
INSERT INTO fts_revisions(rid, old_value, created_at, tbl, field)
  SELECT id, old_value, created_at, table_name, field FROM revisions WHERE old_value IS NOT NULL;
