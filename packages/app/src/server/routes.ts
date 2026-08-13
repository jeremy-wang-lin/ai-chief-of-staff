import type { Hono, Context } from "hono";
import type { Ctx } from "@lcos/core";
import { runOp } from "@lcos/core";

/**
 * REST 面就是註冊表的一層投影 —— 這個檔案裡只有 method/path/op/輸入組裝,
 * 沒有任何驗證、預設值或資料判斷。多一行商業邏輯,CLI 與 HTTP 兩邊的行為就開始漂移,
 * 而漂移的那一行永遠不會有人記得同步回 registry。
 */

type InputBuilder = (c: Context, body: Record<string, unknown>) => Record<string, unknown>;

interface Route { method: "get" | "post" | "patch" | "delete"; path: string; op: string; input?: InputBuilder }

/**
 * 空字串的 query param(?status= —— 表單送出未選欄位的常態)必須丟掉而不是往下傳:
 * registry 的 enum 收到 "" 只會回一句看不懂的 INVALID_INPUT,而使用者的意思是「不篩選」。
 */
const q = (c: Context) => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.req.query())) if (v !== "") out[k] = v;
  return out;
};
const idOf = (c: Context) => ({ id: c.req.param("id") });

/** 每資源四式 + by-id;registry 的 zod 負責驗證與 coercion,這裡只組輸入。 */
function crud(table: "tasks" | "notes" | "radar" | "projects", ops: { list: string; get: string; write: string; update: string }): Route[] {
  return [
    { method: "get", path: `/api/${table}`, op: ops.list, input: (c) => q(c) },
    { method: "post", path: `/api/${table}`, op: ops.write, input: (_c, b) => b },
    { method: "get", path: `/api/${table}/:id`, op: ops.get, input: (c) => idOf(c) },
    { method: "patch", path: `/api/${table}/:id`, op: ops.update, input: (c, b) => ({ ...b, ...idOf(c) }) },
    { method: "delete", path: `/api/${table}/:id`, op: "delete.item", input: (c) => ({ table, ...idOf(c), actor: "human" }) },
  ];
}

const routes: Route[] = [
  { method: "get", path: "/api/snapshot", op: "read.snapshot" },
  // 靜態段必須先於 :id 段註冊
  { method: "get", path: "/api/notes/unprocessed", op: "read.unprocessed-notes" },
  ...crud("tasks", { list: "read.tasks", get: "read.task", write: "write.task", update: "update.task" }),
  ...crud("notes", { list: "read.notes", get: "read.note", write: "write.note", update: "update.note" }),
  ...crud("radar", { list: "read.radar", get: "read.radar-item", write: "write.radar", update: "update.radar" }),
  ...crud("projects", { list: "read.projects", get: "read.project", write: "write.project", update: "update.project" }),
  { method: "get", path: "/api/projects/:id/context", op: "read.project-context", input: (c) => ({ projectId: c.req.param("id") }) },
  { method: "get", path: "/api/briefings", op: "read.briefings", input: (c) => q(c) },
  { method: "get", path: "/api/search", op: "search", input: (c) => q(c) },
  { method: "get", path: "/api/revisions", op: "read.revisions", input: (c) => q(c) },
  { method: "post", path: "/api/revisions/:id/restore", op: "revisions.restore", input: (c) => ({ revisionId: c.req.param("id"), actor: "human" }) },
  { method: "get", path: "/api/trash", op: "trash.list", input: (c) => q(c) },
  { method: "post", path: "/api/trash/restore", op: "trash.restore", input: (_c, b) => b },
  // Jira 唯讀查詢:query passthrough(空字串已由 q() 濾掉),op 的 handler 為 async,
  // 未設定/連線失敗會經 onError 翻成 JIRA_UNAVAILABLE / 503。
  { method: "get", path: "/api/jira/sprint", op: "read.jira-sprint", input: (c) => q(c) },
  { method: "get", path: "/api/jira/board", op: "read.jira-board", input: (c) => q(c) },
  { method: "get", path: "/api/jira/stale", op: "read.jira-stale", input: (c) => q(c) },
  { method: "get", path: "/api/jira/unassigned", op: "read.jira-unassigned", input: (c) => q(c) },
  { method: "get", path: "/api/jira/done", op: "read.jira-done", input: (c) => q(c) },
  { method: "get", path: "/api/jira/backlog", op: "read.jira-backlog", input: (c) => q(c) },
];

export function mountRoutes(app: Hono, ctx: Ctx): void {
  for (const r of routes) {
    app[r.method](r.path, async (c) => {
      // 沒有 body 或不是 JSON 一律當空物件:缺欄位該由 registry 的 zod 報成 INVALID_INPUT,
      // 而不是在這裡變成一個像系統故障的 parse error。
      const body = r.method === "post" || r.method === "patch" ? await c.req.json().catch(() => ({})) : {};
      const input = r.input ? r.input(c, body) : {};
      // 部分 op(jira)的 handler 為 async,runOp 因此可能回 Promise —— 一律 await 再序列化;
      // await 非 Promise 值無害,既有同步 op 不受影響。rejection 會往上冒到 app.onError 翻成錯誤碼。
      // void-ish 的 op(如 trash.restore)沒有回傳值 —— 回 {ok:true} 而不是 null body。
      return c.json((await runOp(ctx, r.op, input)) ?? { ok: true });
    });
  }
}
