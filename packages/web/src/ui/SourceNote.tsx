import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, type Note } from "../api";
import { noteLabel } from "../noteLabel";

/**
 * 任務/radar 連回它的來源筆記。筆記可能已被 soft delete —— 404 要說「(已刪除筆記)」,
 * 不能沉默:noteId 還在,資訊沒遺失,只是目的地不在了。其他錯誤照 queryGuard 的精神
 * 誠實顯示,不得渲染成空(空看起來像「沒有來源」)。
 */
export function SourceNote({ noteId }: { noteId: number }) {
  const note = useQuery({
    queryKey: ["note", String(noteId)],
    queryFn: () => api.get<Note>(`/notes/${noteId}`),
    retry: false,
  });
  const gone = note.error instanceof ApiError && note.error.status === 404;
  return (
    <div className="flex items-center gap-2 rounded-lg bg-surface2 px-2.5 py-1.5 text-[12.5px]">
      <span className="font-mono text-[11.5px] text-muted">來源筆記</span>
      {note.data ? (
        <Link to={`/notes/${noteId}`} className="font-semibold text-accent underline underline-offset-2">
          {noteLabel(note.data)}
        </Link>
      ) : gone ? (
        <span className="text-muted">(已刪除筆記)</span>
      ) : note.isError ? (
        <span className="text-danger">讀取失敗:{note.error.message}</span>
      ) : (
        <span className="text-muted">載入中…</span>
      )}
      {note.data && (
        <span className="ml-auto font-mono text-[11px] text-muted">
          {note.data.date} · {note.data.type}
        </span>
      )}
    </div>
  );
}
