import { describe, it, expect, vi } from "vitest";
import { tmpCtx } from "./helpers.ts";
import { ops, findOp, runOp, OpInputError, NotFoundError } from "../src/registry.ts";
import { inputFields } from "../src/projection.ts";
import { listRevisions } from "../src/revisions.ts";
import { todayLocal } from "../src/time.ts";

/** 規格清單:name / cliPath / mcpName — 註冊表必須剛好涵蓋這 38 個操作。 */
const EXPECTED: [string, string[], string][] = [
  ["read.snapshot", ["read", "snapshot"], "get_today_snapshot"],
  ["read.tasks", ["read", "tasks"], "query_tasks"],
  ["read.task", ["read", "task"], "get_task"],
  ["read.notes", ["read", "notes"], "query_notes"],
  ["read.note", ["read", "note"], "get_note"],
  ["read.unprocessed-notes", ["read", "unprocessed-notes"], "query_unprocessed_notes"],
  ["read.radar", ["read", "radar"], "query_radar"],
  // 單筆讀取用 radar-item:read radar 已經是清單 op 的路徑
  ["read.radar-item", ["read", "radar-item"], "get_radar_item"],
  ["read.projects", ["read", "projects"], "query_projects"],
  ["read.project", ["read", "project"], "get_project"],
  ["read.project-context", ["read", "project-context"], "get_project_context"],
  ["read.briefings", ["read", "briefings"], "query_briefings"],
  ["read.weekly-data", ["read", "weekly-data"], "get_weekly_data"],
  ["read.revisions", ["read", "revisions"], "query_revisions"],
  ["read.jira-sprint", ["read", "jira", "sprint"], "query_jira_sprint"],
  ["read.jira-board", ["read", "jira", "board"], "query_jira_board"],
  ["read.jira-stale", ["read", "jira", "stale"], "query_jira_stale"],
  ["read.jira-unassigned", ["read", "jira", "unassigned"], "query_jira_unassigned"],
  ["read.jira-done", ["read", "jira", "done"], "query_jira_done"],
  ["read.jira-backlog", ["read", "jira", "backlog"], "query_jira_backlog"],
  ["search", ["search"], "search"],
  ["write.task", ["write", "task"], "create_task"],
  ["write.radar", ["write", "radar"], "create_radar"],
  ["write.note", ["write", "note"], "create_note"],
  ["write.briefing", ["write", "briefing"], "write_briefing"],
  ["write.pitch", ["write", "pitch"], "update_elevator_pitch"],
  ["write.project-body", ["write", "project-body"], "write_project_body"],
  ["write.project", ["write", "project"], "create_project"],
  ["update.note", ["update", "note"], "update_note"],
  ["update.task", ["update", "task"], "update_task"],
  ["update.radar", ["update", "radar"], "update_radar"],
  ["update.project", ["update", "project"], "update_project"],
  ["delete.item", ["delete"], "delete_item"],
  ["trash.list", ["trash", "list"], "trash_list"],
  ["trash.restore", ["trash", "restore"], "trash_restore"],
  ["revisions.restore", ["revisions", "restore"], "restore_revision"],
  ["backup", ["backup"], "backup_db"],
  ["import", ["import"], "import_ndjson"],
];

