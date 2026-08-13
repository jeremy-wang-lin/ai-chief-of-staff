import { mkdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Ctx } from "./db.ts";
import { todayLocal } from "./time.ts";

/**
 * 備份整個 DB 到 destDir/lcos-YYYY-MM-DD.db,回傳絕對路徑
 * (相對路徑在 JSON 輸出裡對呼叫端沒有意義 —— 它不一定和我們在同一個工作目錄)。
 *
 * 用 VACUUM INTO 而非複製檔案:WAL 模式下 data.db 本身可能落後於 -wal,
 * 直接 cp 會得到一份少了最近寫入(甚至結構不一致)的快照。
 * VACUUM INTO 由 SQLite 產出一份自足、已整理過的單檔副本,不需要一併搬 -wal/-shm。
 *
 * 先寫暫存檔再 rename 蓋過去:VACUUM INTO 拒絕寫入已存在的檔,
 * 但若改成「先刪當天那份再寫」,新備份中途失敗(磁碟滿、來源損毀)就會連舊的一起賠掉 ——
 * 備份程序自己把唯一的副本弄丟是最不能接受的失敗。
 * rename 在同一個檔案系統上是原子的,舊備份在新的一份完整寫出來之前都保持可讀。
 */
export function backupDb(ctx: Ctx, destDir: string): string {
  const dir = resolve(destDir);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `lcos-${todayLocal()}.db`);
  // 帶 pid 避免並行備份互踩;上次崩潰留下的同名殘骸要先清掉,否則 VACUUM INTO 會拒絕寫入。
  const tmp = `${dest}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  try {
    ctx.sqlite.prepare("VACUUM INTO ?").run(tmp);
    renameSync(tmp, dest);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return dest;
}
