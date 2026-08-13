import { describe, it, expect } from "vitest";
import { tmpCtx } from "./helpers.ts";
import { createProject, getProject, softDeleteProject, listProjects } from "../src/repos/projects.ts";
import { overwriteWithRevision, listRevisions, restoreRevision } from "../src/revisions.ts";
import { trashList, trashRestore } from "../src/trash.ts";

describe("revisions", () => {
  it("overwrite stores previous value first, atomically", () => {
    const ctx = tmpCtx();
    const p = createProject(ctx, { name: "X" });
    overwriteWithRevision(ctx, { table: "projects", rowId: p.id, field: "body_md", newValue: "v1", actor: "ai", workflow: "summarize-projects" });
    overwriteWithRevision(ctx, { table: "projects", rowId: p.id, field: "body_md", newValue: "v2", actor: "ai" });
    expect(getProject(ctx, p.id)!.bodyMd).toBe("v2");
    const revs = listRevisions(ctx, { table: "projects", rowId: p.id, field: "body_md" });
    expect(revs).toHaveLength(2);
    expect(revs[0].oldValue).toBe("v1");   // 最新一筆存的是 v2 覆寫前的 v1
    expect(revs[1].oldValue).toBeNull();   // 首次寫入前為 NULL
  });

  it("restore writes old value back and leaves its own revision", () => {
    const ctx = tmpCtx();
    const p = createProject(ctx, { name: "X" });
    overwriteWithRevision(ctx, { table: "projects", rowId: p.id, field: "body_md", newValue: "v1", actor: "ai" });
    overwriteWithRevision(ctx, { table: "projects", rowId: p.id, field: "body_md", newValue: "v2", actor: "ai" });
    const revV1 = listRevisions(ctx, { table: "projects", rowId: p.id })[0]; // oldValue = "v1"
    restoreRevision(ctx, revV1.id, "human");
    expect(getProject(ctx, p.id)!.bodyMd).toBe("v1");
    expect(listRevisions(ctx, { table: "projects", rowId: p.id })).toHaveLength(3);
  });

  it("soft delete is logged and restorable via trash", () => {
    const ctx = tmpCtx();
    const p = createProject(ctx, { name: "X" });
    softDeleteProject(ctx, p.id);
    const items = trashList(ctx);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ table: "projects", id: p.id, label: "X" });
    trashRestore(ctx, "projects", p.id);
    expect(listProjects(ctx)).toHaveLength(1);
  });

  it("a failed overwrite leaves no revision behind", () => {
    const ctx = tmpCtx();
    // 不存在的 row:整個操作必須回滾,不得留下 revision
    expect(() => overwriteWithRevision(ctx, { table: "projects", rowId: 99999, field: "body_md", newValue: "v1", actor: "ai" }))
      .toThrow(/not found/);
    expect(listRevisions(ctx, { table: "projects", rowId: 99999 })).toHaveLength(0);

    // 已 soft-deleted 的 row 同理(deleted_at 那筆刪除紀錄除外)
    const p = createProject(ctx, { name: "X" });
    softDeleteProject(ctx, p.id);
    expect(() => overwriteWithRevision(ctx, { table: "projects", rowId: p.id, field: "body_md", newValue: "v1", actor: "ai" }))
      .toThrow(/not found/);
    expect(listRevisions(ctx, { table: "projects", rowId: p.id, field: "body_md" })).toHaveLength(0);
  });

  it("rolls the revision back when the overwrite itself fails mid-transaction", () => {
    const ctx = tmpCtx();
    // briefings.body_md 是 NOT NULL:INSERT revision 會成功,後續 UPDATE 才炸。
    // 沒有 transaction 的話,revision 會殘留 —— 這是唯一能區分真交易與兩條散裝語句的斷言。
    ctx.sqlite.prepare(
      "INSERT INTO briefings (kind,date,summary,body_md,created_at,updated_at) VALUES ('daily','2026-08-02','s','v0','2026-08-02T09:00:00','2026-08-02T09:00:00')"
    ).run();
    expect(() => overwriteWithRevision(ctx, {
      table: "briefings", rowId: 1, field: "body_md", newValue: null as unknown as string, actor: "ai",
    })).toThrow();
    expect(listRevisions(ctx, { table: "briefings", rowId: 1 })).toHaveLength(0);
    expect(ctx.sqlite.prepare("SELECT body_md AS v FROM briefings WHERE id=1").get()).toEqual({ v: "v0" });
  });

  it("soft delete writes exactly one deleted_at revision, and none on a miss", () => {
    const ctx = tmpCtx();
    const p = createProject(ctx, { name: "X" });
    softDeleteProject(ctx, p.id);
    const revs = listRevisions(ctx, { table: "projects", rowId: p.id });
    expect(revs).toHaveLength(1);
    expect(revs[0].field).toBe("deleted_at");
    expect(revs[0].oldValue).toBeNull();

    softDeleteProject(ctx, p.id);   // 已刪除:0 rows changed,不得再記一筆
    expect(listRevisions(ctx, { table: "projects", rowId: p.id })).toHaveLength(1);
    softDeleteProject(ctx, 99999);  // 不存在:0 rows changed
    expect(listRevisions(ctx, { table: "projects", rowId: 99999 })).toHaveLength(0);
  });

  it("table allowlists reject inherited Object.prototype keys", () => {
    const ctx = tmpCtx();
    expect(() => trashRestore(ctx, "constructor", 1)).toThrow(/unknown table/);
    expect(() => trashList(ctx, "toString")).toThrow(/unknown table/);
    expect(() => overwriteWithRevision(ctx, { table: "constructor" as never, rowId: 1, field: "body_md", newValue: "v", actor: "ai" }))
      .toThrow(/not overwritable/);
  });
});
