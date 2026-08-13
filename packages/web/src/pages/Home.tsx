import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Snapshot, type Briefing, type Task } from "../api";
import { Pill, priorityTone } from "../ui/Pill";
import { Markdown } from "../ui/Markdown";
import { queryGuard } from "../ui/QueryState";
import { PageHeader } from "../ui/PageHeader";

/** 面板標題只給月-日(照 mockup 的 `DAILY BRIEFING — 07-30`);完整年份留給 staleness 警示列,那裡才需要精確到年。 */
const mmdd = (date: string) => date.slice(5);

function TaskRowView({ t, overdue }: { t: Task; overdue?: boolean }) {
  return (
    <div className="flex items-center gap-2 border-t border-line py-1.5 text-[13px] first:border-t-0">
      <Pill tone={priorityTone(t.priority)}>{t.priority}</Pill>
      {t.origin === "ai" && <Pill tone="ai">AI</Pill>}
      <span>{t.title}</span>
      <span className={`ml-auto font-mono text-[11.5px] ${overdue ? "text-danger" : "text-muted"}`}>{overdue ? `過期 ${t.dueDate}` : t.dueDate}</span>
    </div>
  );
}

export function HomePage() {
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  const snap = useQuery({ queryKey: ["snapshot"], queryFn: () => api.get<Snapshot>("/snapshot") });
  const briefing = useQuery({ queryKey: ["briefings", "daily", 1], queryFn: () => api.get<Briefing[]>("/briefings", { kind: "daily", limit: 1 }) });
  const capture = useMutation({
    mutationFn: (bodyMd: string) => api.post("/notes", { bodyMd }),
    onSuccess: () => { setDraft(""); qc.invalidateQueries({ queryKey: ["snapshot"] }); },
  });

  const s = snap.data;
  const b = briefing.data?.[0];
  // staleness 以本頁的 daily 查詢為準,不用 snapshot.latestBriefing:後者不分 kind,
  // 剛跑過 /weekly 時它的 date 就是今天,會把「今天還沒跑 /daily」的警示整個蓋掉。
  // 查詢還沒回來(data === undefined)時不顯示 —— 載入中不等於過期。
  const stale = s && briefing.data !== undefined && (!b || b.date < s.today);

  return (
    <div className="grid gap-3.5">
      <PageHeader>
        <h3 className="text-base font-semibold">{s?.today}</h3>
      </PageHeader>
      {stale && (
        <div className="flex items-center gap-2 rounded-lg border border-warn bg-warn-soft px-3 py-1.5 text-[12.5px] text-warn">
          ⚠ 最新 daily briefing 是 {b?.date ?? "（尚無）"} — 今天還沒跑 /daily
        </div>
      )}
      <form onSubmit={(e) => { e.preventDefault(); if (draft.trim()) capture.mutate(draft.trim()); }}
        className="grid gap-1 rounded-lg border-2 border-accent bg-surface px-3 py-2">
        <div className="flex items-center gap-2">
          {/* 打字就是重新開始一次:舊的失敗訊息還掛著,只會讓人分不清那是這次還是上次的事。 */}
          <input aria-label="隨手記" value={draft}
            onChange={(e) => { setDraft(e.target.value); if (capture.isError) capture.reset(); }}
            placeholder="隨手記下任何想法,Enter 存為 Scratch 筆記…"
            className="flex-1 bg-transparent text-sm outline-none" />
          <button type="submit" className="rounded-lg bg-accent px-3 py-1 text-xs font-semibold text-white">存入 Notes</button>
        </div>
        {/* 草稿留著但畫面毫無反應,使用者只會以為 Enter 沒按到,再按一次 —— 然後又一次。 */}
        {capture.isError && <p role="alert" className="text-[12.5px] text-danger">儲存失敗,內容已保留</p>}
      </form>
      <div className="grid grid-cols-[1.5fr_1fr] gap-3 max-md:grid-cols-1">
        <section className="rounded-xl border border-line bg-surface p-3.5">
          <h5 className="mb-2 flex items-center gap-2 text-xs font-bold tracking-widest text-muted"><Pill tone="ai">AI</Pill> DAILY BRIEFING — {b ? mmdd(b.date) : "尚無"}</h5>
          {/* 讀不到 briefing 時不能說「還沒有 briefing,去跑 /daily」—— 那是一句會害人白跑一趟的建議。 */}
          {queryGuard(briefing) ?? (b ? <Markdown source={b.bodyMd} /> : <p className="text-sm text-muted">還沒有 briefing,在 opencode 執行 /daily 產生。</p>)}
        </section>
        <section className="rounded-xl border border-line bg-surface p-3.5">
          <h5 className="mb-2 text-xs font-bold tracking-widest text-muted">今日任務</h5>
          {/* 「今天沒有到期任務 🎉」與「我讀不到資料」是相反的兩件事;
              把後者渲染成前者,使用者會照著那句話安心地過完一天。 */}
          {queryGuard(snap) ?? (
            <>
              {s?.overdue.map((t) => <TaskRowView key={t.id} t={t} overdue />)}
              {s?.dueToday.map((t) => <TaskRowView key={t.id} t={t} />)}
              {s && s.overdue.length === 0 && s.dueToday.length === 0 && <p className="text-sm text-muted">今天沒有到期任務 🎉</p>}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
