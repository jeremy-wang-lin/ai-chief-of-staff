import type { Ctx } from "./db.ts";

export interface SearchHit {
  table: string;
  rowId: number;
  title: string;
  snippet: string;
  isRevision: boolean;
  revisionCreatedAt?: string;
}

export interface SearchOpts {
  q: string;
  includeRevisions?: boolean;
  limit?: number;
}

/**
 * 使用者輸入一律包成 FTS5 phrase,而不是原樣當 MATCH 運算式送進去。
 * 不包的話 "e2e-test"、"foo(bar"、落單的引號、結尾的 AND 都會噴 fts5 syntax error,
 * 而 "body:x" 會被悄悄解讀成欄位過濾 —— 對「打什麼就找什麼」的搜尋框是錯的語意。
 * phrase 內的 " 以 "" 跳脫。
 */
function toPhrase(q: string): string {
  return `"${q.replace(/"/g, '""')}"`;
}

/**
 * FTS5(trigram)全文搜尋。索引由 migration 內的 trigger 維護:
 * soft-deleted 的列不會重新進入 fts_main,所以主索引天然只含存活資料。
 * 歷史舊值(revisions.old_value)只在 includeRevisions 時才查。
 * 注意:trigram tokenizer 要求查詢字串 >= 3 字元,更短的查詢查不到東西。
 * 查詢字串一律當字面片語處理,不支援 AND/OR/NEAR 等 FTS5 運算子。
 */
export function search(ctx: Ctx, opts: SearchOpts): SearchHit[] {
  const limit = opts.limit ?? 20;
  const phrase = toPhrase(opts.q);
  const hits: SearchHit[] = (ctx.sqlite.prepare(
    `SELECT tbl AS "table", rid AS rowId, title,
            snippet(fts_main, 3, '<mark>', '</mark>', '…', 12) AS snippet
     FROM fts_main WHERE fts_main MATCH ? ORDER BY rank LIMIT ?`
  ).all(phrase, limit) as Omit<SearchHit, "isRevision">[])
    .map((r) => ({ ...r, isRevision: false }));

  if (opts.includeRevisions) {
    const revHits: SearchHit[] = (ctx.sqlite.prepare(
      `SELECT tbl AS "table", rid AS rowId, tbl || '.' || field AS title,
              snippet(fts_revisions, 1, '<mark>', '</mark>', '…', 12) AS snippet,
              created_at AS revisionCreatedAt
       FROM fts_revisions WHERE fts_revisions MATCH ? ORDER BY rank LIMIT ?`
    ).all(phrase, limit) as Omit<SearchHit, "isRevision">[])
      .map((r) => ({ ...r, isRevision: true }));
    hits.push(...revHits);
  }
  return hits.slice(0, limit);
}
