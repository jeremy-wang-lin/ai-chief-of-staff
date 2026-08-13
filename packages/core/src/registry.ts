import { z } from "zod";
import type { Ctx } from "./db.ts";
import { nowLocal } from "./time.ts";
import * as P from "./repos/projects.ts";
import * as T from "./repos/tasks.ts";
import * as R from "./repos/radar.ts";
import * as N from "./repos/notes.ts";
import * as B from "./repos/briefings.ts";
import * as W from "./writers.ts";
import * as Q from "./queries.ts";
import * as V from "./revisions.ts";
import * as X from "./trash.ts";
import { search } from "./search.ts";
import { backupDb } from "./backup.ts";
import { importNdjson } from "./import.ts";
import { createJira, jiraConfigFromEnv } from "./jira.ts";

/**
 * 操作註冊表 —— 系統唯一的操作定義來源。
 * CLI 與 MCP server 都只是這份清單的兩種投影:新增操作只改這裡,兩個介面自動長出來。
 * 因此每個 op 必須自帶完整的自我描述(name / cliPath / mcpName / desc / zod schema),
 * 不得把參數驗證或說明文字留給介面層各自實作 —— 那正是兩邊行為漂移的起點。
 */

/**
 * 錯誤分類的定義已移到 errors.ts(core 內層要丟 OpInputError,而註冊表 import 了整個 core,
 * 留在這裡會產生循環相依)。此處 re-export 以維持既有的 import 路徑。
 */
export { OpInputError, NotFoundError } from "./errors.ts";
import { NotFoundError, OpInputError } from "./errors.ts";

export interface Op {
  name: string;
  cliPath: string[];
  mcpName: string;
  desc: string;
  input: z.ZodTypeAny;
  handler: (ctx: Ctx, input: any) => unknown;
}

/** 讓 handler 的 input 型別綁定該 op 的 schema — schema 與 repo 參數不合會在 typecheck 就爆。 */
function op<S extends z.ZodTypeAny>(o: {
  name: string; cliPath: string[]; mcpName: string; desc: string;
  input: S; handler: (ctx: Ctx, input: z.output<S>) => unknown;
}): Op {
  return o;
}

/** repo 回傳 undefined(查無/已刪)一律翻成 NotFoundError,而不是讓 CLI 印出一個 null。 */
function found<T>(row: T | undefined, table: string, rowId: number): T {
  if (!row) throw new NotFoundError(`${table}#${rowId} not found`);
  return row;
}

/**
 * 覆寫/復原類函式(overwriteWithRevision、trashRestore)以泛用 Error 表達「查無此列」,
 * 在邊界翻成 NotFoundError,讓介面層有一致的 not-found 分類可用。
 * 只認「查無」訊息:`field not overwritable` 這種真正的輸入錯誤不會被誤吞。
 */
function mapNotFound<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof Error && /not found|not in trash/.test(e.message)) throw new NotFoundError(e.message);
    throw e;
  }
}

// ── 共用欄位 ────────────────────────────────────────────────────────────────
// schema.ts 的 enum 只是 TypeScript 型別約束(DB 不設 CHECK),
// 執行期驗證唯一據點就在這裡 —— 每個 enum 欄位都必須在 zod 層完整列舉。

/**
 * actor 逐 op 決定預設,規則:預設值選「猜錯時比較安全」的那一個,
 * 且註冊表不得與 core 已經宣告的預設互相矛盾。
 *  - 核准動作(delete.item / revisions.restore):預設 human —— 記成 ai 會讓人誤以為是自動化幹的
 *  - write.briefing:不設預設,交給 upsertBriefing 的 `?? "ai"`(briefing 本來就是 AI 產出)
 *  - write.pitch / write.project-body:必填 —— 人機都會寫,core 也把它當必填位置參數,不猜
 */
const actorEnum = z.enum(["ai", "human"]);
const actorApproval = actorEnum.default("human");
const workflow = z.string().optional();

