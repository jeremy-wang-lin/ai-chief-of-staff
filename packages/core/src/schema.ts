import { sqliteTable, integer, text, index } from "drizzle-orm/sqlite-core";

const base = {
  id: integer("id").primaryKey({ autoIncrement: true }),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  deletedAt: text("deleted_at"),
};

export const projects = sqliteTable("projects", {
  ...base,
  name: text("name").notNull(),
  // enum 值僅為 TypeScript 型別約束;執行期驗證統一在操作註冊表的 zod schema(DB 層不設 CHECK)
  status: text("status", { enum: ["Active", "On Hold", "Done"] }).notNull().default("Active"),
  team: text("team"),
  risk: text("risk"),
  nextMilestone: text("next_milestone"),
  elevatorPitch: text("elevator_pitch"),
  bodyMd: text("body_md"),
});

export const tasks = sqliteTable("tasks", {
  ...base,
  title: text("title").notNull(),
  status: text("status", { enum: ["To-do", "In Progress", "Done", "Blocked"] }).notNull().default("To-do"),
  priority: text("priority", { enum: ["P0", "P1", "P2", "P3"] }).notNull().default("P2"),
  dueDate: text("due_date"),
  source: text("source", { enum: ["Self", "Meeting", "Boss", "Jira"] }).notNull().default("Self"),
  origin: text("origin", { enum: ["human", "ai"] }).notNull().default("human"),
  owner: text("owner"),
  projectId: integer("project_id").references(() => projects.id),
  radarId: integer("radar_id").references(() => radar.id),
  noteId: integer("note_id").references(() => notes.id),
  bodyMd: text("body_md"),
  /**
   * 完成時間戳,由 repo 在 status 進出 "Done" 時自動維護(不對外開放直接寫入)。
   * 「昨日完成」「本週完成」一律以此為準,而不是 updated_at ——
   * 後者會被改標題、換負責人之類的無關編輯推到今天,讓早就完成的任務又冒出來。
   */
  completedAt: text("completed_at"),
});

export const radar = sqliteTable("radar", {
  ...base,
  title: text("title").notNull(),
  severity: text("severity", { enum: ["P0", "P1", "P2", "P3"] }).notNull().default("P2"),
  status: text("status", { enum: ["Open", "In Progress", "Resolved"] }).notNull().default("Open"),
  source: text("source"),
  owner: text("owner"),
  projectId: integer("project_id").references(() => projects.id),
  noteId: integer("note_id").references(() => notes.id),
  bodyMd: text("body_md"),
});

export const notes = sqliteTable("notes", {
  ...base,
  title: text("title"),
  date: text("date").notNull(),
  type: text("type", { enum: ["Meeting", "Discussion", "Thinking", "Scratch"] }).notNull().default("Scratch"),
  attendees: text("attendees"),
  projectId: integer("project_id").references(() => projects.id),
  processedAt: text("processed_at"),
  bodyMd: text("body_md").notNull(),
});

export const briefings = sqliteTable("briefings", {
  ...base,
  kind: text("kind", { enum: ["daily", "weekly"] }).notNull(),
  date: text("date").notNull(),
  summary: text("summary").notNull(),
  bodyMd: text("body_md").notNull(),
});
/**
 * briefings 的 (kind, date) 唯一索引**不在這裡宣告**:它是帶 `WHERE deleted_at IS NULL` 的
 * partial unique index,而 drizzle 的 schema DSL 表達不出 partial index。
 * 由 migration 0002 擁有(0000 建的全表 uniqueIndex 已在 0002 被 DROP 後重建)。
 * 全表唯一是個陷阱:soft-deleted 的舊 briefing 會永久占住 (kind,date),
 * 讓同一天再也寫不進新的 briefing —— 而使用者只看得到一個 UNIQUE constraint failed。
 * 若日後用 drizzle-kit generate 產生 migration,務必人工檢查它不會想把這個索引「補回來」成全表唯一。
 */

export const revisions = sqliteTable("revisions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tableName: text("table_name").notNull(),
  rowId: integer("row_id").notNull(),
  field: text("field").notNull(),
  oldValue: text("old_value"),
  actor: text("actor", { enum: ["ai", "human"] }).notNull(),
  workflow: text("workflow"),
  createdAt: text("created_at").notNull(),
}, (t) => ({ target: index("revisions_target").on(t.tableName, t.rowId) }));

export type Project = typeof projects.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type RadarItem = typeof radar.$inferSelect;
export type Note = typeof notes.$inferSelect;
export type Briefing = typeof briefings.$inferSelect;
export type Revision = typeof revisions.$inferSelect;
