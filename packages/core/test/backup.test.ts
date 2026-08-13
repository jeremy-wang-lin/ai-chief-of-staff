import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, existsSync, statSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import Database from "better-sqlite3";
import { tmpCtx } from "./helpers.ts";
import { backupDb } from "../src/backup.ts";
import { runOp, OpInputError } from "../src/registry.ts";
import { createTask } from "../src/repos/tasks.ts";
import { todayLocal } from "../src/time.ts";

const ORIGINAL_BACKUP_DIR = process.env.LCOS_BACKUP_DIR;
afterEach(() => {
  if (ORIGINAL_BACKUP_DIR === undefined) delete process.env.LCOS_BACKUP_DIR;
  else process.env.LCOS_BACKUP_DIR = ORIGINAL_BACKUP_DIR;
});

function tmpDir(): string {
  return join(mkdtempSync(join(tmpdir(), "lcos-backup-")), "nested");
}

describe("backupDb", () => {
  it("writes lcos-YYYY-MM-DD.db into a (created) dest dir", () => {
    const ctx = tmpCtx();
    createTask(ctx, { title: "備份得到我" });
    const dest = tmpDir();

    const path = backupDb(ctx, dest);

    expect(path).toBe(join(dest, `lcos-${todayLocal()}.db`));
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).size).toBeGreaterThan(0);
    // 只有一個檔:VACUUM INTO 產出的是自足的單檔,不帶 -wal/-shm
    expect(readdirSync(dest)).toEqual([`lcos-${todayLocal()}.db`]);
  });

  it("re-running on the same day overwrites, leaving no temp file behind", () => {
    const ctx = tmpCtx();
    const dest = tmpDir();
    backupDb(ctx, dest);
    createTask(ctx, { title: "第二次備份才有" });

    expect(() => backupDb(ctx, dest)).not.toThrow();

    const copy = new Database(join(dest, `lcos-${todayLocal()}.db`), { readonly: true });
    expect(copy.prepare("select count(*) as n from tasks").get()).toEqual({ n: 1 });
    // 只留下當天那一份:寫到一半的暫存檔不得留在備份目錄裡冒充成備份
    expect(readdirSync(dest)).toEqual([`lcos-${todayLocal()}.db`]);
  });

  it("keeps the previous backup intact when the new one fails", () => {
    const ctx = tmpCtx();
    const dest = tmpDir();
    createTask(ctx, { title: "上一份備份" });
    const path = backupDb(ctx, dest);
    const before = readFileSync(path);

    // 關掉來源 DB 讓 VACUUM INTO 必定失敗:此刻舊備份是唯一的副本,
    // 不能因為新備份寫不出來就先被刪掉 —— 那是「備份把資料弄丟」的典型失敗。
    ctx.sqlite.close();
    expect(() => backupDb(ctx, dest)).toThrow();

    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(dest)).toEqual([`lcos-${todayLocal()}.db`]);
  });

  it("returns an absolute path even when dest is relative", () => {
    const ctx = tmpCtx();
    const dir = tmpDir();
    const path = backupDb(ctx, relative(process.cwd(), dir));
    expect(isAbsolute(path)).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it("backup is a readable database containing the source rows", () => {
    const ctx = tmpCtx();
    createTask(ctx, { title: "唯一的任務" });
    const copy = new Database(backupDb(ctx, tmpDir()), { readonly: true });
    const rows = copy.prepare("select title from tasks").all() as { title: string }[];
    expect(rows.map(r => r.title)).toEqual(["唯一的任務"]);
  });
});

describe("backup op", () => {
  it("uses --dest when given", () => {
    const ctx = tmpCtx();
    const dest = tmpDir();
    expect(runOp(ctx, "backup", { dest })).toEqual({ path: join(dest, `lcos-${todayLocal()}.db`) });
  });

  it("falls back to LCOS_BACKUP_DIR", () => {
    const ctx = tmpCtx();
    const dest = tmpDir();
    process.env.LCOS_BACKUP_DIR = dest;
    expect(runOp(ctx, "backup", {})).toEqual({ path: join(dest, `lcos-${todayLocal()}.db`) });
  });

  it("throws OpInputError when neither dest nor LCOS_BACKUP_DIR is set", () => {
    const ctx = tmpCtx();
    delete process.env.LCOS_BACKUP_DIR;
    expect(() => runOp(ctx, "backup", {})).toThrow(OpInputError);
  });
});
