import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type SearchHit } from "./api";
import { Pill } from "./ui/Pill";

/**
 * snippet 是 FTS 回來的 HTML(命中詞包在 <mark> 裡),要注入才會有高亮,
 * 但注入的內容源自使用者自己寫的筆記 —— 直接 dangerouslySetInnerHTML 等於把
 * 筆記內文當程式碼執行。白名單只留 <mark>/</mark>,其餘標籤(含帶屬性的
 * <mark class=…>、<img onerror=…>、<script>)一律剝掉。
 */
export function sanitizeSnippet(s: string): string {
  return s.replace(/<(?!\/?mark>)[^>]*>/g, "");
}

/** 命中要能點回原處;歷史版本沒有自己的頁面,MVP 先導回專案列表。 */
export function hitPath(h: SearchHit): string {
  if (h.isRevision) return "/projects";
  switch (h.table) {
    case "notes":
      return `/notes/${h.rowId}`;
    case "projects":
      return `/projects/${h.rowId}`;
    case "tasks":
      return `/tasks/${h.rowId}`;
    case "radar":
      return `/radar/${h.rowId}`;
    default:
      return "/briefings";
  }
}

export function SearchOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [includeRevisions, setIncludeRevisions] = useState(false);
  // 每個按鍵都打一次全文檢索會把 SQLite 打爆;打完字停 300ms 才問。
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 300);
    return () => clearTimeout(t);
  }, [q]);
  const hits = useQuery({
    queryKey: ["search", debounced, includeRevisions],
    queryFn: () =>
      api.get<SearchHit[]>("/search", {
        q: debounced,
        ...(includeRevisions ? { includeRevisions: true } : {}),
      }),
    // 空字串是「還沒開始搜」,不是「搜空字串」;關著的時候也不查 —— 否則上一次留下的 q
    // 會在浮層看不見時因為視窗重新聚焦而再打一次沒人在等的全文檢索。
    enabled: open && debounced.trim().length > 0,
  });
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/25 pt-24" onClick={onClose}>
      <div
        role="dialog"
        // 不宣告 aria-modal:沒有 focus trap 就等於對螢幕閱讀器謊稱背景已隔離,
        // 使用者 Tab 出去卻回不來,比不宣告更糟。進場靠輸入框的 autoFocus。
        aria-label="全域搜尋"
        className="mx-auto max-w-xl overflow-hidden rounded-xl border border-line2 bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
          🔍
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜尋所有內容…"
            className="flex-1 bg-transparent text-sm outline-none"
          />
          <label className="flex items-center gap-1.5 whitespace-nowrap text-xs text-muted">
            <input
              type="checkbox"
              checked={includeRevisions}
              onChange={(e) => setIncludeRevisions(e.target.checked)}
            />
            包含歷史版本
          </label>
        </div>
        {/* 後端一次可以回 20 筆:矮一點的視窗上,沒有這層捲動的話後面幾筆會被裁掉且搆不到。 */}
        <div className="max-h-[70vh] overflow-y-auto">
          {hits.data?.map((h, i) => (
            <button
              key={i}
              type="button"
              onClick={() => {
                nav(hitPath(h));
                onClose();
              }}
              className="block w-full border-b border-line px-4 py-2 text-left text-[13px] last:border-b-0 hover:bg-surface2"
            >
              <div className="flex items-center gap-2 font-semibold">
                <Pill tone={h.isRevision ? "ai" : "mute"}>{h.isRevision ? "Revision" : h.table}</Pill>
                {h.title}
                {h.revisionCreatedAt && (
                  <span className="font-mono text-[11px] text-muted">{h.revisionCreatedAt.slice(0, 10)} 版</span>
                )}
              </div>
              <div
                className="text-[12.5px] text-muted [&_mark]:rounded [&_mark]:bg-warn-soft [&_mark]:px-0.5 [&_mark]:text-warn"
                dangerouslySetInnerHTML={{ __html: sanitizeSnippet(h.snippet) }}
              />
            </button>
          ))}
          {debounced && hits.data?.length === 0 && <p className="px-4 py-3 text-sm text-muted">沒有結果。</p>}
        </div>
      </div>
    </div>
  );
}