describe("operation registry", () => {
  it("every op has unique name, cliPath, mcpName, desc, input schema", () => {
    const names = ops.map(o => o.name);
    expect(new Set(names).size).toBe(names.length);
    const mcp = ops.map(o => o.mcpName);
    expect(new Set(mcp).size).toBe(mcp.length);
    // cliPath 也必須唯一 —— 兩個 op 共用同一條 CLI 路徑等於有一個永遠不可達
    const paths = ops.map(o => o.cliPath.join(" "));
    expect(new Set(paths).size).toBe(paths.length);
    for (const op of ops) {
      expect(op.cliPath.length).toBeGreaterThan(0);
      expect(op.desc.length).toBeGreaterThan(0);
      expect(op.input).toBeTruthy();
      expect(typeof op.handler).toBe("function");
    }
  });

  it("registers exactly the specified 38 operations", () => {
    expect(EXPECTED).toHaveLength(38);
    expect(ops).toHaveLength(EXPECTED.length);
    for (const [name, cliPath, mcpName] of EXPECTED) {
      const op = findOp(name);
      expect(op.cliPath).toEqual(cliPath);
      expect(op.mcpName).toBe(mcpName);
    }
  });

  it("findOp throws on unknown op", () => {
    expect(() => findOp("nope.nope")).toThrow(/unknown op/);
  });

  // jira ops 的 handler 是 async:未設 env 時 jiraConfigFromEnv() 丟 JiraError,
  // 在 async 函式體內成為 rejection,呼叫端 await 才拿得到 —— 這正是三個投影必須 await runOp 的原因。
  it("jira ops surface JIRA_UNAVAILABLE when unconfigured", async () => {
    vi.stubEnv("JIRA_BASE_URL", "");
    const ctx = tmpCtx();
    await expect(Promise.resolve(runOp(ctx, "read.jira-sprint", {}))).rejects.toThrow(/Jira 未設定/);
    vi.unstubAllEnvs();
  });

  // since 的日期格式是輸入問題,必須在 zod 邊界就成為 OpInputError/400,
  // 而不是等連接器 assertSince 丟 JiraError → 被誤歸成 JIRA_UNAVAILABLE/503。
  it("read.jira-done rejects a malformed since at the zod boundary, not as JiraError", async () => {
    const ctx = tmpCtx();
    // 壞日期在 schema 就被擋下 —— 同步丟 OpInputError,handler(及其 async/JiraError)根本不會跑
    expect(() => runOp(ctx, "read.jira-done", { since: "notadate" })).toThrow(OpInputError);
    // 格式正確的 since 穿過 zod 到 handler:未設 env 時在那裡才成為 JiraError rejection(而非 OpInputError),
    // 證明它通過了邊界。await 掉這個 rejection 也順帶消化 promise,避免變成 unhandled rejection。
    vi.stubEnv("JIRA_BASE_URL", "");
    await expect(Promise.resolve(runOp(ctx, "read.jira-done", { since: "2026-08-01" }))).rejects.toThrow(/Jira 未設定/);
    vi.unstubAllEnvs();
  });

  it("runOp validates input via zod", () => {
    const ctx = tmpCtx();
    expect(() => runOp(ctx, "write.task", {})).toThrow(OpInputError); // title 缺
    const task = runOp(ctx, "write.task", { title: "t", origin: "ai" }) as any;
    expect(task.origin).toBe("ai");
    const listed = runOp(ctx, "read.tasks", { origin: "ai" }) as any[];
    expect(listed).toHaveLength(1);
  });

  it("runOp rejects out-of-enum values at the zod boundary", () => {
    const ctx = tmpCtx();
    expect(() => runOp(ctx, "write.task", { title: "t", status: "Doing" })).toThrow(OpInputError);
    expect(() => runOp(ctx, "write.note", { bodyMd: "b", type: "Rant" })).toThrow(OpInputError);
    expect(() => runOp(ctx, "write.project", { name: "p", status: "Paused" })).toThrow(OpInputError);
    expect(() => runOp(ctx, "delete.item", { table: "revisions", id: 1 })).toThrow(OpInputError);
  });

  it("runOp coerces string numbers/booleans from CLI-shaped input", () => {
    const ctx = tmpCtx();
    const p = runOp(ctx, "write.project", { name: "P" }) as any;
    runOp(ctx, "write.task", { title: "t", projectId: String(p.id) });
    expect(runOp(ctx, "read.tasks", { projectId: String(p.id) }) as any[]).toHaveLength(1);
    // "false" 必須是 false —— 非空字串一律 true 會讓 --overdue=false 反過來生效
    expect(runOp(ctx, "read.tasks", { overdue: "false" }) as any[]).toHaveLength(1);
  });

  it("search guards empty query at the boundary", () => {
    const ctx = tmpCtx();
    expect(() => runOp(ctx, "search", { q: "" })).toThrow(OpInputError);
    expect(() => runOp(ctx, "search", { q: "   " })).toThrow(OpInputError);
    runOp(ctx, "write.note", { bodyMd: "支付閘道 kickoff" });
    expect(runOp(ctx, "search", { q: "支付閘道" }) as any[]).toHaveLength(1);
  });

  it("delete.item + trash.restore roundtrip", () => {
    const ctx = tmpCtx();
    const t = runOp(ctx, "write.task", { title: "x" }) as any;
    runOp(ctx, "delete.item", { table: "tasks", id: t.id, actor: "human" });
    expect(runOp(ctx, "read.tasks", {})).toHaveLength(0);
    expect(runOp(ctx, "trash.list", { table: "tasks" }) as any[]).toHaveLength(1);
    runOp(ctx, "trash.restore", { table: "tasks", id: t.id });
    expect(runOp(ctx, "read.tasks", {})).toHaveLength(1);
  });

  it("delete.item logs the deletion exactly once with the given actor", () => {
    const ctx = tmpCtx();
    const n = runOp(ctx, "write.note", { bodyMd: "n" }) as any;
    runOp(ctx, "delete.item", { table: "notes", id: n.id, actor: "ai", workflow: "cleanup" });
    const revs = listRevisions(ctx, { table: "notes", rowId: n.id, field: "deleted_at" });
    expect(revs).toHaveLength(1);
    expect(revs[0].actor).toBe("ai");
    expect(revs[0].workflow).toBe("cleanup");
  });

  it("delete.item defaults actor to human and refuses briefings", () => {
    const ctx = tmpCtx();
    const r = runOp(ctx, "write.radar", { title: "r" }) as any;
    runOp(ctx, "delete.item", { table: "radar", id: r.id });
    expect(listRevisions(ctx, { table: "radar", rowId: r.id })[0].actor).toBe("human");
    const b = runOp(ctx, "write.briefing", { kind: "daily", date: "2026-08-02", summary: "s", bodyMd: "b" }) as any;
    // briefings 在 zod 值域就不是合法的 table —— --help 因此不會把它列成選項,
    // 使用者不會照著打一個必被拒絕的值(這才是拒絕該發生的地方)
    expect(() => runOp(ctx, "delete.item", { table: "briefings", id: b.id })).toThrow(OpInputError);
    expect(inputFields(findOp("delete.item")).find(f => f.key === "table")!.options)
      .toEqual(["projects", "tasks", "radar", "notes"]);
    // trash 這頭仍認得 briefings:進得去的東西一定要出得來
    expect(inputFields(findOp("trash.restore")).find(f => f.key === "table")!.options)
      .toContain("briefings");
  });

  it("write.briefing is idempotent by kind+date", () => {
    const ctx = tmpCtx();
    runOp(ctx, "write.briefing", { kind: "daily", date: "2026-08-02", summary: "a", bodyMd: "a" });
    runOp(ctx, "write.briefing", { kind: "daily", date: "2026-08-02", summary: "b", bodyMd: "b" });
    expect(runOp(ctx, "read.briefings", {})).toHaveLength(1);
  });

  it("update ops throw NotFoundError instead of returning undefined", () => {
    const ctx = tmpCtx();
    expect(() => runOp(ctx, "update.task", { id: 999, status: "Done" })).toThrow(NotFoundError);
    expect(() => runOp(ctx, "update.note", { id: 999, title: "t" })).toThrow(NotFoundError);
    expect(() => runOp(ctx, "read.project-context", { projectId: 999 })).toThrow(NotFoundError);
    const t = runOp(ctx, "write.task", { title: "t" }) as any;
    runOp(ctx, "delete.item", { table: "tasks", id: t.id });
    expect(() => runOp(ctx, "update.task", { id: t.id, status: "Done" })).toThrow(NotFoundError);
  });

  it("update.note translates processed into processedAt", () => {
    const ctx = tmpCtx();
    const n = runOp(ctx, "write.note", { bodyMd: "n" }) as any;
    expect(n.processedAt).toBeNull();
    const untouched = runOp(ctx, "update.note", { id: n.id, title: "T" }) as any;
    expect(untouched.title).toBe("T");
    expect(untouched.processedAt).toBeNull();
    const done = runOp(ctx, "update.note", { id: n.id, processed: true }) as any;
    expect(done.processedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    // processed 是註冊表層的便利欄位,不得原樣落到 DB patch
    expect((done as any).processed).toBeUndefined();
  });

  it("explicit null clears a nullable column; undefined still leaves it alone", () => {
    // 「清空」與「不動這欄」是兩件事,而 optional-only 的 schema 只表達得出後者 ——
    // 於是介面層只能擋下使用者、說做不到。null 是把前者說出口的唯一方式。
    const ctx = tmpCtx();
    const p = runOp(ctx, "write.project", { name: "P" }) as any;
    const t = runOp(ctx, "write.task", {
      title: "t", dueDate: "2026-08-10", projectId: p.id, bodyMd: "內文", owner: "me",
    }) as any;
    const cleared = runOp(ctx, "update.task", { id: t.id, dueDate: null, bodyMd: null }) as any;
    expect(cleared.dueDate).toBeNull();
    expect(cleared.bodyMd).toBeNull();
    // 沒送的欄位不得被順手清掉 —— 那會讓一次改期變成一次資料遺失
    expect(cleared.projectId).toBe(p.id);
    expect(cleared.owner).toBe("me");
    expect((runOp(ctx, "update.task", { id: t.id, projectId: null }) as any).projectId).toBeNull();

    const r = runOp(ctx, "write.radar", { title: "r", projectId: p.id, source: "JIRA-1", bodyMd: "b" }) as any;
    const r2 = runOp(ctx, "update.radar", { id: r.id, projectId: null, source: null, bodyMd: null }) as any;
    expect([r2.projectId, r2.source, r2.bodyMd]).toEqual([null, null, null]);
    expect(r2.title).toBe("r"); // NOT NULL 的欄位沒被波及

    const n = runOp(ctx, "write.note", { bodyMd: "n", title: "T", attendees: "A", projectId: p.id }) as any;
    const n2 = runOp(ctx, "update.note", { id: n.id, title: null, attendees: null, projectId: null }) as any;
    expect([n2.title, n2.attendees, n2.projectId]).toEqual([null, null, null]);
  });

  it("refuses null on NOT NULL columns at the zod boundary", () => {
    // 這些欄位在 DB 是 NOT NULL:讓 null 過得了 zod,只會換來一句 SQLITE_CONSTRAINT ——
    // 一個看起來像系統故障的錯誤,而它其實是輸入問題。
    const ctx = tmpCtx();
    const t = runOp(ctx, "write.task", { title: "t" }) as any;
    expect(() => runOp(ctx, "update.task", { id: t.id, title: null })).toThrow(OpInputError);
    expect(() => runOp(ctx, "update.task", { id: t.id, status: null })).toThrow(OpInputError);
    const n = runOp(ctx, "write.note", { bodyMd: "n" }) as any;
    // date 是「必填但有預設」,不是「可以沒有」:清成 NULL 會讓這則筆記從所有依日期的查詢裡消失
    expect(() => runOp(ctx, "update.note", { id: n.id, date: null })).toThrow(OpInputError);
    expect(() => runOp(ctx, "update.note", { id: n.id, bodyMd: null })).toThrow(OpInputError);
  });

  it("write.pitch / write.project-body keep revisions and restore them", () => {
    const ctx = tmpCtx();
    const p = runOp(ctx, "write.project", { name: "P" }) as any;
    runOp(ctx, "write.pitch", { projectId: p.id, pitch: "v1", actor: "ai", workflow: "elevator" });
    runOp(ctx, "write.pitch", { projectId: p.id, pitch: "v2", actor: "human" });
    const revs = runOp(ctx, "read.revisions", { table: "projects", rowId: p.id, field: "elevator_pitch" }) as any[];
    expect(revs).toHaveLength(2);
    runOp(ctx, "revisions.restore", { revisionId: revs[0].id, actor: "human" });
    expect((runOp(ctx, "read.projects", {}) as any[])[0].elevatorPitch).toBe("v1");
    runOp(ctx, "write.project-body", { projectId: p.id, bodyMd: "# body", actor: "ai" });
    expect((runOp(ctx, "read.projects", {}) as any[])[0].bodyMd).toBe("# body");
  });

  // ── actor 語意逐 op 決定:註冊表不得與 core 已宣告的預設互相矛盾 ──────────
  it("write.briefing has no registry default so core's ai attribution governs", () => {
    const ctx = tmpCtx();
    const b = runOp(ctx, "write.briefing", { kind: "daily", date: "2026-08-02", summary: "a", bodyMd: "a" }) as any;
    runOp(ctx, "write.briefing", { kind: "daily", date: "2026-08-02", summary: "b", bodyMd: "b" });
    const revs = listRevisions(ctx, { table: "briefings", rowId: b.id, field: "body_md" });
    expect(revs).toHaveLength(1);
    expect(revs[0].actor).toBe("ai");
    // 明確指定時仍以呼叫端為準
    runOp(ctx, "write.briefing", { kind: "daily", date: "2026-08-02", summary: "c", bodyMd: "c", actor: "human" });
    expect(listRevisions(ctx, { table: "briefings", rowId: b.id, field: "body_md" })[0].actor).toBe("human");
  });

  it("write.pitch / write.project-body require an explicit actor", () => {
    const ctx = tmpCtx();
    const p = runOp(ctx, "write.project", { name: "P" }) as any;
    expect(() => runOp(ctx, "write.pitch", { projectId: p.id, pitch: "v1" })).toThrow(OpInputError);
    expect(() => runOp(ctx, "write.project-body", { projectId: p.id, bodyMd: "b" })).toThrow(OpInputError);
  });

  it("delete.item / revisions.restore default actor to human", () => {
    const ctx = tmpCtx();
    const p = runOp(ctx, "write.project", { name: "P" }) as any;
    runOp(ctx, "write.pitch", { projectId: p.id, pitch: "v1", actor: "ai" });
    const rev = (runOp(ctx, "read.revisions", { table: "projects", rowId: p.id }) as any[])[0];
    runOp(ctx, "revisions.restore", { revisionId: rev.id });
    const after = runOp(ctx, "read.revisions", { table: "projects", rowId: p.id }) as any[];
    expect(after[0].actor).toBe("human");
  });

  // ── not-found 分類:所有「查無此列」都必須是 NotFoundError ────────────────
  it("overwrite / restore ops translate missing rows into NotFoundError", () => {
    const ctx = tmpCtx();
    expect(() => runOp(ctx, "write.pitch", { projectId: 999, pitch: "x", actor: "ai" })).toThrow(NotFoundError);
    expect(() => runOp(ctx, "write.project-body", { projectId: 999, bodyMd: "x", actor: "ai" })).toThrow(NotFoundError);
    expect(() => runOp(ctx, "trash.restore", { table: "tasks", id: 999 })).toThrow(NotFoundError);
    expect(() => runOp(ctx, "revisions.restore", { revisionId: 999 })).toThrow(NotFoundError);
  });

  it("update.radar / update.project patch rows and throw NotFoundError when missing", () => {
    const ctx = tmpCtx();
    const p = runOp(ctx, "write.project", { name: "P" }) as any;
    const r = runOp(ctx, "write.radar", { title: "risk", projectId: p.id }) as any;
    expect(r.status).toBe("Open");
    const resolved = runOp(ctx, "update.radar", { id: r.id, status: "Resolved", owner: "me" }) as any;
    expect(resolved.status).toBe("Resolved");
    expect(resolved.owner).toBe("me");
    expect(runOp(ctx, "read.radar", { status: "Resolved" }) as any[]).toHaveLength(1);

    const held = runOp(ctx, "update.project", { id: p.id, status: "On Hold", risk: "延期" }) as any;
    expect(held.status).toBe("On Hold");
    expect(held.risk).toBe("延期");

    expect(() => runOp(ctx, "update.radar", { id: 999, status: "Resolved" })).toThrow(NotFoundError);
    expect(() => runOp(ctx, "update.project", { id: 999, status: "Done" })).toThrow(NotFoundError);
    runOp(ctx, "delete.item", { table: "radar", id: r.id });
    expect(() => runOp(ctx, "update.radar", { id: r.id, status: "Open" })).toThrow(NotFoundError);
  });

  it("OpInputError messages carry the field path without a leading colon", () => {
    const ctx = tmpCtx();
    const fieldErr = (() => { try { runOp(ctx, "write.task", {}); } catch (e) { return e as Error; } })()!;
    expect(fieldErr.message).toContain("title:");
    // 多餘的 key 是整個物件層級的問題(path 為空),訊息不得以孤兒冒號開頭
    const strictErr = (() => { try { runOp(ctx, "write.task", { title: "t", nope: 1 }); } catch (e) { return e as Error; } })()!;
    expect(strictErr).toBeInstanceOf(OpInputError);
    expect(strictErr.message.startsWith(":")).toBe(false);
    expect(strictErr.message).toMatch(/nope/);
  });

  it("read ops surface composite queries", () => {
    const ctx = tmpCtx();
    const p = runOp(ctx, "write.project", { name: "P" }) as any;
    runOp(ctx, "write.task", { title: "due", dueDate: todayLocal(), projectId: p.id });
    runOp(ctx, "write.note", { bodyMd: "unprocessed", projectId: p.id });
    const snap = runOp(ctx, "read.snapshot", {}) as any;
    expect(snap.dueToday).toHaveLength(1);
    expect(snap.unprocessedNotes).toHaveLength(1);
    expect(runOp(ctx, "read.unprocessed-notes", {}) as any[]).toHaveLength(1);
    const pctx = runOp(ctx, "read.project-context", { projectId: p.id }) as any;
    expect(pctx.project.id).toBe(p.id);
    expect(pctx.tasks).toHaveLength(1);
    const weekly = runOp(ctx, "read.weekly-data", {}) as any;
    expect(weekly.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(runOp(ctx, "read.radar", {}) as any[]).toHaveLength(0);
    expect(runOp(ctx, "read.notes", { projectId: p.id }) as any[]).toHaveLength(1);
  });

  // ── 單筆讀取:Plan 2(REST/UI)需要「拿一筆」而不是每次都撈全表 ─────────────
  it("get-by-id ops return the row and NotFoundError when missing or trashed", () => {
    const ctx = tmpCtx();
    const p = runOp(ctx, "write.project", { name: "P" }) as any;
    const t = runOp(ctx, "write.task", { title: "T", projectId: p.id }) as any;
    const n = runOp(ctx, "write.note", { bodyMd: "N" }) as any;
    const r = runOp(ctx, "write.radar", { title: "R" }) as any;

    expect((runOp(ctx, "read.task", { id: t.id }) as any).title).toBe("T");
    expect((runOp(ctx, "read.note", { id: n.id }) as any).bodyMd).toBe("N");
    expect((runOp(ctx, "read.radar-item", { id: r.id }) as any).title).toBe("R");
    // read.project 只回專案本身;read.project-context 才帶關聯
    const project = runOp(ctx, "read.project", { id: p.id }) as any;
    expect(project.name).toBe("P");
    expect(project.tasks).toBeUndefined();

    for (const name of ["read.task", "read.note", "read.radar-item", "read.project"]) {
      expect(() => runOp(ctx, name, { id: 999 }), name).toThrow(NotFoundError);
    }
    // 已 soft-deleted 等同不存在,不得從單筆入口漏出來
    runOp(ctx, "delete.item", { table: "tasks", id: t.id });
    expect(() => runOp(ctx, "read.task", { id: t.id })).toThrow(NotFoundError);
  });

  it("list ops page with limit/offset in stable id order", () => {
    const ctx = tmpCtx();
    for (const title of ["a", "b", "c", "d", "e"]) runOp(ctx, "write.task", { title });
    const page = (i: Record<string, unknown>) => (runOp(ctx, "read.tasks", i) as any[]).map(t => t.title);

    expect(page({ limit: 2 })).toEqual(["a", "b"]);
    expect(page({ limit: 2, offset: 2 })).toEqual(["c", "d"]);
    // offset 沒有 limit 也要成立(SQLite 的 OFFSET 必須伴隨 LIMIT,由 repo 補 LIMIT -1)
    expect(page({ offset: 3 })).toEqual(["d", "e"]);
    expect(page({ offset: 99 })).toEqual([]);
    // CLI 只給字串
    expect(page({ limit: "1", offset: "1" })).toEqual(["b"]);
    // 篩選與分頁疊加時,分頁作用在篩選後的結果上
    expect((runOp(ctx, "read.tasks", { status: "To-do", limit: 1, offset: 4 }) as any[]).map(t => t.title))
      .toEqual(["e"]);

    // limit 0 是「給我零筆」,不是任何呼叫端真正想要的東西 —— 在邊界擋掉
    expect(() => runOp(ctx, "read.tasks", { limit: 0 })).toThrow(OpInputError);
    expect(() => runOp(ctx, "read.tasks", { offset: -1 })).toThrow(OpInputError);
    // read.briefings 是唯一例外:limit 0 從一開始就定義成「不要任何列」
    expect(runOp(ctx, "read.briefings", { limit: 0 })).toEqual([]);
  });

  it("pagination reaches every list op", () => {
    const ctx = tmpCtx();
    runOp(ctx, "write.project", { name: "P" });
    runOp(ctx, "write.note", { bodyMd: "N" });
    runOp(ctx, "write.radar", { title: "R" });
    for (const name of ["read.projects", "read.notes", "read.radar"]) {
      expect(runOp(ctx, name, { limit: 1 }) as any[], name).toHaveLength(1);
      expect(runOp(ctx, name, { offset: 1 }) as any[], name).toHaveLength(0);
    }
  });

  // ── 錯誤分類:不能還原的 revision 是輸入問題,不是系統故障 ─────────────────
  it("revisions.restore rejects a deleted_at revision as invalid input", () => {
    const ctx = tmpCtx();
    const t = runOp(ctx, "write.task", { title: "T" }) as any;
    runOp(ctx, "delete.item", { table: "tasks", id: t.id });
    const rev = listRevisions(ctx, { table: "tasks", rowId: t.id, field: "deleted_at" })[0];
    // deleted_at 沒有「把舊值寫回去」的意義(復原刪除是 trash restore 的事),
    // 但它也不是「查無此列」—— 泛用 Error 會被歸成 OP_FAILED,看起來像系統壞了
    expect(() => runOp(ctx, "revisions.restore", { revisionId: rev.id })).toThrow(OpInputError);
    // 訊息要講得出哪裡不對,而不只是丟一個型別
    try { runOp(ctx, "revisions.restore", { revisionId: rev.id }); } catch (e) {
      expect((e as Error).message).toMatch(/deleted_at/);
    }
  });

  // ── 復原也要留痕:刪除有紀錄、復原沒有的話,歷史只剩一半 ───────────────────
  it("trash.restore leaves a revision and bumps updated_at", () => {
    const ctx = tmpCtx();
    const n = runOp(ctx, "write.note", { bodyMd: "N" }) as any;
    runOp(ctx, "delete.item", { table: "notes", id: n.id, actor: "human" });
    const deletedAt = (ctx.sqlite.prepare("SELECT deleted_at AS v FROM notes WHERE id=?").get(n.id) as any).v;
    ctx.sqlite.prepare("UPDATE notes SET updated_at='2000-01-01T00:00:00' WHERE id=?").run(n.id);

    runOp(ctx, "trash.restore", { table: "notes", id: n.id, actor: "ai" });

    const revs = listRevisions(ctx, { table: "notes", rowId: n.id, field: "deleted_at" });
    expect(revs).toHaveLength(2);                       // 刪除一筆 + 復原一筆
    expect(revs[0]).toMatchObject({ actor: "ai", workflow: "trash-restore" });
    expect(revs[0].oldValue).toBe(deletedAt);           // 被清掉的那個時間戳留在歷史裡
    const restored = runOp(ctx, "read.note", { id: n.id }) as any;
    expect(restored.updatedAt).not.toBe("2000-01-01T00:00:00");
  });

  it("trash.restore defaults actor to human", () => {
    const ctx = tmpCtx();
    const r = runOp(ctx, "write.radar", { title: "R" }) as any;
    runOp(ctx, "delete.item", { table: "radar", id: r.id, actor: "ai" });
    runOp(ctx, "trash.restore", { table: "radar", id: r.id });
    expect(listRevisions(ctx, { table: "radar", rowId: r.id })[0].actor).toBe("human");
  });

  it("runOp accepts missing input for zero-arg ops", () => {
    const ctx = tmpCtx();
    expect(runOp(ctx, "read.snapshot", undefined)).toBeTruthy();
    expect(runOp(ctx, "trash.list", undefined)).toEqual([]);
  });

  it("import takes lines as an array and reads dryRun as boolish", () => {
    const ctx = tmpCtx();
    const lines = [JSON.stringify({ title: "imported" })];
    // "false" 必須真的是 false —— coerce.boolean 會讓 --dry-run false 反過來變成不落地
    expect(runOp(ctx, "import", { table: "tasks", lines, dryRun: "false" }))
      .toMatchObject({ ok: true, total: 1, inserted: 1 });
    expect(runOp(ctx, "import", { table: "tasks", lines, dryRun: "true" }))
      .toMatchObject({ ok: true, inserted: 0 });
    expect(runOp(ctx, "read.tasks", {}) as any[]).toHaveLength(1);
    // briefings/revisions 不是可匯入的表,值域在 zod 邊界就要擋掉
    expect(() => runOp(ctx, "import", { table: "briefings", lines })).toThrow(OpInputError);
    expect(() => runOp(ctx, "import", { table: "tasks" })).toThrow(OpInputError);
  });
});
