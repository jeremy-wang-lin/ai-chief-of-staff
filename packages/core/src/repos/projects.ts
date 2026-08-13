import { asc, eq } from "drizzle-orm";
import type { Ctx } from "../db.ts";
import { projects, type Project } from "../schema.ts";
import { alive, paginate, stamps, touch, type Page } from "./helpers.ts";
import { nowLocal } from "../time.ts";
import { logDeletion } from "../revisions.ts";
import type { DeleteOpts } from "./helpers.ts";

export interface NewProject {
  name: string;
  status?: Project["status"];
  team?: string; risk?: string; nextMilestone?: string;
}

export function createProject(ctx: Ctx, input: NewProject): Project {
  return ctx.db.insert(projects).values({ ...input, ...stamps() }).returning().get();
}

/** 單筆讀取(已 soft-deleted 視同不存在)。 */
export function getProject(ctx: Ctx, id: number): Project | undefined {
  return ctx.db.select().from(projects).where(alive(projects.deletedAt, eq(projects.id, id))).get();
}

export interface ProjectFilter extends Page {
  status?: Project["status"];
}

export function listProjects(ctx: Ctx, f: ProjectFilter = {}): Project[] {
  const q = ctx.db.select().from(projects)
    .where(alive(projects.deletedAt, f.status ? eq(projects.status, f.status) : undefined))
    .orderBy(asc(projects.id)).$dynamic();
  return paginate(q, f).all();
}

/** 查無資料或已 soft-deleted 時回傳 undefined(交由上層轉成 NOT_FOUND)。 */
export function updateProject(ctx: Ctx, id: number, patch: Partial<NewProject>): Project | undefined {
  return ctx.db.update(projects).set({ ...patch, ...touch() })
    .where(alive(projects.deletedAt, eq(projects.id, id))).returning().get();
}

export function softDeleteProject(ctx: Ctx, id: number, opts: DeleteOpts = {}): void {
  const t = nowLocal();
  ctx.sqlite.transaction(() => {
    const info = ctx.db.update(projects).set({ deletedAt: t, updatedAt: t })
      .where(alive(projects.deletedAt, eq(projects.id, id))).run();
    if (info.changes > 0) logDeletion(ctx, "projects", id, opts.actor ?? "human", opts.workflow);
  })();
}
