import { z } from "zod";
import type { Ctx } from "./db.ts";
import { createProject, listProjects } from "./repos/projects.ts";
import { createTask } from "./repos/tasks.ts";
import { createRadar } from "./repos/radar.ts";
import { createNote } from "./repos/notes.ts";

/**
 * NDJSON 批次匯入 —— 一行一列,整批共用一個 transaction。
 * 半成功是最糟的結果:匯入 500 列壞在第 300 列,使用者既不知道哪些進去了,
 * 重跑又會製造重複。所以任一列不合法就整批不落地,並把每個壞列連同行號一起回報,
 * 讓使用者一次修完再重跑。
 *
 * 對外的 FK 一律用自然鍵(專案名稱)而不是 projectId:
 * 匯入檔通常是人手寫或從別的系統倒出來的,那邊沒有本機的流水號。
 */

/**
 * 每張表能接受的欄位在此完整列舉,且一律 .strict():
 * 打錯字的欄位必須報錯,而不是靜靜地被丟掉 —— 匯入是單向動作,吞掉的欄位沒人會回頭發現。
 * `project` 是自然鍵,只存在於匯入格式中,解析後才換成 projectId。
 */
const rowSchemas = {
  projects: z.object({
    name: z.string().min(1),
    status: z.enum(["Active", "On Hold", "Done"]).optional(),
    team: z.string().optional(),
    risk: z.string().optional(),
    nextMilestone: z.string().optional(),
  }).strict(),
  tasks: z.object({
    title: z.string().min(1),
    status: z.enum(["To-do", "In Progress", "Done", "Blocked"]).optional(),
    priority: z.enum(["P0", "P1", "P2", "P3"]).optional(),
    dueDate: z.string().optional(),
    source: z.enum(["Self", "Meeting", "Boss", "Jira"]).optional(),
    origin: z.enum(["human", "ai"]).optional(),
    owner: z.string().optional(),
    bodyMd: z.string().optional(),
    project: z.string().optional(),
  }).strict(),
  radar: z.object({
    title: z.string().min(1),
    severity: z.enum(["P0", "P1", "P2", "P3"]).optional(),
    status: z.enum(["Open", "In Progress", "Resolved"]).optional(),
    source: z.string().optional(),
    owner: z.string().optional(),
    bodyMd: z.string().optional(),
    project: z.string().optional(),
  }).strict(),
  notes: z.object({
    bodyMd: z.string().min(1),
    title: z.string().optional(),
    date: z.string().optional(),
    type: z.enum(["Meeting", "Discussion", "Thinking", "Scratch"]).optional(),
    attendees: z.string().optional(),
    project: z.string().optional(),
  }).strict(),
} as const;

export type ImportTable = keyof typeof rowSchemas;

/**
 * 一列驗證通過、自然鍵也換成 projectId 之後的型別。
 * `project` 只存在於匯入格式裡,解析後就不該再出現在送進 createX 的物件上。
 */
type ImportRow<R> = Omit<R, "project"> & { projectId?: number };

export interface ImportOpts {
  table: ImportTable;
  /** 原封不動的檔案內容(`split("\n")` 即可):空行由這裡略過,呼叫端先濾會讓行號對不上檔案。 */
  lines: string[];
  /** 只驗證不落地:先跑一次確認整份檔案乾淨,再真的匯入。 */
  dryRun?: boolean;
}

export interface ImportResult {
  ok: boolean;
  /** 實際處理的資料列數(= 非空行數);空行不是資料,不列入計數。 */
  total: number;
  inserted: number;
  /**
   * line 是**檔案裡的**行號(1-based,空行照樣佔一個號碼)。
   * 使用者要拿它回去改檔案,若改用「第幾筆資料」編號,每個空行都會讓人改錯行。
   */
  errors: { line: number; message: string }[];
}

/** 空行(含只有空白的行、以及結尾換行留下的那一個)不是資料也不是錯誤,單純跳過。 */
const isBlank = (line: string) => line.trim() === "";

