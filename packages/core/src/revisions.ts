import { desc, eq, and } from "drizzle-orm";
import type { Ctx } from "./db.ts";
import { OpInputError } from "./errors.ts";
import { revisions, type Revision } from "./schema.ts";
import { nowLocal } from "./time.ts";

const OVERWRITABLE = {
  projects: new Set(["body_md", "elevator_pitch"]),
  briefings: new Set(["body_md"]),
} as const;

/** hasOwn 而非 in:否則 "constructor"/"toString" 會通過白名單檢查。 */
function isOverwritable(table: string, field: string): table is keyof typeof OVERWRITABLE {
  return Object.hasOwn(OVERWRITABLE, table)
    && OVERWRITABLE[table as keyof typeof OVERWRITABLE].has(field);
}

export interface OverwriteOpts {
  table: keyof typeof OVERWRITABLE;
  rowId: number;
  field: "body_md" | "elevator_pitch";
  newValue: string;
  actor: "ai" | "human";
  workflow?: string;
}

/** revisions 唯一的寫入點:append-only 的寫入面只有這一條 INSERT,全程式無 UPDATE/DELETE。 */
function insertRevision(
  ctx: Ctx, table: string, rowId: number, field: string,
  oldValue: string | null, actor: "ai" | "human", workflow: string | undefined, at: string,
): void {
  ctx.sqlite.prepare(
    "INSERT INTO revisions (table_name,row_id,field,old_value,actor,workflow,created_at) VALUES (?,?,?,?,?,?,?)"
  ).run(table, rowId, field, oldValue, actor, workflow ?? null, at);
}

export function overwriteWithRevision(ctx: Ctx, o: OverwriteOpts): void {
  if (!isOverwritable(o.table, o.field)) {
    throw new Error(`field not overwritable: ${o.table}.${o.field}`);
  }
  const t = nowLocal();
  const tx = ctx.sqlite.transaction(() => {
    const row = ctx.sqlite.prepare(`SELECT ${o.field} AS v FROM ${o.table} WHERE id=? AND deleted_at IS NULL`).get(o.rowId) as { v: string | null } | undefined;
    if (!row) throw new Error(`${o.table}#${o.rowId} not found`);
    insertRevision(ctx, o.table, o.rowId, o.field, row.v, o.actor, o.workflow, t);
    ctx.sqlite.prepare(`UPDATE ${o.table} SET ${o.field}=?, updated_at=? WHERE id=?`).run(o.newValue, t, o.rowId);
  });
  tx();
}

export function listRevisions(ctx: Ctx, f: { table: string; rowId: number; field?: string }): Revision[] {
  return ctx.db.select().from(revisions).where(and(
    eq(revisions.tableName, f.table),
    eq(revisions.rowId, f.rowId),
    ...(f.field ? [eq(revisions.field, f.field)] : []),
  )).orderBy(desc(revisions.id)).all();
}

export function restoreRevision(ctx: Ctx, revisionId: number, actor: "ai" | "human"): void {
  const rev = ctx.db.select().from(revisions).where(eq(revisions.id, revisionId)).get();
  if (!rev) throw new Error(`revision#${revisionId} not found`);
  /**
   * revisions 記的不只是可覆寫的內容欄位:soft delete 也寫一筆 field="deleted_at"。
   * 那種列沒有「把舊值寫回去」的意義(復原刪除是 trash restore 的事),
   * 而 overwriteWithRevision 對它只會丟一個泛用 Error —— 在邊界會被歸類成 OP_FAILED,
   * 使用者看到的是一個像系統故障的訊息,而不是「你指定的這筆 revision 不能還原」。
   * 這是輸入錯誤,就照輸入錯誤報。
   */
  if (!isOverwritable(rev.tableName, rev.field)) {
    throw new OpInputError(
      `revision#${revisionId} is not restorable: ${rev.tableName}.${rev.field} is not an overwritable field`,
    );
  }
  overwriteWithRevision(ctx, {
    table: rev.tableName as OverwriteOpts["table"],
    rowId: rev.rowId,
    field: rev.field as OverwriteOpts["field"],
    newValue: rev.oldValue ?? "",
    actor,
    workflow: "restore",
  });
}

/** 刪除紀錄:soft delete 時呼叫,field 固定為 deleted_at。呼叫端須與 UPDATE 同一 transaction。 */
export function logDeletion(ctx: Ctx, table: string, rowId: number, actor: "ai" | "human", workflow?: string): void {
  insertRevision(ctx, table, rowId, "deleted_at", null, actor, workflow, nowLocal());
}

/**
 * 復原紀錄:trashRestore 時呼叫,old_value 為被清掉的那個 deleted_at。
 * 刪除留痕、復原卻不留,歷史就只剩一半 —— 看得到誰刪的,看不到誰又把它撈回來。
 * old_value 存被清掉的時間戳,是為了讓「這筆曾在 X 時被刪、後來被復原」可以完整重建。
 * 呼叫端須與 UPDATE 同一 transaction。
 */
export function logRestore(
  ctx: Ctx, table: string, rowId: number,
  previousDeletedAt: string, actor: "ai" | "human", at: string,
): void {
  insertRevision(ctx, table, rowId, "deleted_at", previousDeletedAt, actor, "trash-restore", at);
}
