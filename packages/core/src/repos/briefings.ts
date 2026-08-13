import { desc, eq } from "drizzle-orm";
import type { Ctx } from "../db.ts";
import { briefings, type Briefing } from "../schema.ts";
import { alive, stamps, touch } from "./helpers.ts";
import { overwriteWithRevision } from "../revisions.ts";

export interface BriefingInput {
  kind: Briefing["kind"]; date: string; summary: string; bodyMd: string;
  actor?: "ai" | "human"; workflow?: string;
}

/** (kind,date) 已存在 → body_md 走 revision 後更新 summary;不存在 → insert。 */
export function upsertBriefing(ctx: Ctx, input: BriefingInput): Briefing {
  const existing = ctx.db.select().from(briefings)
    .where(alive(briefings.deletedAt, eq(briefings.kind, input.kind), eq(briefings.date, input.date))).get();
  if (!existing) {
    return ctx.db.insert(briefings).values({
      kind: input.kind, date: input.date, summary: input.summary, bodyMd: input.bodyMd, ...stamps(),
    }).returning().get();
  }
  // 整段包一層 transaction(better-sqlite3 以 savepoint 支援巢狀):
  // 否則 crash 可能停在 body_md 已覆寫、summary 仍是舊值的撕裂狀態。
  return ctx.sqlite.transaction(() => {
    overwriteWithRevision(ctx, {
      table: "briefings", rowId: existing.id, field: "body_md",
      newValue: input.bodyMd, actor: input.actor ?? "ai", workflow: input.workflow,
    });
    return ctx.db.update(briefings).set({ summary: input.summary, ...touch() })
      .where(eq(briefings.id, existing.id)).returning().get();
  })();
}

export function listBriefings(ctx: Ctx, f: { kind?: Briefing["kind"]; limit?: number } = {}): Briefing[] {
  let q = ctx.db.select().from(briefings)
    .where(alive(briefings.deletedAt, f.kind ? eq(briefings.kind, f.kind) : undefined))
    .orderBy(desc(briefings.date), desc(briefings.id)).$dynamic();
  if (f.limit !== undefined) q = q.limit(f.limit); // limit: 0 意為「不要任何列」,不可當成無上限
  return q.all();
}