/**
 * trash 與 revisions 認得的表(含 briefings)。
 * briefings 保留在這裡是刻意的:目前沒有任何路徑會刪它,但萬一將來有,
 * trash.list/restore 必須撈得到 —— 一個進得去卻出不來的垃圾桶比沒有垃圾桶更糟。
 */
const tableName = z.enum(["projects", "tasks", "radar", "notes", "briefings"]);

/**
 * delete.item 能刪的表 —— 不含 briefings。
 * briefings 蓄意不開放:同 kind+date 直接覆寫即可,刪除只會製造查不到的空洞。
 * 用獨立的 enum 而不是在 handler 裡判斷,是為了讓這件事在 zod 邊界就成立:
 * 否則 `--help` 會把 briefings 列成合法值,使用者照著打,再被 handler 拒絕。
 */
const deletableTable = z.enum(["projects", "tasks", "radar", "notes"]);

/**
 * 清單分頁。offset 允許 0(第一頁的自然寫法),limit 必須為正:
 * limit 0 的意思是「給我零筆」,那不是任何呼叫端真正想要的東西,更像是把
 * 「沒設定上限」誤傳成了 0。read.briefings 是唯一的例外,見該 op 的註解。
 */
const pagination = {
  limit: z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
};
const taskStatus = z.enum(["To-do", "In Progress", "Done", "Blocked"]);
const priority = z.enum(["P0", "P1", "P2", "P3"]);
const taskSource = z.enum(["Self", "Meeting", "Boss", "Jira"]);
const origin = z.enum(["human", "ai"]);
const projectStatus = z.enum(["Active", "On Hold", "Done"]);
const radarStatus = z.enum(["Open", "In Progress", "Resolved"]);
const noteType = z.enum(["Meeting", "Discussion", "Thinking", "Scratch"]);
const briefingKind = z.enum(["daily", "weekly"]);
const revisionField = z.enum(["body_md", "elevator_pitch", "deleted_at"]);
const id = z.coerce.number().int().positive();

/**
 * CLI 只會給字串,所以 boolean 必須容錯;但不能用 z.coerce.boolean() ——
 * 那是 Boolean(v),`--overdue false` 會變成 true,把旗標的語意整個反過來。
 */
const boolish = z.union([
  z.boolean(),
  z.enum(["true", "1", "yes", "on"]).transform(() => true),
  z.enum(["false", "0", "no", "off", ""]).transform(() => false),
]);

/** 未來新增欄位時,多餘的 key 應該被明確拒絕而不是靜靜吞掉(打錯字的旗標必須報錯)。 */
const obj = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

// write 與 update 共用同一份欄位定義:兩邊各寫一次遲早會漂移(改了 write 卻忘了 update)。
// 各表的主要欄位(title / bodyMd / name)不在其中,因為 write 必填、update 選填。

/**
 * 可為 NULL 的欄位:undefined = 不動這一欄,null = 清成 NULL。
 * 少了 nullable,「清空」這件事在整個 API 上就無法表達 —— 介面層只剩兩條爛路可選:
 * 靜靜地不送(使用者以為清掉了,重整又冒回來),或當場擋下來說做不到。
 * 兩者都是把資料層的一個缺口轉嫁給使用者。
 *
 * 只有 DB 真的允許 NULL 的欄位才進來。tasks/radar 的 title、notes 的 date 與 bodyMd
 * 都是 NOT NULL:讓 null 過得了 zod 只會換來一句 SQLITE_CONSTRAINT ——
 * 一個看起來像系統故障、其實是輸入問題的錯誤。
 * 尤其 notes.date 是「必填但有預設」而不是「可以沒有」,清成 NULL 會讓那則筆記
 * 從所有依日期的查詢裡消失。
 */
const nullableStr = z.string().nullable().optional();
const nullableId = id.nullable().optional();

const taskFields = {
  status: taskStatus.optional(),
  priority: priority.optional(),
  dueDate: nullableStr,
  source: taskSource.optional(),
  origin: origin.optional(),
  owner: nullableStr,
  projectId: nullableId,
  radarId: nullableId,
  noteId: nullableId,
  bodyMd: nullableStr,
};