/**
 * 表別派送。每個分支把該表的 schema 與 createX 綁在一起交給 runImport,
 * TypeScript 便會逐表檢查「schema 解析出來的列」餵不餵得進「repo 的 New* 參數」——
 * 這正是原本 `as (ctx, row: any) => unknown` 那個 cast 吞掉的資訊:
 * 在 rowSchemas 裡加一個 New* 沒有的欄位,以前要等匯入時才會發現,現在 typecheck 就爆。
 *
 * 走 repo 的 createX 而不是直接 insert:預設值(date、status)、時間戳與 FTS trigger
 * 都掛在那條路徑上,繞過去等於匯入的資料跟手動建立的資料長得不一樣。
 */
export function importNdjson(ctx: Ctx, opts: ImportOpts): ImportResult {
  switch (opts.table) {
    case "projects": return runImport(ctx, opts, rowSchemas.projects, createProject);
    case "tasks": return runImport(ctx, opts, rowSchemas.tasks, createTask);
    case "radar": return runImport(ctx, opts, rowSchemas.radar, createRadar);
    case "notes": return runImport(ctx, opts, rowSchemas.notes, createNote);
  }
}

function runImport<R>(
  ctx: Ctx,
  opts: ImportOpts,
  schema: { safeParse(raw: unknown): z.SafeParseReturnType<unknown, R> },
  create: (ctx: Ctx, row: ImportRow<R>) => unknown,
): ImportResult {
  const errors: ImportResult["errors"] = [];
  const parsed: ImportRow<R>[] = [];

  // 專案名稱沒有唯一約束,所以同名是可能的。同名時「挑最後一個」是在猜,
  // 而猜錯會把整批資料掛到別的專案底下 —— 記成 undefined,讓下面把它報成 ambiguous。
  const projectIdByName = new Map<string, number | undefined>();
  for (const p of listProjects(ctx)) {
    projectIdByName.set(p.name, projectIdByName.has(p.name) ? undefined : p.id);
  }

  opts.lines.forEach((line, idx) => {
    if (isBlank(line)) return;
    // 行號取原始陣列位置 —— 那才是使用者在編輯器裡看到的行號
    const lineNo = idx + 1;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      errors.push({ line: lineNo, message: "invalid JSON" });
      return;
    }
    const r = schema.safeParse(raw);
    if (!r.success) {
      errors.push({
        line: lineNo,
        message: r.error.issues
          .map(i => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
          .join("; "),
      });
      return;
    }
    // 唯一的型別斷言,且只描述「自然鍵 project 就地換成 projectId」這一步 ——
    // create 的參數型別仍完全由 schema 推導,rowSchemas 與 New* 的漂移照樣會在 typecheck 爆。
    const row = { ...r.data } as ImportRow<R> & { project?: string };
    if (typeof row.project === "string") {
      const pid = projectIdByName.get(row.project);
      // 找不到就報錯而不是留空:靜靜地匯入一批沒有專案的孤兒列,等於把錯誤延後到看報表時才爆。
      if (pid === undefined) {
        errors.push({
          line: lineNo,
          message: projectIdByName.has(row.project)
            ? `ambiguous project name (multiple projects named): ${row.project}`
            : `project not found: ${row.project}`,
        });
        return;
      }
      delete row.project;
      row.projectId = pid;
    }
    parsed.push(row);
  });

  // total 是實際處理的資料列數(壞列也算),不是檔案行數 —— 空行不該讓使用者以為多匯了幾筆。
  const total = parsed.length + errors.length;

  // 先驗完全部再決定 —— 只回報第一個錯會逼使用者一列一列地修、一次一次地重跑。
  if (errors.length > 0) return { ok: false, total, inserted: 0, errors };
  if (opts.dryRun) return { ok: true, total, inserted: 0, errors: [] };

  // 整批一個 transaction:寫到一半才失敗(例如 DB 層的 trigger/約束)必須整批回滾,
  // 否則使用者拿到的是一個既非成功也非失敗、還無法安全重跑的半成品。
  ctx.sqlite.transaction(() => {
    for (const row of parsed) create(ctx, row);
  })();
  return { ok: true, total, inserted: parsed.length, errors: [] };
}
