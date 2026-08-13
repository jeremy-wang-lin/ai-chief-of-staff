import { describe, it, expect } from "vitest";
import { tmpCtx } from "./helpers.ts";
import { createProject, getProject, listProjects, updateProject, softDeleteProject } from "../src/repos/projects.ts";
import { createTask, listTasks, updateTask, softDeleteTask } from "../src/repos/tasks.ts";
import { createNote, listNotes, updateNote } from "../src/repos/notes.ts";
import { createRadar, listRadar, updateRadar } from "../src/repos/radar.ts";
import { todayLocal, addDays } from "../src/time.ts";

// 型別層守門:updateX 必須誠實把 undefined 放進回傳型別,否則 typecheck 失敗。
type Assert<T extends true> = T;
type _UpdateProjectIsOptional = Assert<undefined extends ReturnType<typeof updateProject> ? true : false>;
type _UpdateTaskIsOptional = Assert<undefined extends ReturnType<typeof updateTask> ? true : false>;
type _UpdateNoteIsOptional = Assert<undefined extends ReturnType<typeof updateNote> ? true : false>;
type _UpdateRadarIsOptional = Assert<undefined extends ReturnType<typeof updateRadar> ? true : false>;

describe("repositories", () => {
  it("create applies defaults and timestamps", () => {
    const ctx = tmpCtx();
    const p = createProject(ctx, { name: "Payment GW" });
    expect(p.status).toBe("Active");
    expect(p.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const t = createTask(ctx, { title: "review API", projectId: p.id });
    expect(t.priority).toBe("P2");
    expect(t.origin).toBe("human");
    const n = createNote(ctx, { bodyMd: "隨手記一筆" });
    expect(n.type).toBe("Scratch");
    expect(n.title).toBeNull();
    expect(n.date).toBe(todayLocal());
  });

  it("createNote falls back to today when date is explicitly undefined", () => {
    const ctx = tmpCtx();
    const n = createNote(ctx, { bodyMd: "x", date: undefined });
    expect(n.date).toBe(todayLocal());
  });

  it("update bumps updatedAt and persists patch", () => {
    const ctx = tmpCtx();
    const p = createProject(ctx, { name: "X" });
    const p2 = updateProject(ctx, p.id, { status: "On Hold", risk: "延期風險" })!;
    expect(p2.status).toBe("On Hold");
    expect(p2.risk).toBe("延期風險");
    expect(p2.updatedAt >= p.updatedAt).toBe(true);
  });

  it("update returns undefined for missing or soft-deleted rows", () => {
    const ctx = tmpCtx();
    expect(updateProject(ctx, 999, { status: "On Hold" })).toBeUndefined();
    const t = createTask(ctx, { title: "gone" });
    softDeleteTask(ctx, t.id);
    expect(updateTask(ctx, t.id, { status: "Done" })).toBeUndefined();
  });

  it("soft delete hides rows from list", () => {
    const ctx = tmpCtx();
    const p = createProject(ctx, { name: "X" });
    softDeleteProject(ctx, p.id);
    expect(listProjects(ctx)).toHaveLength(0);
    expect(getProject(ctx, p.id)).toBeUndefined();
    // 資料仍在 DB(soft)
    const readDeletedAt = () =>
      (ctx.sqlite.prepare("SELECT deleted_at FROM projects WHERE id=?").get(p.id) as any).deleted_at;
    const first = readDeletedAt();
    expect(first).not.toBeNull();
    // 重複刪除是 no-op,不會改寫原本的 deleted_at
    softDeleteProject(ctx, p.id);
    expect(readDeletedAt()).toBe(first);
  });

  it("soft delete hides rows for non-project tables too", () => {
    const ctx = tmpCtx();
    const t = createTask(ctx, { title: "T" });
    softDeleteTask(ctx, t.id);
    expect(listTasks(ctx)).toHaveLength(0);
    const raw = ctx.sqlite.prepare("SELECT deleted_at FROM tasks WHERE id=?").get(t.id) as any;
    expect(raw.deleted_at).not.toBeNull();
  });

  // ── completed_at:衍生欄位,只由狀態轉換維護 ────────────────────────────────
  it("stamps completedAt when a task enters Done and clears it when it leaves", () => {
    const ctx = tmpCtx();
    const t = createTask(ctx, { title: "T" });
    expect(t.completedAt).toBeNull();

    const done = updateTask(ctx, t.id, { status: "Done" })!;
    expect(done.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);

    const reopened = updateTask(ctx, t.id, { status: "In Progress" })!;
    expect(reopened.completedAt).toBeNull();

    // 再次完成 → 重新蓋時間(這是真的第二次完成,不是無關的編輯)
    expect(updateTask(ctx, t.id, { status: "Done" })!.completedAt).not.toBeNull();
  });

  it("editing a Done task does not re-date its completion", () => {
    const ctx = tmpCtx();
    const t = createTask(ctx, { title: "T", status: "Done" });
    // 一建立就是 Done 也要有完成時間,否則會被所有以 completed_at 為界的查詢排除
    expect(t.completedAt).not.toBeNull();

    // 改標題(不帶 status):完成時間必須原封不動,updated_at 則照常前進
    const renamed = updateTask(ctx, t.id, { title: "T2" })!;
    expect(renamed.completedAt).toBe(t.completedAt);
    expect(renamed.updatedAt >= t.updatedAt).toBe(true);

    // 明確再送一次 status: "Done" 也不算新的完成 —— 狀態並未轉換
    ctx.sqlite.prepare("UPDATE tasks SET completed_at = ? WHERE id = ?").run("2020-01-01T00:00:00", t.id);
    expect(updateTask(ctx, t.id, { status: "Done", owner: "me" })!.completedAt).toBe("2020-01-01T00:00:00");
  });

  it("leaving a status that was never Done leaves completedAt alone", () => {
    const ctx = tmpCtx();
    const t = createTask(ctx, { title: "T" });
    expect(updateTask(ctx, t.id, { status: "Blocked" })!.completedAt).toBeNull();
  });

  it("listTasks filters: status, overdue, origin", () => {
    const ctx = tmpCtx();
    createTask(ctx, { title: "a", status: "Done" });
    createTask(ctx, { title: "b", dueDate: addDays(todayLocal(), -1) });
    createTask(ctx, { title: "c", origin: "ai" });
    expect(listTasks(ctx, { status: "Done" }).map(t => t.title)).toEqual(["a"]);
    expect(listTasks(ctx, { overdue: true }).map(t => t.title)).toEqual(["b"]);
    expect(listTasks(ctx, { origin: "ai" }).map(t => t.title)).toEqual(["c"]);
  });

  it("listTasks / listRadar filter by noteId", () => {
    const ctx = tmpCtx();
    const n = createNote(ctx, { bodyMd: "會議記錄" });
    createTask(ctx, { title: "from-note", noteId: n.id });
    createTask(ctx, { title: "unrelated" });
    createRadar(ctx, { title: "risk-from-note", noteId: n.id });
    createRadar(ctx, { title: "risk-unrelated" });
    expect(listTasks(ctx, { noteId: n.id }).map((t) => t.title)).toEqual(["from-note"]);
    expect(listRadar(ctx, { noteId: n.id }).map((r) => r.title)).toEqual(["risk-from-note"]);
  });

  it("listNotes / listRadar filters", () => {
    const ctx = tmpCtx();
    createNote(ctx, { bodyMd: "m", type: "Meeting", title: "會議" });
    createNote(ctx, { bodyMd: "s" });
    createRadar(ctx, { title: "risk1", severity: "P1" });
    expect(listNotes(ctx, { type: "Meeting" })).toHaveLength(1);
    expect(listRadar(ctx, { severity: "P1" })).toHaveLength(1);
  });
});
