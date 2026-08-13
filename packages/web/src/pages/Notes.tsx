import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Note, type Project, type Radar, type Task } from "../api";
import { noteLabel } from "../noteLabel";
import { Pill, priorityTone } from "../ui/Pill";
import { Markdown } from "../ui/Markdown";
import { queryGuard } from "../ui/QueryState";
import { PageHeader } from "../ui/PageHeader";
import { useAutosave } from "./useAutosave";

const TYPES = ["Meeting", "Discussion", "Thinking", "Scratch"] as const;

interface Form {
  title: string;
  type: Note["type"];
  date: string;
  attendees: string;
  projectId: string;
  bodyMd: string;
}

/** 這篇筆記浮出了什麼(任務/radar)——「AI 提案 → 落地」的可回溯證據。兩者皆空就整區不出現,舊筆記不加噪。 */
function DerivedItems({ noteId }: { noteId: number }) {
  const p = { noteId: String(noteId) };
  const tasks = useQuery({ queryKey: ["tasks", p], queryFn: () => api.get<Task[]>("/tasks", p) });
  const radar = useQuery({ queryKey: ["radar", p], queryFn: () => api.get<Radar[]>("/radar", p) });
  // 讀取中/失敗不得靜默消失 —— 區塊不見= 「沒有衍生項目」,那是個不該被謊報的結論。
  const guard = queryGuard(tasks) ?? queryGuard(radar);
  if (!guard && tasks.data!.length === 0 && radar.data!.length === 0) return null;
  return (
    <section aria-label="衍生項目" className="rounded-xl border border-line bg-surface p-3.5 text-[13px]">
      <h5 className="mb-2 text-xs font-bold tracking-widest text-muted">衍生項目</h5>
      {guard ?? (
        <div className="grid gap-1">
          {tasks.data!.map((t) => (
            <Link key={t.id} to={`/tasks/${t.id}`} className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-accent-soft">
              {t.origin === "ai" && <Pill tone="ai">AI</Pill>}
              <Pill tone={priorityTone(t.priority)}>{t.priority}</Pill>
              <Pill tone="mute">{t.status}</Pill>
              <span className="truncate underline underline-offset-2">{t.title}</span>
              <span className="ml-auto font-mono text-[11.5px] text-muted">{t.owner ?? t.dueDate ?? ""}</span>
            </Link>
          ))}
          {radar.data!.map((r) => (
            <Link key={r.id} to={`/radar/${r.id}`} className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-accent-soft">
              <Pill tone={priorityTone(r.severity)}>{r.severity}</Pill>
              <span className="truncate underline underline-offset-2">{r.title}</span>
              <span className="ml-auto font-mono text-[11.5px] text-muted">{r.status}</span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

function Editor({ note }: { note: Note }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<Form>({
    title: note.title ?? "",
    type: note.type,
    date: note.date,
    attendees: note.attendees ?? "",
    projectId: note.projectId ? String(note.projectId) : "",
    bodyMd: note.bodyMd,
  });
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api.get<Project[]>("/projects") });

  const { state, retrying } = useAutosave(form, async (f) => {
    // 清空的欄位送 null:title/attendees/projectId 在 update.note 都是 nullable,
    // null 的意思正是「清成 NULL」(省略則是「別動它」,清空就會重整後又冒回來)。
    // date 是唯一的例外 —— NOT NULL 且有預設,清空的話 "" 會被原樣存進去,
    // 那則筆記從此在所有依日期的查詢裡都對不上。空的時候整個不送,並在畫面上說清楚。
    await api.patch(`/notes/${note.id}`, {
      title: f.title || null,
      type: f.type,
      ...(f.date ? { date: f.date } : {}),
      attendees: f.attendees || null,
      projectId: f.projectId ? Number(f.projectId) : null,
      bodyMd: f.bodyMd,
    });
    qc.invalidateQueries({ queryKey: ["notes"] });
  });

  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  // 日期存不進「沒有」這個值(NOT NULL + 預設今天),而自動儲存沒有「儲存」鈕可以擋。
  // 那就只剩一條路:當場說原值會留著 —— 否則畫面看起來清掉了,重整又冒回來。
  const dropped = note.date && !form.date ? ["日期"] : [];

  return (
    <div className="grid min-w-0 gap-2.5">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface2 px-3 py-2 text-[12.5px]">
        <select
          value={form.type}
          onChange={(e) => set({ type: e.target.value as Note["type"] })}
          aria-label="類型"
          className="rounded-lg border border-line bg-surface px-1.5 py-0.5"
        >
          {TYPES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <input
          type="date"
          value={form.date}
          onChange={(e) => set({ date: e.target.value })}
          aria-label="日期"
          className="bg-transparent font-mono text-[11.5px] text-muted"
        />
        <input
          value={form.title}
          onChange={(e) => set({ title: e.target.value })}
          aria-label="標題"
          placeholder="標題(Scratch 可留白)"
          className="min-w-40 flex-1 bg-transparent font-semibold outline-none"
        />
        <select
          value={form.projectId}
          onChange={(e) => set({ projectId: e.target.value })}
          aria-label="專案"
          className="rounded-lg border border-line bg-surface px-1.5 py-0.5"
        >
          <option value="">無專案</option>
          {projects.data?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <input
          value={form.attendees}
          onChange={(e) => set({ attendees: e.target.value })}
          aria-label="與會者"
          placeholder="與會者"
          className="w-28 bg-transparent outline-none"
        />
        {dropped.length > 0 && (
          <span className="text-xs text-warn">
            {`尚不支援清除${dropped.join("、")},將保留原值;其餘欄位已儲存。`}
          </span>
        )}
        <span className={`ml-auto text-xs ${state === "error" ? "text-danger" : "text-accent"}`}>
          {state === "saving"
            ? "儲存中…"
            : state === "saved"
              ? "已儲存 ✓"
              : state === "error"
                ? // 只有真的還在重試才敢說「重試中」:4xx 已經停下來了,那句話會變成謊話。
                  retrying
                  ? "儲存失敗,重試中"
                  : "儲存失敗"
                : ""}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 max-lg:grid-cols-1">
        <textarea
          value={form.bodyMd}
          onChange={(e) => set({ bodyMd: e.target.value })}
          aria-label="內文"
          rows={22}
          className="rounded-xl border border-line bg-sunk p-3 font-mono text-xs leading-relaxed"
        />
        {/* 窄螢幕收起預覽而不是塞成兩欄:並排的價值在於同時看得見,擠到一半就只剩兩個都難用。 */}
        <div className="overflow-y-auto rounded-xl border border-line p-4 text-[13px] max-lg:hidden">
          <Markdown source={form.bodyMd} />
        </div>
      </div>
      <DerivedItems noteId={note.id} />
    </div>
  );
}

export function NotesPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [typeFilter, setTypeFilter] = useState("");
  const notes = useQuery({
    queryKey: ["notes", typeFilter],
    queryFn: () => api.get<Note[]>("/notes", typeFilter ? { type: typeFilter } : {}),
  });
  const selected = useQuery({
    queryKey: ["note", id],
    queryFn: () => api.get<Note>(`/notes/${id}`),
    enabled: !!id,
  });
  const create = useMutation({
    mutationFn: () => api.post<Note>("/notes", { bodyMd: " ", type: "Meeting" }),
    onSuccess: (n) => {
      qc.invalidateQueries({ queryKey: ["notes"] });
      nav(`/notes/${n.id}`);
    },
  });

  const sorted = [...(notes.data ?? [])].sort((a, b) => b.date.localeCompare(a.date));
  return (
    <div className="grid grid-cols-[240px_1fr] gap-3.5 max-md:grid-cols-1">
      <aside className="grid content-start gap-1.5">
        <PageHeader>
          <h3 className="mr-1 text-base font-semibold">Notes</h3>
          {["", ...TYPES].map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={typeFilter === t}
              onClick={() => setTypeFilter(t)}
              className={`rounded-full px-2 text-[11px] font-semibold ${
                typeFilter === t ? "bg-accent-soft text-accent" : "bg-surface2 text-muted"
              }`}
            >
              {t || "全部"}
            </button>
          ))}
          <button
            type="button"
            onClick={() => create.mutate()}
            className="ml-auto rounded-lg bg-accent px-2 py-0.5 text-xs font-semibold text-white"
          >
            ＋ 新增
          </button>
        </PageHeader>
        {/* 空的清單看起來像「你一則筆記都沒有」;讀取失敗時那句話是假的。 */}
        {queryGuard(notes) ??
          sorted.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => nav(`/notes/${n.id}`)}
              className={`rounded-lg border px-2.5 py-2 text-left text-[12.5px] ${
                String(n.id) === id ? "border-accent bg-accent-soft" : "border-transparent hover:bg-surface"
              }`}
            >
              <div className="flex items-center gap-1.5 font-semibold">
                {noteLabel(n)} {!n.processedAt && <Pill tone="warn">未處理</Pill>}
              </div>
              <div className="font-mono text-[11px] text-muted">
                {n.date} · {n.type}
                {n.processedAt ? " ✓" : ""}
              </div>
            </button>
          ))}
      </aside>
      {/* key:換一則筆記就是換一份草稿。用 effect 把 note 灌回 state 反而會在掛載當下
          製造一次「值變了」,自動儲存看不出那不是使用者改的,於是憑空送出一次 PATCH。 */}
      {/* 網址裡有 id 卻讀不到時,「選一則筆記」是假話 —— 那則筆記選了,只是失敗了。
          有 id 就一律把載入中/讀取失敗交給 queryGuard,沒有 id 才是真的還沒選。 */}
      {id ? (
        queryGuard(selected) ?? (selected.data ? <Editor key={selected.data.id} note={selected.data} /> : null)
      ) : (
        <p className="pt-8 text-center text-sm text-muted">選一則筆記,或按「＋ 新增」。</p>
      )}
    </div>
  );
}
