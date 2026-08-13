import { asc, eq } from "drizzle-orm";
import type { Ctx } from "../db.ts";
import { radar, type RadarItem } from "../schema.ts";
import { alive, paginate, stamps, touch, type Page } from "./helpers.ts";
import { nowLocal } from "../time.ts";
import { logDeletion } from "../revisions.ts";
import type { DeleteOpts } from "./helpers.ts";

/** 可為 NULL 的欄位收 `| null` = 呼叫端表達「清空這一欄」的方式(undefined 則是「別動它」)。 */
export interface NewRadar {
  title: string;
  severity?: RadarItem["severity"]; status?: RadarItem["status"];
  source?: string | null; owner?: string | null;
  projectId?: number | null; noteId?: number | null; bodyMd?: string | null;
}

export function createRadar(ctx: Ctx, input: NewRadar): RadarItem {
  return ctx.db.insert(radar).values({ ...input, ...stamps() }).returning().get();
}

/** 單筆讀取(已 soft-deleted 視同不存在)。 */
export function getRadar(ctx: Ctx, id: number): RadarItem | undefined {
  return ctx.db.select().from(radar).where(alive(radar.deletedAt, eq(radar.id, id))).get();
}

export interface RadarFilter extends Page {
  status?: RadarItem["status"]; severity?: RadarItem["severity"]; projectId?: number;
  noteId?: number;
}

export function listRadar(ctx: Ctx, f: RadarFilter = {}): RadarItem[] {
  const q = ctx.db.select().from(radar).where(alive(
    radar.deletedAt,
    f.status ? eq(radar.status, f.status) : undefined,
    f.severity ? eq(radar.severity, f.severity) : undefined,
    f.projectId ? eq(radar.projectId, f.projectId) : undefined,
    f.noteId ? eq(radar.noteId, f.noteId) : undefined,
  )).orderBy(asc(radar.id)).$dynamic();
  return paginate(q, f).all();
}

/** 查無資料或已 soft-deleted 時回傳 undefined(交由上層轉成 NOT_FOUND)。 */
export function updateRadar(ctx: Ctx, id: number, patch: Partial<NewRadar>): RadarItem | undefined {
  return ctx.db.update(radar).set({ ...patch, ...touch() })
    .where(alive(radar.deletedAt, eq(radar.id, id))).returning().get();
}

export function softDeleteRadar(ctx: Ctx, id: number, opts: DeleteOpts = {}): void {
  const t = nowLocal();
  ctx.sqlite.transaction(() => {
    const info = ctx.db.update(radar).set({ deletedAt: t, updatedAt: t })
      .where(alive(radar.deletedAt, eq(radar.id, id))).run();
    if (info.changes > 0) logDeletion(ctx, "radar", id, opts.actor ?? "human", opts.workflow);
  })();
}
