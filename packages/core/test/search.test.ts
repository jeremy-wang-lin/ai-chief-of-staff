import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpCtx } from "./helpers.ts";
import { createNote, softDeleteNote } from "../src/repos/notes.ts";
import { createProject } from "../src/repos/projects.ts";
import { createTask } from "../src/repos/tasks.ts";
import { createRadar } from "../src/repos/radar.ts";
import { upsertBriefing } from "../src/repos/briefings.ts";
import { trashRestore } from "../src/trash.ts";
import { updateProjectBody } from "../src/writers.ts";
import { search } from "../src/search.ts";

describe("full-text search", () => {
  it("finds notes by body and title across tables", () => {
    const ctx = tmpCtx();
    createNote(ctx, { bodyMd: "log retention 90 天好像太長", title: "隨手記" });
    const p = createProject(ctx, { name: "資料平台遷移" });
    updateProjectBody(ctx, p.id, "retention 政策定為 30 天", "ai");
    const hits = search(ctx, { q: "retention" });
    expect(hits.map(h => h.table).sort()).toEqual(["notes", "projects"]);
    expect(hits.every(h => !h.isRevision)).toBe(true);
  });

  it("soft-deleted rows drop out of the index", () => {
    const ctx = tmpCtx();
    const n = createNote(ctx, { bodyMd: "retention note" });
    softDeleteNote(ctx, n.id);
    expect(search(ctx, { q: "retention" })).toHaveLength(0);
  });

  it("revisions searchable only when includeRevisions", () => {
    const ctx = tmpCtx();
    const p = createProject(ctx, { name: "X" });
    updateProjectBody(ctx, p.id, "retention 暫定 90 天", "ai");
    updateProjectBody(ctx, p.id, "policy 已改", "ai"); // retention 版進 revisions
    // 注意:trigram tokenizer 查詢需 >= 3 字元,兩字中文查不到 — 測試用英文詞
    expect(search(ctx, { q: "retention" })).toHaveLength(0);
    const withRev = search(ctx, { q: "retention", includeRevisions: true });
    expect(withRev).toHaveLength(1);
    expect(withRev[0].isRevision).toBe(true);
    expect(withRev[0].revisionCreatedAt).toBeTruthy();
  });

  it("indexes tasks, radar and briefings too", () => {
    const ctx = tmpCtx();
    createTask(ctx, { title: "rotate credentials" });
    createRadar(ctx, { title: "vendor outage risk" });
    upsertBriefing(ctx, { kind: "daily", date: "2026-08-02", summary: "quarterly headcount", bodyMd: "body" });

    expect(search(ctx, { q: "credentials" }).map(h => h.table)).toEqual(["tasks"]);
    expect(search(ctx, { q: "outage" }).map(h => h.table)).toEqual(["radar"]);
    expect(search(ctx, { q: "headcount" }).map(h => h.table)).toEqual(["briefings"]);
  });

  it("trashRestore puts a row back into the index", () => {
    const ctx = tmpCtx();
    const n = createNote(ctx, { bodyMd: "restore candidate" });
    softDeleteNote(ctx, n.id);
    expect(search(ctx, { q: "candidate" })).toHaveLength(0);
    trashRestore(ctx, "notes", n.id);
    expect(search(ctx, { q: "candidate" }).map(h => h.rowId)).toEqual([n.id]);
  });

  it("queries with FTS5 syntax characters are treated literally, not as operators", () => {
    const ctx = tmpCtx();
    createNote(ctx, { bodyMd: "flaky e2e-test in CI" });
    createNote(ctx, { bodyMd: 'quoting reten"tion here' });

    expect(search(ctx, { q: "e2e-test" }).map(h => h.table)).toEqual(["notes"]);
    expect(() => search(ctx, { q: 'reten"tion' })).not.toThrow();
    expect(search(ctx, { q: 'reten"tion' })).toHaveLength(1);
    // 沒有 phrase 包裝時,以下每一個都會噴 fts5 syntax error 或被當成欄位過濾
    for (const q of ["(unbalanced", "trailing AND", "body:injected", 'a"b(c)']) {
      expect(() => search(ctx, { q })).not.toThrow();
    }
  });
});

/** 從 migration 抽出 backfill 用的 INSERT(去掉註解行),確保測的是真正會跑的那份 SQL。 */
function backfillStatements(): string[] {
  const sql = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle", "0001_fts.sql"), "utf8",
  );
  return sql.split("--> statement-breakpoint")
    .map(chunk => chunk.split("\n").filter(l => !l.trimStart().startsWith("--")).join("\n").trim())
    .filter(stmt => stmt.startsWith("INSERT INTO fts_"));
}

describe("fts backfill", () => {
  it("rebuilds both indexes from existing rows", () => {
    const stmts = backfillStatements();
    expect(stmts).toHaveLength(6); // 5 張內容表 + revisions

    const ctx = tmpCtx();
    const p = createProject(ctx, { name: "backfill project" });
    updateProjectBody(ctx, p.id, "pitchdeck draft", "ai");
    updateProjectBody(ctx, p.id, "superseded", "ai"); // pitchdeck 版落入 revisions
    createNote(ctx, { bodyMd: "noteworthy" });
    createTask(ctx, { title: "taskish" });
    createRadar(ctx, { title: "radarish" });
    upsertBriefing(ctx, { kind: "daily", date: "2026-08-02", summary: "briefish", bodyMd: "b" });
    const deleted = createNote(ctx, { bodyMd: "noteworthy deleted" });
    softDeleteNote(ctx, deleted.id);

    ctx.sqlite.exec("DELETE FROM fts_main; DELETE FROM fts_revisions;");
    expect(search(ctx, { q: "noteworthy", includeRevisions: true })).toHaveLength(0);

    for (const stmt of stmts) ctx.sqlite.exec(stmt);

    expect(search(ctx, { q: "backfill" }).map(h => h.table)).toEqual(["projects"]);
    expect(search(ctx, { q: "taskish" }).map(h => h.table)).toEqual(["tasks"]);
    expect(search(ctx, { q: "radarish" }).map(h => h.table)).toEqual(["radar"]);
    expect(search(ctx, { q: "briefish" }).map(h => h.table)).toEqual(["briefings"]);
    // soft-deleted 的那篇不該被 backfill 補回來
    expect(search(ctx, { q: "noteworthy" }).map(h => h.rowId)).toEqual([1]);
    const rev = search(ctx, { q: "pitchdeck", includeRevisions: true });
    expect(rev).toHaveLength(1);
    expect(rev[0].isRevision).toBe(true);
  });
});