const radarFields = {
  severity: priority.optional(),
  status: radarStatus.optional(),
  source: nullableStr,
  owner: nullableStr,
  projectId: nullableId,
  noteId: nullableId,
  bodyMd: nullableStr,
};

const noteFields = {
  title: nullableStr,
  date: z.string().optional(),
  type: noteType.optional(),
  attendees: nullableStr,
  projectId: nullableId,
};

const projectFields = {
  status: projectStatus.optional(),
  team: z.string().optional(),
  risk: z.string().optional(),
  nextMilestone: z.string().optional(),
};

// ── 操作清單 ────────────────────────────────────────────────────────────────

export const ops: Op[] = [
  // ---- read ----
  op({
    name: "read.snapshot", cliPath: ["read", "snapshot"], mcpName: "get_today_snapshot",
    desc: "今日工作快照:到期/過期任務、昨日完成、未處理筆記、open radar、最新 briefing",
    input: obj({}),
    handler: (ctx) => Q.getSnapshot(ctx),
  }),
  op({
    name: "read.tasks", cliPath: ["read", "tasks"], mcpName: "query_tasks",
    desc: "查詢任務,可依 status/priority/projectId/dueBefore/overdue/origin/noteId 篩選,並以 limit/offset 分頁(依 id 遞增)",
    input: obj({
      status: taskStatus.optional(),
      priority: priority.optional(),
      projectId: id.optional(),
      dueBefore: z.string().optional(),
      overdue: boolish.optional(),
      origin: origin.optional(),
      noteId: id.optional(),
      ...pagination,
    }),
    handler: (ctx, i) => T.listTasks(ctx, i),
  }),
  op({
    name: "read.task", cliPath: ["read", "task"], mcpName: "get_task",
    desc: "讀取單一任務(查無或已刪除為 NOT_FOUND)",
    input: obj({ id }),
    handler: (ctx, i) => found(T.getTask(ctx, i.id), "tasks", i.id),
  }),
  op({
    name: "read.notes", cliPath: ["read", "notes"], mcpName: "query_notes",
    desc: "查詢筆記,可依 type/projectId/since(YYYY-MM-DD 起)篩選,並以 limit/offset 分頁(依 id 遞增)",
    input: obj({
      type: noteType.optional(),
      projectId: id.optional(),
      since: z.string().optional(),
      ...pagination,
    }),
    handler: (ctx, i) => N.listNotes(ctx, i),
  }),
  op({
    name: "read.note", cliPath: ["read", "note"], mcpName: "get_note",
    desc: "讀取單一筆記(查無或已刪除為 NOT_FOUND)",
    input: obj({ id }),
    handler: (ctx, i) => found(N.getNote(ctx, i.id), "notes", i.id),
  }),
  op({
    name: "read.unprocessed-notes", cliPath: ["read", "unprocessed-notes"], mcpName: "query_unprocessed_notes",
    desc: "列出尚未處理(processedAt 為空)的筆記,涵蓋全部筆記類型",
    input: obj({}),
    handler: (ctx) => Q.listUnprocessedNotes(ctx),
  }),
  op({
    name: "read.radar", cliPath: ["read", "radar"], mcpName: "query_radar",
    desc: "查詢雷達項目(風險/議題),可依 status/severity/projectId/noteId 篩選,並以 limit/offset 分頁(依 id 遞增)",
    input: obj({
      status: radarStatus.optional(),
      severity: priority.optional(),
      projectId: id.optional(),
      noteId: id.optional(),
      ...pagination,
    }),
    handler: (ctx, i) => R.listRadar(ctx, i),
  }),
  op({
    // cliPath 用 radar-item 而不是 radar:後者已經是清單 op 的路徑,
    // 兩個 op 共用一條路徑等於有一個永遠不可達。
    name: "read.radar-item", cliPath: ["read", "radar-item"], mcpName: "get_radar_item",
    desc: "讀取單一雷達項目(查無或已刪除為 NOT_FOUND)",
    input: obj({ id }),
    handler: (ctx, i) => found(R.getRadar(ctx, i.id), "radar", i.id),
  }),
  op({
    name: "read.projects", cliPath: ["read", "projects"], mcpName: "query_projects",
    desc: "查詢專案,可依 status 篩選,並以 limit/offset 分頁(依 id 遞增)",
    input: obj({ status: projectStatus.optional(), ...pagination }),
    handler: (ctx, i) => P.listProjects(ctx, i),
  }),
  op({
    // 與 read.project-context 的差別:這裡只回專案本身,不帶其任務/雷達/筆記。
    name: "read.project", cliPath: ["read", "project"], mcpName: "get_project",
    desc: "讀取單一專案本身(不含關聯;要完整脈絡請用 read.project-context)",
    input: obj({ id }),
    handler: (ctx, i) => found(P.getProject(ctx, i.id), "projects", i.id),
  }),
  op({
    name: "read.project-context", cliPath: ["read", "project-context"], mcpName: "get_project_context",
    desc: "單一專案的完整脈絡:專案本身 + 其任務、雷達項目、筆記",
    input: obj({ projectId: id }),
    handler: (ctx, i) => found(Q.getProjectContext(ctx, i.projectId), "projects", i.projectId),
  }),
  op({
    name: "read.briefings", cliPath: ["read", "briefings"], mcpName: "query_briefings",
    desc: "查詢 briefing(依日期新到舊),可依 kind 篩選並限制筆數",
    input: obj({
      kind: briefingKind.optional(),
      // 唯一允許 limit 0 的 op:listBriefings 從一開始就把 0 定義成「不要任何列」
      // (用來只問「有沒有」而不要內容),那是既有且有測試守住的語意,不改。
      limit: z.coerce.number().int().nonnegative().optional(),
    }),
    handler: (ctx, i) => B.listBriefings(ctx, i),
  }),
  op({
    name: "read.weekly-data", cliPath: ["read", "weekly-data"], mcpName: "get_weekly_data",
    desc: "週報素材:該週的 briefing、完成任務、雷達異動(weekStart 預設本週一)",
    input: obj({ weekStart: z.string().optional() }),
    handler: (ctx, i) => Q.getWeeklyData(ctx, i.weekStart),
  }),
  op({
    name: "read.revisions", cliPath: ["read", "revisions"], mcpName: "query_revisions",
    desc: "查詢某一資料列的修訂歷史(新到舊),可指定欄位",
    input: obj({ table: tableName, rowId: id, field: revisionField.optional() }),
    handler: (ctx, i) => V.listRevisions(ctx, i),
  }),

  // ---- jira(唯讀,即時查詢外部 Jira,不落地)----
  // handler 一律 async:jiraConfigFromEnv() 未設定時丟 JiraError,連接器方法也 async/丟 JiraError,
  // 兩者都必須落在 async 函式體內才會變成呼叫端 await 得到的 rejection —— 別把 createJira(...) 拆到 handler 外。
  // 每次呼叫重建 connector:它只是無狀態的 fetch 包裝,成本可忽略,換來 handler 不持有跨呼叫狀態。
  op({
    name: "read.jira-sprint", cliPath: ["read", "jira", "sprint"], mcpName: "query_jira_sprint",
    desc: "當前 sprint 概況(依 project 分組的狀態統計與 issue 清單);未給 project 則涵蓋所有設定的專案",
    input: obj({ project: z.string().optional() }),
    handler: async (_ctx, i) => createJira(jiraConfigFromEnv()).sprint(i.project),
  }),
  op({
    name: "read.jira-board", cliPath: ["read", "jira", "board"], mcpName: "query_jira_board",
    desc: "當前 sprint 依負責人分組的 issue 看板(未指派歸為「未指派」)",
    input: obj({}),
    handler: async () => createJira(jiraConfigFromEnv()).board(),
  }),
  op({
    name: "read.jira-stale", cliPath: ["read", "jira", "stale"], mcpName: "query_jira_stale",
    desc: "停滯的 In Progress issue:超過 days 天(預設 3)未更新",
    input: obj({ days: z.coerce.number().int().positive().optional() }),
    handler: async (_ctx, i) => createJira(jiraConfigFromEnv()).stale(i.days),
  }),
  op({
    name: "read.jira-unassigned", cliPath: ["read", "jira", "unassigned"], mcpName: "query_jira_unassigned",
    desc: "當前 sprint 中尚未指派且未完成的 issue",
    input: obj({}),
    handler: async () => createJira(jiraConfigFromEnv()).unassigned(),
  }),
  op({
    name: "read.jira-done", cliPath: ["read", "jira", "done"], mcpName: "query_jira_done",
    desc: "最近完成的 issue;since(YYYY-MM-DD)起算,未給則近 7 天",
    // since 的格式在 zod 邊界就驗:壞日期是輸入問題(INVALID_INPUT/400),不該漏到連接器
    // 才由 assertSince 丟 JiraError 被誤歸成 JIRA_UNAVAILABLE/503。兩層都擋,但這層給對的碼。
    input: obj({ since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "since 需為 YYYY-MM-DD").optional() }),
    handler: async (_ctx, i) => createJira(jiraConfigFromEnv()).done(i.since),
  }),
  op({
    name: "read.jira-backlog", cliPath: ["read", "jira", "backlog"], mcpName: "query_jira_backlog",
    desc: "backlog 頂端(未排入 sprint 且未完成)依 Rank 排序,取前 top 筆(預設 20)",
    input: obj({ top: z.coerce.number().int().positive().optional() }),
    handler: async (_ctx, i) => createJira(jiraConfigFromEnv()).backlog(i.top),
  }),

  // ---- search ----
  op({
    name: "search", cliPath: ["search"], mcpName: "search",
    desc: "全文搜尋所有表;查詢字串一律當字面片語處理,少於 3 字元的查詢在 trigram 索引下查無結果。includeRevisions 可一併搜歷史舊值",
    // 空字串會讓下游的 FTS5 MATCH 直接丟語法錯誤,在邊界就擋掉。
    input: obj({
      q: z.string().trim().min(1),
      includeRevisions: boolish.optional(),
      // 與清單 op 一致:limit 必須為正。搜尋「最多回 0 筆」沒有任何意義 ——
      // 那不是一個使用者會想要的結果,而是把「沒設上限」誤傳成 0 的徵兆。
      limit: z.coerce.number().int().positive().optional(),
    }),
    handler: (ctx, i) => search(ctx, i),
  }),

  // ---- write ----
  op({
    name: "write.task", cliPath: ["write", "task"], mcpName: "create_task",
    desc: "建立任務(AI 提案批准後帶 origin=ai)",
    input: obj({ title: z.string().min(1), ...taskFields }),
    handler: (ctx, i) => T.createTask(ctx, i),
  }),
  op({
    name: "write.radar", cliPath: ["write", "radar"], mcpName: "create_radar",
    desc: "建立雷達項目(需要盯著的風險/議題)",
    input: obj({ title: z.string().min(1), ...radarFields }),
    handler: (ctx, i) => R.createRadar(ctx, i),
  }),
  op({
    name: "write.note", cliPath: ["write", "note"], mcpName: "create_note",
    desc: "建立筆記(date 預設今天,type 預設 Scratch)",
    input: obj({ bodyMd: z.string().min(1), ...noteFields }),
    handler: (ctx, i) => N.createNote(ctx, i),
  }),
  op({
    name: "write.briefing", cliPath: ["write", "briefing"], mcpName: "write_briefing",
    desc: "寫入 briefing(同 kind+date 覆寫更新並留 revision);actor 未給時記為 ai",
    input: obj({
      kind: briefingKind, date: z.string(),
      summary: z.string(), bodyMd: z.string(),
      actor: actorEnum.optional(), workflow,
    }),
    handler: (ctx, i) => B.upsertBriefing(ctx, i),
  }),
  op({
    name: "write.pitch", cliPath: ["write", "pitch"], mcpName: "update_elevator_pitch",
    desc: "覆寫專案電梯簡報(舊值進 revisions,可還原);actor 必填",
    input: obj({ projectId: id, pitch: z.string(), actor: actorEnum, workflow }),
    handler: (ctx, i) => {
      mapNotFound(() => W.updatePitch(ctx, i.projectId, i.pitch, i.actor, i.workflow));
      return { ok: true };
    },
  }),
  op({
    name: "write.project-body", cliPath: ["write", "project-body"], mcpName: "write_project_body",
    desc: "覆寫專案內文 Markdown(舊值進 revisions,可還原);actor 必填",
    input: obj({ projectId: id, bodyMd: z.string(), actor: actorEnum, workflow }),
    handler: (ctx, i) => {
      mapNotFound(() => W.updateProjectBody(ctx, i.projectId, i.bodyMd, i.actor, i.workflow));
      return { ok: true };
    },
  }),
  op({
    name: "write.project", cliPath: ["write", "project"], mcpName: "create_project",
    desc: "建立專案(status 預設 Active)",
    input: obj({ name: z.string().min(1), ...projectFields }),
    handler: (ctx, i) => P.createProject(ctx, i),
  }),

  // ---- update ----
  op({
    name: "update.note", cliPath: ["update", "note"], mcpName: "update_note",
    desc: "更新筆記欄位;processed=true 蓋上處理時間戳(processedAt),processed=false 為 no-op(不提供取消已處理)",
    input: obj({
      id,
      bodyMd: z.string().optional(),
      ...noteFields,
      processed: boolish.optional(),
    }),
    handler: (ctx, i) => {
      // processed 只存在於註冊表層:DB 存的是時間戳而非布林,直接把 key 塞進 patch 會撞上未知欄位。
      const { id: noteId, processed, ...patch } = i;
      return found(
        N.updateNote(ctx, noteId, processed ? { ...patch, processedAt: nowLocal() } : patch),
        "notes", noteId,
      );
    },
  }),
  op({
    name: "update.task", cliPath: ["update", "task"], mcpName: "update_task",
    desc: "更新任務欄位(狀態、優先級、期限、負責人、關聯等)",
    input: obj({ id, title: z.string().min(1).optional(), ...taskFields }),
    handler: (ctx, i) => {
      const { id: taskId, ...patch } = i;
      return found(T.updateTask(ctx, taskId, patch), "tasks", taskId);
    },
  }),
  op({
    name: "update.radar", cliPath: ["update", "radar"], mcpName: "update_radar",
    desc: "更新雷達項目欄位(狀態 Open→In Progress→Resolved、嚴重度、負責人、關聯等)",
    input: obj({ id, title: z.string().min(1).optional(), ...radarFields }),
    handler: (ctx, i) => {
      const { id: radarId, ...patch } = i;
      return found(R.updateRadar(ctx, radarId, patch), "radar", radarId);
    },
  }),
  op({
    name: "update.project", cliPath: ["update", "project"], mcpName: "update_project",
    desc: "更新專案欄位(名稱、狀態、團隊、風險、下個里程碑);內文與電梯簡報請用 write.project-body / write.pitch",
    input: obj({ id, name: z.string().min(1).optional(), ...projectFields }),
    handler: (ctx, i) => {
      const { id: projectId, ...patch } = i;
      return found(P.updateProject(ctx, projectId, patch), "projects", projectId);
    },
  }),

  // ---- delete / trash / revisions ----
  op({
    name: "delete.item", cliPath: ["delete"], mcpName: "delete_item",
    desc: "soft delete 一筆 projects/tasks/radar/notes 資料列(可從 trash 復原)",
    // 值域用 deletableTable(不含 briefings):合法值在 zod 邊界就講清楚,
    // --help 才不會列出一個打了必被拒絕的選項。
    input: obj({ table: deletableTable, id, actor: actorApproval, workflow }),
    handler: (ctx, i) => {
      // softDeleteX 內部已在同一 transaction 記錄 logDeletion,此處不得重複呼叫。
      const del = {
        projects: P.softDeleteProject, tasks: T.softDeleteTask,
        radar: R.softDeleteRadar, notes: N.softDeleteNote,
      }[i.table];
      del(ctx, i.id, { actor: i.actor, workflow: i.workflow });
      return { ok: true };
    },
  }),
  op({
    name: "trash.list", cliPath: ["trash", "list"], mcpName: "trash_list",
    desc: "列出已 soft delete 的資料列(不指定 table 則列出全部)",
    input: obj({ table: tableName.optional() }),
    handler: (ctx, i) => X.trashList(ctx, i.table),
  }),
  op({
    name: "trash.restore", cliPath: ["trash", "restore"], mcpName: "trash_restore",
    desc: "把 trash 中的資料列復原(復原本身也會留下一筆 revision);actor 未給時記為 human",
    // table 用 tableName 而非 deletableTable:進得去的東西一定要出得來 ——
    // 就算現在沒有路徑會刪 briefing,將來有了也不該被一個過窄的值域鎖在垃圾桶裡。
    input: obj({ table: tableName, id, actor: actorApproval }),
    handler: (ctx, i) => {
      mapNotFound(() => X.trashRestore(ctx, i.table, i.id, i.actor));
      return { ok: true };
    },
  }),
  op({
    name: "revisions.restore", cliPath: ["revisions", "restore"], mcpName: "restore_revision",
    desc: "把某筆 revision 的舊值寫回原欄位(還原本身也會留下新的 revision)",
    input: obj({ revisionId: id, actor: actorApproval }),
    handler: (ctx, i) => {
      mapNotFound(() => V.restoreRevision(ctx, i.revisionId, i.actor));
      return { ok: true };
    },
  }),

  // ---- 維運 ----
  op({
    name: "backup", cliPath: ["backup"], mcpName: "backup_db",
    desc: "備份 DB 檔(VACUUM INTO)至指定目錄,預設 LCOS_BACKUP_DIR",
    input: obj({ dest: z.string().optional() }),
    handler: (ctx, i) => {
      // 不內建預設目錄:猜一個路徑等於把備份寫到使用者沒同意的地方,寧可要求明講。
      const dest = i.dest ?? process.env.LCOS_BACKUP_DIR;
      if (!dest) throw new OpInputError("dest or LCOS_BACKUP_DIR required");
      return { path: backupDb(ctx, dest) };
    },
  }),
  op({
    name: "import", cliPath: ["import"], mcpName: "import_ndjson",
    desc: "NDJSON 批次匯入(整批單一 transaction,任一列失敗全回滾;dryRun 只驗證不落地;"
      + "FK 用自然鍵 project 名稱;行號為檔案行號,空行略過)。"
      + "驗證失敗時回報 ok:false 但 exit code 仍為 0 —— 腳本請判斷 ok 欄位",
    // briefings 不在其中:它以 kind+date 覆寫,批次插入只會製造一堆彼此覆蓋的列。
    input: obj({
      table: z.enum(["projects", "tasks", "radar", "notes"]),
      lines: z.array(z.string()),
      dryRun: boolish.optional(),
    }),
    // 壞列是資料問題而不是操作失敗:回 ok:false 的完整報告,讓呼叫端一次看完所有行號。
    // 這也是為什麼它不丟例外 —— 例外會變成 exit 1 而且只帶得走一句話。
    handler: (ctx, i) => importNdjson(ctx, i),
  }),
];

const BY_NAME = new Map(ops.map(o => [o.name, o]));

export function findOp(name: string): Op {
  const op = BY_NAME.get(name);
  if (!op) throw new Error(`unknown op: ${name}`);
  return op;
}

export function runOp(ctx: Ctx, name: string, rawInput: unknown): unknown {
  const op = findOp(name);
  const parsed = op.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    // path 為空的 issue(例如多餘的 key)不能加前綴,否則訊息會以一個孤兒冒號開頭。
    throw new OpInputError(parsed.error.issues
      .map(i => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
      .join("; "));
  }
  return op.handler(ctx, parsed.data);
}
