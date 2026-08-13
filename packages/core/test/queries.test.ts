import { describe, it, expect } from "vitest";
import { tmpCtx } from "./helpers.ts";
import { createProject } from "../src/repos/projects.ts";
import { createTask, updateTask } from "../src/repos/tasks.ts";
import { createNote, updateNote, softDeleteNote } from "../src/repos/notes.ts";
import { createRadar } from "../src/repos/radar.ts";
import { upsertBriefing } from "../src/repos/briefings.ts";
import {
  getSnapshot, getProjectContext, getWeeklyData, listUnprocessedNotes, currentWeekStart,
} from "../src/queries.ts";
import type { Ctx } from "../src/db.ts";
import { todayLocal, addDays, nowLocal } from "../src/time.ts";

/** 直接改寫時間戳,才能測到「以 updated_at 為界」的視窗邊界(radarChanges)。 */
function setUpdatedAt(ctx: Ctx, table: "tasks" | "radar", id: number, value: string): void {
  ctx.sqlite.prepare(`UPDATE ${table} SET updated_at = ? WHERE id = ?`).run(value, id);
}

/** 完成視窗以 completed_at 為界;repo 只會蓋「現在」,測邊界得直接改寫它。 */
function setCompletedAt(ctx: Ctx, id: number, value: string | null): void {
  ctx.sqlite.prepare("UPDATE tasks SET completed_at = ? WHERE id = ?").run(value, id);
}

