import { and, isNull, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { nowLocal } from "../time.ts";

/** 組合 where 條件並排除 soft-deleted。所有 list/get 必經此函式。 */
export function alive(deletedAtCol: SQLiteColumn, ...conds: (SQL | undefined)[]): SQL | undefined {
  return and(isNull(deletedAtCol), ...conds.filter(Boolean) as SQL[]);
}

/**
 * softDeleteX 的可選歸因。刪除紀錄由 softDeleteX 自己在同一 transaction 內寫入,
 * 呼叫端(如操作註冊表)只需傳 actor/workflow,不得另外呼叫 logDeletion — 那會重複記錄。
 */
export interface DeleteOpts { actor?: "ai" | "human"; workflow?: string }

/**
 * 清單查詢的分頁參數。切窗前一律先以 id 遞增排序:
 * 沒有 ORDER BY 的 LIMIT/OFFSET 在 SQL 裡是未定義行為,翻兩頁可能重複或整筆漏掉。
 */
export interface Page { limit?: number; offset?: number }

/**
 * 只給 offset 沒給 limit 時要補的上限。
 * SQLite 的 OFFSET 必須伴隨 LIMIT(`SELECT … OFFSET 10` 是語法錯誤),
 * SQLite 自己的「不限筆數」寫法是 `LIMIT -1`,但 drizzle 會靜靜地把負數 limit 整句丟掉
 * (它只在 limit >= 0 時才產生 limit 子句),結果就是一句缺了 LIMIT 的 OFFSET 語法錯誤。
 * 因此改用一個大到不可能被觸及的正數 —— 本機規模的資料量離它有好幾個數量級。
 */
const NO_LIMIT = Number.MAX_SAFE_INTEGER;

export function paginate<Q extends { limit(n: number): Q; offset(n: number): Q }>(q: Q, p: Page): Q {
  if (p.limit !== undefined) q = q.limit(p.limit);
  else if (p.offset !== undefined) q = q.limit(NO_LIMIT);
  if (p.offset !== undefined) q = q.offset(p.offset);
  return q;
}

export function stamps() {
  const t = nowLocal();
  return { createdAt: t, updatedAt: t };
}

export function touch() {
  return { updatedAt: nowLocal() };
}
