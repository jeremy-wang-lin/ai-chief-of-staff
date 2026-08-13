import { describe, it, expect } from "vitest";
import { tmpCtx } from "./helpers.ts";
import { importNdjson } from "../src/import.ts";
import { createProject, listProjects } from "../src/repos/projects.ts";
import { listTasks } from "../src/repos/tasks.ts";
import { listNotes } from "../src/repos/notes.ts";
import { listRadar } from "../src/repos/radar.ts";
import { search } from "../src/search.ts";

describe("NDJSON import", () => {
  it("imports tasks and resolves project natural key", () => {
    const ctx = tmpCtx();
    const p = createProject(ctx, { name: "Payment GW" });
    const res = importNdjson(ctx, {
      table: "tasks",
      lines: [
        JSON.stringify({ title: "a", project: "Payment GW" }),
        JSON.stringify({ title: "b", priority: "P1" }),
      ],
    });
    expect(res).toMatchObject({ ok: true, total: 2, inserted: 2, errors: [] });
    const tasks = listTasks(ctx);
    expect(tasks.find(t => t.title === "a")!.projectId).toBe(p.id);
    // 自然鍵是 import 層的概念,不得原樣落到 DB 欄位
    expect((tasks[0] as Record<string, unknown>).project).toBeUndefined();
  });

  it("any invalid line rolls back the whole batch", () => {
    const ctx = tmpCtx();
    const res = importNdjson(ctx, {
      table: "tasks",
      lines: [JSON.stringify({ title: "good" }), JSON.stringify({ nope: 1 })],
    });
    expect(res.ok).toBe(false);
    expect(res.inserted).toBe(0);
    expect(res.errors[0].line).toBe(2);
    expect(listTasks(ctx)).toHaveLength(0);
  });

  it("dryRun validates without writing", () => {
    const ctx = tmpCtx();
    const res = importNdjson(ctx, { table: "notes", lines: [JSON.stringify({ bodyMd: "x" })], dryRun: true });
    expect(res.ok).toBe(true);
    expect(res.inserted).toBe(0);
    expect(listNotes(ctx)).toHaveLength(0);
  });

  it("dryRun still reports invalid rows", () => {
    const ctx = tmpCtx();
    const res = importNdjson(ctx, { table: "notes", lines: [JSON.stringify({ title: "無內文" })], dryRun: true });
    expect(res.ok).toBe(false);
    expect(res.errors[0].line).toBe(1);
    expect(res.errors[0].message).toContain("bodyMd");
  });

  it("unknown natural key errors with line number", () => {
    const ctx = tmpCtx();
    const res = importNdjson(ctx, { table: "tasks", lines: [JSON.stringify({ title: "a", project: "不存在" })] });
    expect(res.ok).toBe(false);
    expect(res.errors[0].message).toContain("不存在");
    expect(res.errors[0].line).toBe(1);
  });

  it("an ambiguous project name errors instead of silently picking one", () => {
    const ctx = tmpCtx();
    // 專案名稱沒有唯一約束;同名時自然鍵指向誰是猜的,而猜錯會把任務掛到別的專案底下
    createProject(ctx, { name: "重複" });
    createProject(ctx, { name: "重複" });
    const res = importNdjson(ctx, { table: "tasks", lines: [JSON.stringify({ title: "a", project: "重複" })] });
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatchObject({ line: 1 });
    expect(res.errors[0].message).toMatch(/ambiguous/);
    expect(listTasks(ctx)).toHaveLength(0);
  });

  it("malformed JSON is reported with its line number, not thrown", () => {
    const ctx = tmpCtx();
    const res = importNdjson(ctx, {
      table: "tasks",
      lines: [JSON.stringify({ title: "ok" }), "{not json", JSON.stringify({ title: "ok2" })],
    });
    expect(res.ok).toBe(false);
    expect(res.total).toBe(3);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toMatchObject({ line: 2 });
    expect(listTasks(ctx)).toHaveLength(0);
  });

  it("collects every bad line, not just the first", () => {
    const ctx = tmpCtx();
    const res = importNdjson(ctx, {
      table: "radar",
      lines: [JSON.stringify({ title: "r", severity: "P9" }), JSON.stringify({ title: "" })],
    });
    expect(res.errors.map(e => e.line)).toEqual([1, 2]);
    expect(listRadar(ctx)).toHaveLength(0);
  });

  it("rejects unknown columns on every table (strict rows)", () => {
    const ctx = tmpCtx();
    for (const [table, row] of [
      ["projects", { name: "P", nope: 1 }],
      ["tasks", { title: "T", nope: 1 }],
      ["radar", { title: "R", nope: 1 }],
      ["notes", { bodyMd: "N", nope: 1 }],
    ] as const) {
      const res = importNdjson(ctx, { table, lines: [JSON.stringify(row)] });
      expect(res.ok, table).toBe(false);
      expect(res.errors[0].message, table).toMatch(/nope/);
    }
    expect(listProjects(ctx)).toHaveLength(0);
  });

  it("imports projects and notes with their own natural-key resolution", () => {
    const ctx = tmpCtx();
    const projects = importNdjson(ctx, {
      table: "projects",
      lines: [JSON.stringify({ name: "Apollo", status: "Active" })],
    });
    expect(projects).toMatchObject({ ok: true, inserted: 1 });
    const notes = importNdjson(ctx, {
      table: "notes",
      lines: [JSON.stringify({ bodyMd: "kickoff 紀要", type: "Meeting", project: "Apollo" })],
    });
    expect(notes).toMatchObject({ ok: true, inserted: 1 });
    expect(listNotes(ctx)[0].projectId).toBe(listProjects(ctx)[0].id);
  });

  it("imported rows land in the FTS index", () => {
    const ctx = tmpCtx();
    importNdjson(ctx, { table: "notes", lines: [JSON.stringify({ bodyMd: "匯入的支付閘道筆記" })] });
    const hits = search(ctx, { q: "支付閘道" });
    expect(hits).toHaveLength(1);
    expect(hits[0].table).toBe("notes");
  });

  it("an empty batch is a successful no-op", () => {
    const ctx = tmpCtx();
    expect(importNdjson(ctx, { table: "tasks", lines: [] }))
      .toEqual({ ok: true, total: 0, inserted: 0, errors: [] });
  });

  it("skips blank lines while keeping line numbers true to the file", () => {
    const ctx = tmpCtx();
    // 空行是編輯器與結尾換行的常態,不是資料也不是錯誤;但它一定要佔掉一個行號,
    // 否則回報的行號跟使用者打開檔案看到的對不上 —— 那比不報行號還糟。
    const res = importNdjson(ctx, {
      table: "tasks",
      lines: [JSON.stringify({ title: "ok" }), "", JSON.stringify({ nope: 1 })],
    });
    expect(res.ok).toBe(false);
    expect(res.errors[0].line).toBe(3);
    // total 是「實際處理的非空行數」,空行不計
    expect(res.total).toBe(2);
    expect(listTasks(ctx)).toHaveLength(0);
  });

  it("blank lines never count toward total or inserted", () => {
    const ctx = tmpCtx();
    const res = importNdjson(ctx, {
      table: "tasks",
      lines: ["", JSON.stringify({ title: "a" }), "   ", JSON.stringify({ title: "b" }), "\t", ""],
    });
    expect(res).toEqual({ ok: true, total: 2, inserted: 2, errors: [] });
    expect(listTasks(ctx)).toHaveLength(2);
  });

  it("a DB-level failure mid-batch rolls the whole transaction back", () => {
    const ctx = tmpCtx();
    const lines = ["a", "boom", "c"].map(title => JSON.stringify({ title }));
    // 驗證全過、卻在寫入途中炸掉的情境:transaction 包裝是唯一擋住半成功的東西。
    ctx.sqlite.exec("CREATE TRIGGER boom BEFORE INSERT ON tasks WHEN NEW.title='boom' BEGIN SELECT RAISE(ABORT,'boom'); END");
    try {
      expect(() => importNdjson(ctx, { table: "tasks", lines })).toThrow(/boom/);
    } finally {
      ctx.sqlite.exec("DROP TRIGGER boom");
    }
    // 第一列在爆炸前已經 insert 過,沒有回滾就會留在這裡
    expect(listTasks(ctx)).toHaveLength(0);
  });
});
