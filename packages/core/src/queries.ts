import { desc, eq, gte, isNull, lt, ne } from "drizzle-orm";
import type { Ctx } from "./db.ts";
import {
  briefings, notes, radar, tasks,
  type Briefing, type Note, type Project, type RadarItem, type TaskRow,
} from "./schema.ts";
import { alive } from "./repos/helpers.ts";
import { addDays, todayLocal } from "./time.ts";
import { getProject } from "./repos/projects.ts";

/**
 * 複合查詢層:所有「一次要餵給模型的資料」都在這裡於 SQL 端收斂。
 * 原則:絕不回傳全域清單讓上層自己挑(舊系統 §9-4 教訓),篩選一律落在資料層。
 */

/** 未處理 = processed_at IS NULL,涵蓋 Meeting/Discussion/Thinking/Scratch 全部類型。 */
export function listUnprocessedNotes(ctx: Ctx): Note[] {
  return ctx.db.select().from(notes).where(alive(notes.deletedAt, isNull(notes.processedAt))).all();
}

function noteLabel(n: Note): string {
  return n.title ?? n.bodyMd.split("\n")[0].slice(0, 40);
}

/** 兩個 'YYYY-MM-DD' 相距幾天(以中午起算避開 DST)。 */
function daysBetween(from: string, to: string): number {
  const ms = new Date(`${to}T12:00:00`).getTime() - new Date(`${from}T12:00:00`).getTime();
  return Math.round(ms / 86_400_000);
}

export interface Snapshot {
  today: string;
  dueToday: TaskRow[];
  overdue: TaskRow[];
  completedYesterday: TaskRow[];
  unprocessedNotes: { id: number; date: string; type: string; label: string }[];
  openRadar: (RadarItem & { staleDays: number })[];
  latestBriefing: { kind: string; date: string } | null;
}

export function getSnapshot(ctx: Ctx): Snapshot {
  const today = todayLocal();
  const yesterday = addDays(today, -1);
  const dueToday = ctx.db.select().from(tasks)
    .where(alive(tasks.deletedAt, eq(tasks.dueDate, today), ne(tasks.status, "Done"))).all();
  // due_date IS NULL 在 SQLite 比較中為 NULL(非 true),因此無期限任務不會被誤判為逾期。
  const overdue = ctx.db.select().from(tasks)
    .where(alive(tasks.deletedAt, lt(tasks.dueDate, today), ne(tasks.status, "Done"))).all();
  // 以 completed_at 而非 updated_at 為界:後者會被改標題、換負責人之類的無關編輯推到今天,
  // 讓上週就完成的任務又出現在「昨日完成」裡。
  // completed_at 是 'YYYY-MM-DDTHH:mm:ss',字典序即時序;上界取 today 便可排除今天完成的任務。
  // completed_at IS NULL 的列在 SQL 比較中為 NULL(非 true),因此自動被排除 ——
  // 「status=Done 但沒有完成時間」不是完成紀錄,不該被猜一個日期塞進報表。
  const completedYesterday = ctx.db.select().from(tasks)
    .where(alive(
      tasks.deletedAt, eq(tasks.status, "Done"),
      gte(tasks.completedAt, yesterday), lt(tasks.completedAt, today),
    )).all();
  const unprocessed = listUnprocessedNotes(ctx)
    .map(n => ({ id: n.id, date: n.date, type: n.type, label: noteLabel(n) }));
  const openRadar = ctx.db.select().from(radar)
    .where(alive(radar.deletedAt, ne(radar.status, "Resolved"))).all()
    .map(r => ({ ...r, staleDays: Math.max(0, daysBetween(r.updatedAt.slice(0, 10), today)) }));
  const lb = ctx.db.select().from(briefings).where(alive(briefings.deletedAt))
    .orderBy(desc(briefings.date), desc(briefings.id)).limit(1).get();
  return {
    today, dueToday, overdue, completedYesterday,
    unprocessedNotes: unprocessed, openRadar,
    latestBriefing: lb ? { kind: lb.kind, date: lb.date } : null,
  };
}

export interface ProjectContext {
  project: Project;
  tasks: TaskRow[];
  radar: RadarItem[];
  notes: Note[];
}

/** 各關聯一律以 project_id 過濾 — 不得退化成全域清單。 */
export function getProjectContext(ctx: Ctx, projectId: number): ProjectContext | undefined {
  const project = getProject(ctx, projectId);
  if (!project) return undefined;
  return {
    project,
    tasks: ctx.db.select().from(tasks).where(alive(tasks.deletedAt, eq(tasks.projectId, projectId))).all(),
    radar: ctx.db.select().from(radar).where(alive(radar.deletedAt, eq(radar.projectId, projectId))).all(),
    notes: ctx.db.select().from(notes).where(alive(notes.deletedAt, eq(notes.projectId, projectId))).all(),
  };
}

/** weekStart 預設為本週一(本地時間) */
export function currentWeekStart(): string {
  const today = todayLocal();
  const dow = new Date(`${today}T12:00:00`).getDay(); // 0=Sun
  return addDays(today, dow === 0 ? -6 : 1 - dow);
}

export interface WeeklyData {
  weekStart: string;
  briefings: Briefing[];
  completedTasks: TaskRow[];
  radarChanges: RadarItem[];
}

/** 視窗為 [weekStart, weekStart+7) — 上界是下週一那天的 00:00,故用 lt(end) 即可排除整個下週一。 */
export function getWeeklyData(ctx: Ctx, weekStart?: string): WeeklyData {
  const start = weekStart ?? currentWeekStart();
  const end = addDays(start, 7);
  return {
    weekStart: start,
    briefings: ctx.db.select().from(briefings)
      .where(alive(briefings.deletedAt, gte(briefings.date, start), lt(briefings.date, end))).all(),
    // 完成視窗一律以 completed_at 為準(理由同 getSnapshot);
    // radarChanges 則相反 —— 它問的就是「這週有沒有被動過」,那正是 updated_at 的語意。
    completedTasks: ctx.db.select().from(tasks)
      .where(alive(
        tasks.deletedAt, eq(tasks.status, "Done"),
        gte(tasks.completedAt, start), lt(tasks.completedAt, end),
      )).all(),
    radarChanges: ctx.db.select().from(radar)
      .where(alive(radar.deletedAt, gte(radar.updatedAt, start), lt(radar.updatedAt, end))).all(),
  };
}
