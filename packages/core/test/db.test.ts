import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../src/db.ts";
import { nowLocal, todayLocal } from "../src/time.ts";
import { tmpCtx } from "./helpers.ts";
import { upsertBriefing, listBriefings } from "../src/repos/briefings.ts";
import { listTasks } from "../src/repos/tasks.ts";

describe("openDb", () => {
  it("creates all tables and enables WAL", () => {
    const ctx = tmpCtx();
    const tables = ctx.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    for (const t of ["projects", "tasks", "radar", "notes", "briefings", "revisions"]) {
      expect(tables).toContain(t);
    }
    expect(ctx.sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
  });
  it("waits on a busy writer instead of failing immediately", () => {
    // SQLite 預設 busy_timeout 為 0 —— 兩個 writer 相撞時後到的那個直接收 SQLITE_BUSY。
    // REST server 與 CLI 之後會同時開同一個檔,那個預設等同「誰慢一步誰就出錯」。
    expect(tmpCtx().sqlite.pragma("busy_timeout", { simple: true })).toBe(5000);
  });
  it("closeDb releases the connection so later queries fail loudly", () => {
    const ctx = tmpCtx();
    expect(listTasks(ctx)).toEqual([]);
    closeDb(ctx);
    // 關掉之後繼續查必須爆炸,而不是靜靜地回空集合
    expect(() => listTasks(ctx)).toThrow(/not open/i);
  });
  it("is idempotent (re-open same file)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lcos-test-"));
    const p = join(dir, "test.db");
    openDb(p);
    expect(() => openDb(p)).not.toThrow();
  });
});

describe("schema invariants", () => {
  it("enforces the unique (kind, date) index on briefings", () => {
    const ctx = tmpCtx();
    const insert = ctx.sqlite.prepare(
      "INSERT INTO briefings (created_at, updated_at, kind, date, summary, body_md) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const args = [nowLocal(), nowLocal(), "daily", todayLocal(), "s", "b"] as const;
    insert.run(...args);
    expect(() => insert.run(...args)).toThrow(/UNIQUE constraint failed/);
  });

  it("the (kind,date) uniqueness ignores soft-deleted rows", () => {
    // 全表唯一索引與 soft delete 直接衝突:刪掉的 briefing 會永久占住 (kind,date),
    // 讓同一天再也寫不進新的 —— upsertBriefing 只看得見存活列,會走 insert 分支然後撞上 UNIQUE。
    // 0002 把它換成 partial unique index(WHERE deleted_at IS NULL),此處守住那個行為。
    const ctx = tmpCtx();
    const first = upsertBriefing(ctx, { kind: "daily", date: "2026-08-02", summary: "s1", bodyMd: "b1" });
    ctx.sqlite.prepare("UPDATE briefings SET deleted_at = ? WHERE id = ?").run(nowLocal(), first.id);

    const second = upsertBriefing(ctx, { kind: "daily", date: "2026-08-02", summary: "s2", bodyMd: "b2" });
    expect(second.id).not.toBe(first.id);          // insert 分支,不是覆寫舊列
    expect(listBriefings(ctx).map(b => b.summary)).toEqual(["s2"]); // 已刪除的那筆不再露出
    // 存活列之間的唯一性完全不變
    const alive = ctx.sqlite.prepare(
      "INSERT INTO briefings (created_at, updated_at, kind, date, summary, body_md) VALUES (?,?,?,?,?,?)",
    );
    expect(() => alive.run(nowLocal(), nowLocal(), "daily", "2026-08-02", "s3", "b3"))
      .toThrow(/UNIQUE constraint failed/);
  });

  it("rejects a task pointing at a non-existent project", () => {
    const ctx = tmpCtx();
    expect(() =>
      ctx.sqlite
        .prepare("INSERT INTO tasks (created_at, updated_at, title, project_id) VALUES (?, ?, ?, ?)")
        .run(nowLocal(), nowLocal(), "orphan", 999),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("turns foreign key enforcement on", () => {
    const ctx = tmpCtx();
    expect(ctx.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
  });
});
