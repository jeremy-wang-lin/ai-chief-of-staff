import type { Ctx } from "./db.ts";
import { overwriteWithRevision } from "./revisions.ts";

/** 覆寫型寫入:舊值一律進 revisions,查無資料或已 soft-deleted 時 throw。 */
export function updatePitch(ctx: Ctx, projectId: number, pitch: string, actor: "ai" | "human", workflow?: string): void {
  overwriteWithRevision(ctx, { table: "projects", rowId: projectId, field: "elevator_pitch", newValue: pitch, actor, workflow });
}

export function updateProjectBody(ctx: Ctx, projectId: number, bodyMd: string, actor: "ai" | "human", workflow?: string): void {
  overwriteWithRevision(ctx, { table: "projects", rowId: projectId, field: "body_md", newValue: bodyMd, actor, workflow });
}
