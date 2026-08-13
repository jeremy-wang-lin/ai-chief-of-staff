import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/main.ts";
import { isolateLanEnv } from "./env-isolation.ts";

// 必須在下面那行 module top-level 的 startServer() 之前:外流的 LCOS_HOST=0.0.0.0
// 會讓整個檔案在 import 階段就丟例外,LCOS_TOKEN 則讓每個請求都 401。
isolateLanEnv();

/**
 * 這支測試刻意不用 app.request():它要問的是「真的把 server 跑起來、真的走 TCP」時
 * 整條路徑會不會斷 —— serve() 的綁定、JSON body 的解析、query string 的編碼,
 * 這些在 app.request() 裡都是繞過去的,而它們正是 build 之後最容易壞的部分。
 */
const db = join(mkdtempSync(join(tmpdir(), "lcos-e2e-")), "t.db");
const s = await startServer({ port: 0, dbPath: db });
const base = `http://127.0.0.1:${s.port}`;
afterAll(() => s.close());

async function post(path: string, body: unknown) {
  return (
    await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  ).json();
}

async function del(path: string) {
  return (await fetch(`${base}${path}`, { method: "DELETE" })).json();
}

async function get(path: string) {
  return (await fetch(`${base}${path}`)).json();
}

describe("e2e smoke: capture → project → search → revision", () => {
  it("full user journey over real http", async () => {
    const p = (await post("/api/projects", { name: "Payment GW" })) as { id: number };
    await post("/api/tasks", { title: "review checkout flow", projectId: p.id, priority: "P1" });
    await post("/api/notes", { bodyMd: "gateway retention 討論" });

    const snap = (await get("/api/snapshot")) as { unprocessedNotes: unknown[] };
    expect(snap.unprocessedNotes).toHaveLength(1);

    const hits = (await get("/api/search?q=retention")) as unknown[];
    expect(hits.length).toBeGreaterThan(0);

    const cx = (await get(`/api/projects/${p.id}/context`)) as { tasks: unknown[] };
    expect(cx.tasks).toHaveLength(1);

    // revision + trash:內文覆寫沒有 REST 路由(那是 AI workflow 的事,見 server-routes.test.ts),
    // 純 HTTP 走得到的留痕路徑是 soft delete —— 刪掉會寫一筆 deleted_at revision,
    // 而復原走 trash 而不是 revision 還原。這條是 UI 上「刪錯了要救回來」的完整路徑。
    const task = (cx.tasks as { id: number }[])[0];
    await del(`/api/tasks/${task.id}`);
    // 先確認真的不見了:少了這一步,最後那句「還原後又是 1 筆」在刪除根本沒生效時也會綠。
    expect(((await get(`/api/projects/${p.id}/context`)) as { tasks: unknown[] }).tasks).toHaveLength(0);
    const revs = (await get(`/api/revisions?table=tasks&rowId=${task.id}`)) as { field: string }[];
    expect(revs.map((r) => r.field)).toContain("deleted_at");
    await post("/api/trash/restore", { table: "tasks", id: task.id });
    const back = (await get(`/api/projects/${p.id}/context`)) as { tasks: unknown[] };
    expect(back.tasks).toHaveLength(1);
  });
});
