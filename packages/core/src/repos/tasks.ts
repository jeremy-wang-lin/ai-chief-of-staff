import { asc, eq, lte, lt, ne, and } from "drizzle-orm";
import type { Ctx } from "../db.ts";
import { tasks, type TaskRow } from "../schema.ts";
import { alive, paginate, stamps, touch, type Page } from "./helpers.ts";
import { nowLocal, todayLocal } from "../time.ts";
import { logDeletion } from "../revisions.ts";
import type { DeleteOpts } from "./helpers.ts";

/**
 * 可為 NULL 的欄位一律收 `| null`:那是呼叫端表達「把這一欄清空」的唯一方式
 * (patch 裡的 undefined 意思是「別動它」)。drizzle 的 .set 會把 null 原樣寫成 NULL,
 * 所以 updateTask 不需要為此多做任何事 —— 但型別必須讓 null 進得來。
 */
export interface NewTask {
  title: string;
  status?: TaskRow["status"]; priority?: TaskRow["priority"];
  dueDate?: string | null; source?: TaskRow["source"]; origin?: TaskRow["origin"];
  owner?: string | null; projectId?: number | null; radarId?: number | null;
  noteId?: number | null; bodyMd?: string | null;
}

export interface TaskFilter extends Page {
  status?: TaskRow["status"]; priority?: TaskRow["priority"];
  projectId?: number; dueBefore?: string; overdue?: boolean; origin?: TaskRow["origin"];
  noteId?: number;
}

/**
 * completed_at 是**衍生**欄位,只由這條規則維護,不開放呼叫端直接寫入
 * (NewTask 因此沒有 completedAt)。開第二個寫入來源,遲早會出現「Done 卻沒有完成時間」
 * 或「完成時間停在上一次 Done」的列 —— 而那正是週報與快照唯一仰賴的欄位。
 *
 * 規則只有兩條:
 *  - 進入 Done 且尚無完成時間 → 蓋上現在
 *  - 離開 Done → 清成 NULL
 * Done → Done 之間的其他編輯(改標題、換負責人)刻意不動它:
 * 完成時間不該被無關的編輯改寫,那正是原本以 updated_at 推斷完成時間的毛病。
 */
function completionPatch(
  nextStatus: TaskRow["status"] | undefined,
  current: { status: TaskRow["status"]; completedAt: string | null },
): { completedAt?: string | null } {
  if (nextStatus === undefined) return {};
  if (nextStatus === "Done") return current.completedAt === null ? { completedAt: nowLocal() } : {};
  return current.status === "Done" ? { completedAt: null } : {};
}

export function createTask(ctx: Ctx, input: NewTask): TaskRow {
  // 一建立就是 Done(例如補記已完成的事)同樣要有完成時間,
  // 否則它會被所有以 completed_at 為界的查詢排除,看起來像從沒完成過。
  const completion = completionPatch(input.status, { status: "To-do", completedAt: null });
  return ctx.db.insert(tasks).values({ ...input, ...completion, ...stamps() }).returning().get();
}

/** 單筆讀取(已 soft-deleted 視同不存在)。 */
export function getTask(ctx: Ctx, id: number): TaskRow | undefined {
  return ctx.db.select().from(tasks).where(alive(tasks.deletedAt, eq(tasks.id, id))).get();
}

export function listTasks(ctx: Ctx, f: TaskFilter = {}): TaskRow[] {
  const q = ctx.db.select().from(tasks).where(alive(
    tasks.deletedAt,
    f.status ? eq(tasks.status, f.status) : undefined,
    f.priority ? eq(tasks.priority, f.priority) : undefined,
    f.projectId ? eq(tasks.projectId, f.projectId) : undefined,
    f.dueBefore ? lte(tasks.dueDate, f.dueBefore) : undefined,
    f.overdue ? and(lt(tasks.dueDate, todayLocal()), ne(tasks.status, "Done")) : undefined,
    f.origin ? eq(tasks.origin, f.origin) : undefined,
    f.noteId ? eq(tasks.noteId, f.noteId) : undefined,
  )).orderBy(asc(tasks.id)).$dynamic();
  return paginate(q, f).all();
}

/**
 * 查無資料或已 soft-deleted 時回傳 undefined(交由上層轉成 NOT_FOUND)。
 * 讀舊列與寫新值必須在同一 transaction:completed_at 的判斷依賴「更新前的 status」,
 * 中間被別的寫入插隊,算出來的完成時間就會對應到另一次狀態轉換。
 */
export function updateTask(ctx: Ctx, id: number, patch: Partial<NewTask>): TaskRow | undefined {
  return ctx.sqlite.transaction(() => {
    const current = getTask(ctx, id);
    if (!current) return undefined;
    return ctx.db.update(tasks)
      .set({ ...patch, ...completionPatch(patch.status, current), ...touch() })
      .where(alive(tasks.deletedAt, eq(tasks.id, id))).returning().get();
  })();
}

export function softDeleteTask(ctx: Ctx, id: number, opts: DeleteOpts = {}): void {
  const t = nowLocal();
  ctx.sqlite.transaction(() => {
    const info = ctx.db.update(tasks).set({ deletedAt: t, updatedAt: t })
      .where(alive(tasks.deletedAt, eq(tasks.id, id))).run();
    if (info.changes > 0) logDeletion(ctx, "tasks", id, opts.actor ?? "human", opts.workflow);
  })();
}
