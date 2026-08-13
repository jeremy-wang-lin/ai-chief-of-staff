import type { Ctx } from "./db.ts";
import { logRestore } from "./revisions.ts";
import { nowLocal } from "./time.ts";

export interface TrashItem { table: string; id: number; label: string; deletedAt: string }

const LABEL_COL: Record<string, string> = {
  projects: "name", tasks: "title", radar: "title",
  notes: "COALESCE(title, substr(body_md,1,30))", briefings: "kind || ' ' || date",
};

/** hasOwn 而非 in:否則 "constructor"/"toString" 等原型鏈上的 key 會被當成合法表名。 */
function labelCol(table: string): string {
  if (!Object.hasOwn(LABEL_COL, table)) throw new Error(`unknown table: ${table}`);
  return LABEL_COL[table];
}

export function trashList(ctx: Ctx, table?: string): TrashItem[] {
  const tables = table ? [table] : Object.keys(LABEL_COL);
  const out: TrashItem[] = [];
  for (const t of tables) {
    const rows = ctx.sqlite.prepare(
      `SELECT id, ${labelCol(t)} AS label, deleted_at AS deletedAt FROM ${t} WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`
    ).all() as Omit<TrashItem, "table">[];
    out.push(...rows.map((r) => ({ table: t, ...r })));
  }
  return out;
}

/**
 * 從 trash 復原一筆資料。
 *
 * 復原與「記下這次復原」必須在同一個 transaction:刪除已經留痕了,復原卻沒有的話
 * 歷史只剩一半 —— 看得到誰刪的,看不到誰又把它撈回來、什麼時候撈的。
 * 同時把 updated_at 推到現在:對下游(FTS trigger、以 updated_at 為界的異動查詢)
 * 而言,「這筆列剛剛從無到有地回來了」本來就是一次異動。
 */
export function trashRestore(ctx: Ctx, table: string, id: number, actor: "ai" | "human" = "human"): void {
  labelCol(table); // 白名單檢查:未知表名在拼進 SQL 前就擋掉
  const t = nowLocal();
  ctx.sqlite.transaction(() => {
    // 先讀出被清掉的 deleted_at 當 old_value —— UPDATE 之後就再也讀不到了
    const row = ctx.sqlite.prepare(
      `SELECT deleted_at AS deletedAt FROM ${table} WHERE id = ? AND deleted_at IS NOT NULL`
    ).get(id) as { deletedAt: string } | undefined;
    if (!row) throw new Error(`${table}#${id} not in trash`);
    ctx.sqlite.prepare(`UPDATE ${table} SET deleted_at = NULL, updated_at = ? WHERE id = ?`).run(t, id);
    logRestore(ctx, table, id, row.deletedAt, actor, t);
  })();
}
