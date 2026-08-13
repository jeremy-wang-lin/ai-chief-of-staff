import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.ts";

/**
 * 連線與 migration 的唯一入口。
 *
 * ⚠️ 寫新 migration 前的檢查清單(migrate() 與 foreign_keys=ON 的互動)
 * ────────────────────────────────────────────────────────────────────
 * openDb 在 migrate() **之前**就把 foreign_keys 打開,而 SQLite 改不了既有欄位:
 * DROP COLUMN 之外的任何欄位變更(改型別、加/移除 NOT NULL、改預設值)都得走
 * 「建新表 → 複製資料 → DROP 舊表 → RENAME」,drizzle-kit 也是這樣產 SQL 的。
 * 那條路徑在 foreign_keys=ON 之下會出事:DROP 舊表的瞬間,指向它的子表外鍵
 * 不是被拒絕就是被 RENAME 悄悄改指向暫存表。tasks/radar/notes 三張表都有外鍵指向
 * projects(以及彼此),因此這是實際會踩到的情況,不是理論風險。
 *
 * 所以:
 *  1. 優先選「純新增」的變更 —— ADD COLUMN(可為 NULL)、CREATE INDEX、CREATE TRIGGER
 *     都不必重建表,與 foreign_keys 無衝突(0002 的 tasks.completed_at 即是)。
 *  2. 真的必須重建表時,該 migration 必須自己在最前面 `PRAGMA foreign_keys=OFF;`、
 *     結束前 `PRAGMA foreign_keys=ON;`,並在中間加 `PRAGMA foreign_key_check;`。
 *     注意 PRAGMA 在 transaction 內無效,drizzle 的 migrate() 會把整批包進 transaction ——
 *     這種 migration 得改由呼叫端在 openDb 之外單獨執行,不能只丟進 drizzle 資料夾了事。
 *  3. 已套用的 migration 一律不得再編輯(journal 以 folderMillis 判定是否跑過),只能往後追加。
 */
export interface Ctx {
  db: BetterSQLite3Database<typeof schema>;
  sqlite: Database.Database;
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

export function openDb(path: string): Ctx {
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  // WAL 允許多個 reader 與一個 writer 並存,但兩個 writer 相撞時預設是「立刻 SQLITE_BUSY」。
  // 之後 REST server 與 CLI 會同時開同一個檔,那個預設等同「誰慢一步誰就收到錯誤」。
  // 5 秒的 busy_timeout 讓後到的 writer 先重試 —— 本機規模的寫入都是毫秒級,
  // 真的等滿 5 秒代表有東西卡住,那時才該讓錯誤浮上來。
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return { db, sqlite };
}

/**
 * 關閉連線。長駐行程(REST server、測試)必須有明確的收尾點:
 * 不關的話 WAL 檔不會被 checkpoint 回主檔,備份與 vacuum 都會看到落後的內容。
 * 關閉後對同一個 ctx 的任何查詢都會丟錯,這是刻意的 —— 用一個已關閉的連線繼續查
 * 應該立刻爆炸,而不是靜靜地回空集合。
 */
export function closeDb(ctx: Ctx): void {
  ctx.sqlite.close();
}
