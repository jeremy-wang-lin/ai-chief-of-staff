import { asc, eq, gte } from "drizzle-orm";
import type { Ctx } from "../db.ts";
import { notes, type Note } from "../schema.ts";
import { alive, paginate, stamps, touch, type Page } from "./helpers.ts";
import { nowLocal, todayLocal } from "../time.ts";
import { logDeletion } from "../revisions.ts";
import type { DeleteOpts } from "./helpers.ts";

/**
 * 可為 NULL 的欄位收 `| null` = 呼叫端表達「清空這一欄」的方式(undefined 則是「別動它」)。
 * date 不在其中:它是 NOT NULL 且有預設,「沒填」的意思是「用今天」,不是「沒有日期」。
 */
export interface NewNote {
  bodyMd: string;
  title?: string | null; date?: string; type?: Note["type"];
  attendees?: string | null; projectId?: number | null;
}

export function createNote(ctx: Ctx, input: NewNote): Note {
  // 用 ?? 而非 { date: today, ...input }:呼叫端(如 CLI)常直接帶入 date: undefined,
  // 展開後會蓋掉預設值並撞上 NOT NULL。
  return ctx.db.insert(notes).values({ ...input, date: input.date ?? todayLocal(), ...stamps() }).returning().get();
}

/** 單筆讀取(已 soft-deleted 視同不存在)。 */
export function getNote(ctx: Ctx, id: number): Note | undefined {
  return ctx.db.select().from(notes).where(alive(notes.deletedAt, eq(notes.id, id))).get();
}

export interface NoteFilter extends Page {
  type?: Note["type"]; projectId?: number; since?: string;
}

export function listNotes(ctx: Ctx, f: NoteFilter = {}): Note[] {
  const q = ctx.db.select().from(notes).where(alive(
    notes.deletedAt,
    f.type ? eq(notes.type, f.type) : undefined,
    f.projectId ? eq(notes.projectId, f.projectId) : undefined,
    f.since ? gte(notes.date, f.since) : undefined,
  )).orderBy(asc(notes.id)).$dynamic();
  return paginate(q, f).all();
}

/** 查無資料或已 soft-deleted 時回傳 undefined(交由上層轉成 NOT_FOUND)。 */
export function updateNote(ctx: Ctx, id: number, patch: Partial<NewNote> & { processedAt?: string }): Note | undefined {
  return ctx.db.update(notes).set({ ...patch, ...touch() })
    .where(alive(notes.deletedAt, eq(notes.id, id))).returning().get();
}

export function softDeleteNote(ctx: Ctx, id: number, opts: DeleteOpts = {}): void {
  const t = nowLocal();
  ctx.sqlite.transaction(() => {
    const info = ctx.db.update(notes).set({ deletedAt: t, updatedAt: t })
      .where(alive(notes.deletedAt, eq(notes.id, id))).run();
    if (info.changes > 0) logDeletion(ctx, "notes", id, opts.actor ?? "human", opts.workflow);
  })();
}
