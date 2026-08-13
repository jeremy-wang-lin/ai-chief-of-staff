import { describe, it, expect } from "vitest";
import type { Hono } from "hono";
import { runOp } from "@lcos/core";
import { tmpApp } from "./server-helpers.ts";

async function json(res: Response) { return res.json() as Promise<any>; }

const JSON_HEADERS = { "content-type": "application/json" };

async function post(app: Hono, path: string, body: unknown) {
  return app.request(path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
}
async function patch(app: Hono, path: string, body: unknown) {
  return app.request(path, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(body) });
}

describe("REST routes", () => {
  it("task CRUD roundtrip", async () => {
    const { app } = tmpApp();
    const created = await json(await app.request("/api/tasks", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "hello", priority: "P1" }),
    }));
    expect(created.priority).toBe("P1");
    const got = await json(await app.request(`/api/tasks/${created.id}`));
    expect(got.title).toBe("hello");
    const patched = await json(await app.request(`/api/tasks/${created.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "Done" }),
    }));
    expect(patched.status).toBe("Done");
    expect(patched.completedAt).toBeTruthy();
    const list = await json(await app.request("/api/tasks?status=Done"));
    expect(list).toHaveLength(1);
  });

  it("query filters pass through (overdue boolean, pagination)", async () => {
    const { app } = tmpApp();
    for (const t of ["a", "b", "c"]) {
      await app.request("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: t }) });
    }
    const page = await json(await app.request("/api/tasks?limit=2&offset=1"));
    expect(page.map((t: any) => t.title)).toEqual(["b", "c"]);
    expect(await json(await app.request("/api/tasks?overdue=true"))).toHaveLength(0);
  });

  it("tasks and radar lists filter by noteId", async () => {
    const { app } = tmpApp();
    const note = await json(await post(app, "/api/notes", { bodyMd: "會議記錄" }));
    await post(app, "/api/tasks", { title: "from-note", noteId: note.id });
    await post(app, "/api/tasks", { title: "unrelated" });
    await post(app, "/api/radar", { title: "risk-from-note", noteId: note.id });
    const tasks = await json(await app.request(`/api/tasks?noteId=${note.id}`));
    expect(tasks.map((t: any) => t.title)).toEqual(["from-note"]);
    const radar = await json(await app.request(`/api/radar?noteId=${note.id}`));
    expect(radar.map((r: any) => r.title)).toEqual(["risk-from-note"]);
  });

  it("missing id → 404, bad body → 400", async () => {
    const { app } = tmpApp();
    expect((await app.request("/api/tasks/999")).status).toBe(404);
    const bad = await app.request("/api/tasks", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ priority: "P1" }), // 缺 title
    });
    expect(bad.status).toBe(400);
    expect((await json(bad)).error.code).toBe("INVALID_INPUT");
  });

  it("delete → trash → restore roundtrip", async () => {
    const { app } = tmpApp();
    const t = await json(await app.request("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "x" }) }));
    expect((await app.request(`/api/tasks/${t.id}`, { method: "DELETE" })).status).toBe(200);
    expect(await json(await app.request("/api/tasks"))).toHaveLength(0);
    const trash = await json(await app.request("/api/trash"));
    expect(trash[0]).toMatchObject({ table: "tasks", id: t.id });
    await app.request("/api/trash/restore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ table: "tasks", id: t.id }) });
    expect(await json(await app.request("/api/tasks"))).toHaveLength(1);
  });

  it("notes/unprocessed is not captured by :id route", async () => {
    const { app } = tmpApp();
    await app.request("/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bodyMd: "隨手記" }) });
    const un = await json(await app.request("/api/notes/unprocessed"));
    expect(un).toHaveLength(1);
  });

  it("project context and search work end to end", async () => {
    const { app } = tmpApp();
    const p = await json(await app.request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Payment GW" }) }));
    await app.request("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "review checkout", projectId: p.id }) });
    const cx = await json(await app.request(`/api/projects/${p.id}/context`));
    expect(cx.tasks).toHaveLength(1);
    const hits = await json(await app.request("/api/search?q=checkout"));
    expect(hits.some((h: any) => h.table === "tasks")).toBe(true);
  });

  // 同一張映射表長出四張資源的路由,所以每張都要有自己的往返證據:
  // 只測 tasks 的話,radar 的 op 名稱打錯(read.radar-item 而非 read.radar)不會被任何測試看見。
  it("radar CRUD roundtrip", async () => {
    const { app } = tmpApp();
    const created = await json(await post(app, "/api/radar", { title: "vendor SLA risk", severity: "P0" }));
    expect(created.severity).toBe("P0");
    expect(created.status).toBe("Open");
    const got = await json(await app.request(`/api/radar/${created.id}`));
    expect(got.title).toBe("vendor SLA risk");
    const patched = await json(await patch(app, `/api/radar/${created.id}`, { status: "Resolved" }));
    expect(patched.status).toBe("Resolved");
    expect(await json(await app.request("/api/radar?status=Resolved"))).toHaveLength(1);
    expect(await json(await app.request("/api/radar?status=Open"))).toHaveLength(0);
    expect((await app.request(`/api/radar/${created.id}`, { method: "DELETE" })).status).toBe(200);
    expect(await json(await app.request("/api/radar"))).toHaveLength(0);
  });

  it("note PATCH marks processed", async () => {
    const { app } = tmpApp();
    const n = await json(await post(app, "/api/notes", { bodyMd: "會議紀錄", type: "Meeting" }));
    const patched = await json(await patch(app, `/api/notes/${n.id}`, { processed: true, title: "Sync" }));
    expect(patched.processedAt).toBeTruthy();
    expect(patched.title).toBe("Sync");
    expect(await json(await app.request("/api/notes/unprocessed"))).toHaveLength(0);
    expect(await json(await app.request("/api/notes?type=Meeting"))).toHaveLength(1);
  });

  it("project PATCH and status filter", async () => {
    const { app } = tmpApp();
    const p = await json(await post(app, "/api/projects", { name: "Ledger" }));
    expect(p.status).toBe("Active");
    const patched = await json(await patch(app, `/api/projects/${p.id}`, { status: "On Hold", nextMilestone: "GA" }));
    expect(patched.status).toBe("On Hold");
    expect(patched.nextMilestone).toBe("GA");
    expect(await json(await app.request("/api/projects?status=On%20Hold"))).toHaveLength(1);
    expect(await json(await app.request("/api/projects?status=Active"))).toHaveLength(0);
    expect(await json(await app.request(`/api/projects/${p.id}`))).toMatchObject({ id: p.id, name: "Ledger" });
  });

  it("briefings list filters by kind and limit", async () => {
    const { app, ctx } = tmpApp();
    // briefing 沒有 REST 寫入路由(由 workflow 產出),所以直接經 registry 播種。
    runOp(ctx, "write.briefing", { kind: "daily", date: "2026-01-01", summary: "d1", bodyMd: "# d1" });
    runOp(ctx, "write.briefing", { kind: "daily", date: "2026-01-02", summary: "d2", bodyMd: "# d2" });
    runOp(ctx, "write.briefing", { kind: "weekly", date: "2026-01-05", summary: "w1", bodyMd: "# w1" });
    expect(await json(await app.request("/api/briefings"))).toHaveLength(3);
    const daily = await json(await app.request("/api/briefings?kind=daily&limit=1"));
    expect(daily).toHaveLength(1);
    expect(daily[0].date).toBe("2026-01-02"); // 新到舊
  });

  it("revisions list and restore roundtrip", async () => {
    const { app, ctx } = tmpApp();
    const p = await json(await post(app, "/api/projects", { name: "Payments" }));
    // 內文覆寫沒有 REST 路由,但 revision 的讀取與還原有 —— 用 registry 製造歷史。
    runOp(ctx, "write.project-body", { projectId: p.id, bodyMd: "v1", actor: "human" });
    runOp(ctx, "write.project-body", { projectId: p.id, bodyMd: "v2", actor: "human" });
    const revs = await json(await app.request(`/api/revisions?table=projects&rowId=${p.id}&field=body_md`));
    expect(revs).toHaveLength(2);
    expect(revs[0].oldValue).toBe("v1"); // 新到舊
    expect(await json(await app.request(`/api/projects/${p.id}`))).toMatchObject({ bodyMd: "v2" });
    const restored = await app.request(`/api/revisions/${revs[0].id}/restore`, { method: "POST" });
    expect(restored.status).toBe(200);
    expect(await json(await app.request(`/api/projects/${p.id}`))).toMatchObject({ bodyMd: "v1" });
    // 還原本身也留痕
    expect(await json(await app.request(`/api/revisions?table=projects&rowId=${p.id}`))).toHaveLength(3);
  });

  // jira 路由未設 env 時,connector 丟 JiraError,經 async handler 成為 rejection,
  // onError 翻成 JIRA_UNAVAILABLE / 503 —— 讀不到外部系統是暫時性降級,不是 500 系統故障。
  it("GET /api/jira/sprint degrades to 503 JIRA_UNAVAILABLE when unconfigured", async () => {
    const { app } = tmpApp();
    const res = await app.request("/api/jira/sprint");
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("JIRA_UNAVAILABLE");
  });

  // 路由層不得自行詮釋輸入:未知欄位與壞值都應該一路帶到 registry 的 zod 才被拒絕。
  it("unknown query param and bad enum are rejected as INVALID_INPUT", async () => {
    const { app } = tmpApp();
    const typo = await app.request("/api/tasks?statuss=Done");
    expect(typo.status).toBe(400);
    expect((await json(typo)).error.code).toBe("INVALID_INPUT");
    expect((await app.request("/api/tasks?status=Nope")).status).toBe(400);
    expect((await post(app, "/api/radar", { title: "x", severity: "P9" })).status).toBe(400);
  });
});
