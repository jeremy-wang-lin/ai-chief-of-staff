import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type Briefing } from "../api";
import { Pill } from "../ui/Pill";
import { Markdown } from "../ui/Markdown";
import { queryGuard } from "../ui/QueryState";
import { PageHeader } from "../ui/PageHeader";

export function BriefingsPage() {
  const [kind, setKind] = useState<"daily" | "weekly">("daily");
  const [openId, setOpenId] = useState<number | null>(null);
  // 後端 read.briefings 已保證日期新到舊,前端不再排一次 —— 兩邊各有一套排序遲早會不一致。
  const briefings = useQuery({
    queryKey: ["briefings", kind],
    queryFn: () => api.get<Briefing[]>("/briefings", { kind }),
  });
  const open = briefings.data?.find((b) => b.id === openId);

  return (
    <div className="grid gap-3.5">
      <PageHeader>
        <h3 className="text-base font-semibold">Briefings</h3>
        {(["daily", "weekly"] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => {
              setKind(k);
              // 不清的話換 tab 後畫面會停在另一種 kind 的內文上。
              setOpenId(null);
            }}
            className={`rounded-full px-2.5 text-[11.5px] font-semibold ${
              kind === k ? "bg-accent-soft text-accent" : "bg-surface2 text-muted"
            }`}
          >
            {k}
          </button>
        ))}
      </PageHeader>
      <div className="grid grid-cols-[280px_1fr] gap-3 max-md:grid-cols-1">
        <aside className="grid content-start gap-1">
          {/* 「尚無 briefing」是個結論,不能拿讀取失敗來下 —— 兩者在畫面上長得一模一樣。 */}
          {queryGuard(briefings)}
          {briefings.data?.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => setOpenId(b.id)}
              className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] ${
                b.id === openId ? "bg-accent-soft" : "hover:bg-surface"
              }`}
            >
              <Pill tone="ai">AI</Pill> {b.kind} — {b.date}
            </button>
          ))}
          {briefings.data?.length === 0 && <p className="text-sm text-muted">尚無 {kind} briefing。</p>}
        </aside>
        {open && (
          <section className="rounded-xl border border-line bg-surface p-4">
            <Markdown source={open.bodyMd} />
          </section>
        )}
      </div>
    </div>
  );
}