describe("composite queries", () => {
  it("snapshot aggregates due/overdue/unprocessed/radar/briefing", () => {
    const ctx = tmpCtx();
    createTask(ctx, { title: "due", dueDate: todayLocal() });
    createTask(ctx, { title: "late", dueDate: addDays(todayLocal(), -2) });
    createNote(ctx, { bodyMd: "第一行\n其餘" });
    const processed = createNote(ctx, { bodyMd: "done", type: "Meeting", title: "已處理" });
    updateNote(ctx, processed.id, { processedAt: nowLocal() });
    createRadar(ctx, { title: "risk" });
    upsertBriefing(ctx, { kind: "daily", date: addDays(todayLocal(), -2), summary: "s", bodyMd: "b" });

    const s = getSnapshot(ctx);
    expect(s.today).toBe(todayLocal());
    expect(s.dueToday.map(t => t.title)).toEqual(["due"]);
    expect(s.overdue.map(t => t.title)).toEqual(["late"]);
    expect(s.unprocessedNotes).toHaveLength(1);
    expect(s.unprocessedNotes[0].label).toBe("第一行");
    expect(s.openRadar[0].staleDays).toBe(0);
    expect(s.latestBriefing).toEqual({ kind: "daily", date: addDays(todayLocal(), -2) });
  });

  it("snapshot excludes done tasks from due/overdue and resolved items from radar", () => {
    const ctx = tmpCtx();
    const done = createTask(ctx, { title: "done-today", dueDate: todayLocal() });
    updateTask(ctx, done.id, { status: "Done" });
    const lateDone = createTask(ctx, { title: "done-late", dueDate: addDays(todayLocal(), -3) });
    updateTask(ctx, lateDone.id, { status: "Done" });
    createTask(ctx, { title: "no-due" }); // due_date IS NULL 不得被當成逾期
    createRadar(ctx, { title: "resolved", status: "Resolved" });

    const s = getSnapshot(ctx);
    expect(s.dueToday).toEqual([]);
    expect(s.overdue).toEqual([]);
    expect(s.openRadar).toEqual([]);
  });

  it("snapshot completedYesterday covers yesterday only", () => {
    const ctx = tmpCtx();
    const yesterday = addDays(todayLocal(), -1);
    const y = createTask(ctx, { title: "yesterday", status: "Done" });
    setCompletedAt(ctx, y.id, `${yesterday}T18:00:00`);
    const old = createTask(ctx, { title: "two-days-ago", status: "Done" });
    setCompletedAt(ctx, old.id, `${addDays(todayLocal(), -2)}T18:00:00`);
    createTask(ctx, { title: "today", status: "Done" }); // completed_at = 現在
    const openYesterday = createTask(ctx, { title: "still-open" });
    setUpdatedAt(ctx, "tasks", openYesterday.id, `${yesterday}T18:00:00`);

    expect(getSnapshot(ctx).completedYesterday.map(t => t.title)).toEqual(["yesterday"]);
  });

  it("snapshot completedYesterday ignores updated_at and drops Done rows without a completion time", () => {
    const ctx = tmpCtx();
    const yesterday = addDays(todayLocal(), -1);
    // 昨天完成、今天只是改了標題 —— updated_at 被推到今天,但完成日仍是昨天
    const edited = createTask(ctx, { title: "done-yesterday", status: "Done" });
    setCompletedAt(ctx, edited.id, `${yesterday}T18:00:00`);
    updateTask(ctx, edited.id, { title: "renamed today" });
    // 反向陷阱:上週完成、昨天才被改到,不得因此變成「昨日完成」
    const oldDone = createTask(ctx, { title: "done-last-week", status: "Done" });
    setCompletedAt(ctx, oldDone.id, `${addDays(todayLocal(), -8)}T09:00:00`);
    setUpdatedAt(ctx, "tasks", oldDone.id, `${yesterday}T09:00:00`);
    // 沒有完成時間的 Done(理論上只可能來自繞過 repo 的寫入)不猜日期,直接排除
    const orphan = createTask(ctx, { title: "done-without-timestamp", status: "Done" });
    setCompletedAt(ctx, orphan.id, null);
    setUpdatedAt(ctx, "tasks", orphan.id, `${yesterday}T09:00:00`);

    expect(getSnapshot(ctx).completedYesterday.map(t => t.title)).toEqual(["renamed today"]);
  });

  it("snapshot reports radar staleness in days and picks the newest briefing", () => {
    const ctx = tmpCtx();
    const stale = createRadar(ctx, { title: "stale" });
    setUpdatedAt(ctx, "radar", stale.id, `${addDays(todayLocal(), -5)}T09:00:00`);
    upsertBriefing(ctx, { kind: "daily", date: addDays(todayLocal(), -3), summary: "old", bodyMd: "b" });
    upsertBriefing(ctx, { kind: "weekly", date: addDays(todayLocal(), -1), summary: "new", bodyMd: "b" });

    const s = getSnapshot(ctx);
    expect(s.openRadar[0].staleDays).toBe(5);
    expect(s.latestBriefing).toEqual({ kind: "weekly", date: addDays(todayLocal(), -1) });
  });

  it("snapshot has no briefing when none exists", () => {
    expect(getSnapshot(tmpCtx()).latestBriefing).toBeNull();
  });

  it("unprocessed covers all note types", () => {
    const ctx = tmpCtx();
    createNote(ctx, { bodyMd: "a", type: "Meeting", title: "m" });
    createNote(ctx, { bodyMd: "b" }); // Scratch
    expect(listUnprocessedNotes(ctx)).toHaveLength(2);
  });

  it("unprocessed excludes processed and soft-deleted notes", () => {
    const ctx = tmpCtx();
    const processed = createNote(ctx, { bodyMd: "p", type: "Discussion" });
    updateNote(ctx, processed.id, { processedAt: nowLocal() });
    const trashed = createNote(ctx, { bodyMd: "t", type: "Thinking" });
    softDeleteNote(ctx, trashed.id);
    createNote(ctx, { bodyMd: "keep", type: "Meeting" });

    expect(listUnprocessedNotes(ctx).map(n => n.bodyMd)).toEqual(["keep"]);
  });

  it("project context joins by project_id only", () => {
    const ctx = tmpCtx();
    const p = createProject(ctx, { name: "A" });
    const other = createProject(ctx, { name: "B" });
    createTask(ctx, { title: "mine", projectId: p.id });
    createTask(ctx, { title: "theirs", projectId: other.id });
    createRadar(ctx, { title: "r", projectId: p.id });
    createNote(ctx, { bodyMd: "n", projectId: p.id });
    const cx = getProjectContext(ctx, p.id)!;
    expect(cx.tasks.map(t => t.title)).toEqual(["mine"]); // §9-4 教訓:不得回傳全域清單
    expect(cx.radar).toHaveLength(1);
    expect(cx.notes).toHaveLength(1);
  });

  it("project context never leaks unassigned rows and skips soft-deleted relations", () => {
    const ctx = tmpCtx();
    const p = createProject(ctx, { name: "A" });
    createTask(ctx, { title: "orphan" }); // project_id IS NULL
    createRadar(ctx, { title: "orphan" });
    createNote(ctx, { bodyMd: "orphan" });
    const trashed = createNote(ctx, { bodyMd: "trashed", projectId: p.id });
    softDeleteNote(ctx, trashed.id);

    const cx = getProjectContext(ctx, p.id)!;
    expect(cx.project.name).toBe("A");
    expect(cx.tasks).toEqual([]);
    expect(cx.radar).toEqual([]);
    expect(cx.notes).toEqual([]);
  });

  it("project context is undefined for unknown project", () => {
    expect(getProjectContext(tmpCtx(), 999)).toBeUndefined();
  });

  it("weekly data scopes to week window", () => {
    const ctx = tmpCtx();
    const monday = currentWeekStart();
    upsertBriefing(ctx, { kind: "daily", date: addDays(monday, 1), summary: "in", bodyMd: "x" });
    upsertBriefing(ctx, { kind: "daily", date: addDays(monday, -7), summary: "out", bodyMd: "x" });
    const t = createTask(ctx, { title: "done-this-week" });
    updateTask(ctx, t.id, { status: "Done" });
    const w = getWeeklyData(ctx, monday);
    expect(w.briefings.map(b => b.summary)).toEqual(["in"]);
    expect(w.completedTasks.map(x => x.title)).toEqual(["done-this-week"]);
  });

  it("weekly data window is [weekStart, weekStart+7) on both edges", () => {
    const ctx = tmpCtx();
    const monday = "2026-07-27";
    const nextMonday = "2026-08-03";
    upsertBriefing(ctx, { kind: "daily", date: monday, summary: "first-day", bodyMd: "x" });
    upsertBriefing(ctx, { kind: "daily", date: "2026-08-02", summary: "last-day", bodyMd: "x" });
    upsertBriefing(ctx, { kind: "daily", date: nextMonday, summary: "next-week", bodyMd: "x" });

    const inside = createTask(ctx, { title: "inside", status: "Done" });
    setCompletedAt(ctx, inside.id, `${monday}T00:00:00`);
    const lastMoment = createTask(ctx, { title: "last-moment", status: "Done" });
    setCompletedAt(ctx, lastMoment.id, "2026-08-02T23:59:59");
    const after = createTask(ctx, { title: "after", status: "Done" });
    setCompletedAt(ctx, after.id, `${nextMonday}T00:00:01`);
    const before = createTask(ctx, { title: "before", status: "Done" });
    setCompletedAt(ctx, before.id, "2026-07-26T23:59:59");
    const open = createTask(ctx, { title: "open" });
    setUpdatedAt(ctx, "tasks", open.id, `${monday}T10:00:00`);

    const rIn = createRadar(ctx, { title: "changed" });
    setUpdatedAt(ctx, "radar", rIn.id, `${monday}T10:00:00`);
    const rAfter = createRadar(ctx, { title: "changed-next-week" });
    setUpdatedAt(ctx, "radar", rAfter.id, `${nextMonday}T10:00:00`);

    const w = getWeeklyData(ctx, monday);
    expect(w.weekStart).toBe(monday);
    expect(w.briefings.map(b => b.summary).sort()).toEqual(["first-day", "last-day"]);
    expect(w.completedTasks.map(t => t.title).sort()).toEqual(["inside", "last-moment"]);
    expect(w.radarChanges.map(r => r.title)).toEqual(["changed"]);
  });

  it("weekly data defaults to the current week (monday-based)", () => {
    const ctx = tmpCtx();
    const start = currentWeekStart();
    expect(getWeeklyData(ctx).weekStart).toBe(start);
    // 本週一必須 <= 今天,且落在今天前 7 天內
    expect(start <= todayLocal()).toBe(true);
    expect(start > addDays(todayLocal(), -7)).toBe(true);
    expect(new Date(`${start}T12:00:00`).getDay()).toBe(1);
  });
});
