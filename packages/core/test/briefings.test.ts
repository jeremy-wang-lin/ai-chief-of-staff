import { describe, it, expect } from "vitest";
import { tmpCtx } from "./helpers.ts";
import { upsertBriefing, listBriefings } from "../src/repos/briefings.ts";
import { updatePitch, updateProjectBody } from "../src/writers.ts";
import { createProject, getProject } from "../src/repos/projects.ts";
import { listRevisions } from "../src/revisions.ts";

describe("briefings upsert", () => {
  it("same kind+date twice → one row, body revisioned", () => {
    const ctx = tmpCtx();
    upsertBriefing(ctx, { kind: "daily", date: "2026-08-02", summary: "s1", bodyMd: "b1" });
    const b = upsertBriefing(ctx, { kind: "daily", date: "2026-08-02", summary: "s2", bodyMd: "b2" });
    expect(listBriefings(ctx)).toHaveLength(1);
    expect(b.summary).toBe("s2");
    expect(b.bodyMd).toBe("b2");
    const revs = listRevisions(ctx, { table: "briefings", rowId: b.id, field: "body_md" });
    expect(revs).toHaveLength(1);
    expect(revs[0].oldValue).toBe("b1");
    expect(revs[0].actor).toBe("ai"); // 預設 actor
  });

  it("different kinds same date coexist; list sorts desc and honors limit", () => {
    const ctx = tmpCtx();
    upsertBriefing(ctx, { kind: "daily", date: "2026-08-01", summary: "a", bodyMd: "a" });
    upsertBriefing(ctx, { kind: "weekly", date: "2026-08-01", summary: "w", bodyMd: "w" });
    upsertBriefing(ctx, { kind: "daily", date: "2026-08-02", summary: "b", bodyMd: "b" });
    expect(listBriefings(ctx)).toHaveLength(3);
    expect(listBriefings(ctx, { kind: "daily", limit: 1 })[0].date).toBe("2026-08-02");
  });

  it("kind filter excludes the other kind", () => {
    const ctx = tmpCtx();
    upsertBriefing(ctx, { kind: "daily", date: "2026-08-01", summary: "a", bodyMd: "a" });
    upsertBriefing(ctx, { kind: "weekly", date: "2026-08-01", summary: "w", bodyMd: "w" });
    upsertBriefing(ctx, { kind: "daily", date: "2026-08-02", summary: "b", bodyMd: "b" });
    expect(listBriefings(ctx, { kind: "daily" })).toHaveLength(2);
    const weekly = listBriefings(ctx, { kind: "weekly" });
    expect(weekly).toHaveLength(1);
    expect(weekly[0].summary).toBe("w");
  });

  it("update path is atomic: a failing summary write rolls back the body revision", () => {
    const ctx = tmpCtx();
    const b = upsertBriefing(ctx, { kind: "daily", date: "2026-08-02", summary: "s1", bodyMd: "b1" });
    // 只在「更新 summary」那一句上引爆(revision + body_md 那句不含 summary,不會觸發),
    // 藉此模擬 revision 已寫入、summary 卻失敗的撕裂點。
    ctx.sqlite.exec("CREATE TRIGGER boom BEFORE UPDATE OF summary ON briefings BEGIN SELECT RAISE(ABORT,'boom'); END");
    expect(() => upsertBriefing(ctx, { kind: "daily", date: "2026-08-02", summary: "s2", bodyMd: "b2" })).toThrow();
    ctx.sqlite.exec("DROP TRIGGER boom");
    const row = listBriefings(ctx)[0];
    expect(row.bodyMd).toBe("b1");
    expect(row.summary).toBe("s1");
    expect(listRevisions(ctx, { table: "briefings", rowId: b.id })).toHaveLength(0);
  });

  it("limit 0 returns nothing", () => {
    const ctx = tmpCtx();
    upsertBriefing(ctx, { kind: "daily", date: "2026-08-01", summary: "a", bodyMd: "a" });
    expect(listBriefings(ctx, { limit: 0 })).toHaveLength(0);
  });
});

describe("overwrite writers", () => {
  it("updatePitch and updateProjectBody leave revisions", () => {
    const ctx = tmpCtx();
    const p = createProject(ctx, { name: "X" });
    updatePitch(ctx, p.id, "一句話", "ai", "daily");
    updateProjectBody(ctx, p.id, "# 知識庫", "ai", "summarize-projects");
    expect(getProject(ctx, p.id)!.elevatorPitch).toBe("一句話");
    expect(getProject(ctx, p.id)!.bodyMd).toBe("# 知識庫");
    const revs = listRevisions(ctx, { table: "projects", rowId: p.id }); // id 新→舊
    expect(revs).toHaveLength(2);
    expect(revs[0]).toMatchObject({ field: "body_md", actor: "ai", workflow: "summarize-projects" });
    expect(revs[1]).toMatchObject({ field: "elevator_pitch", actor: "ai", workflow: "daily" });
  });
});
