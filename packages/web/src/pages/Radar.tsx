import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type Radar, type Project } from "../api";
import { Pill, priorityTone } from "../ui/Pill";
import { queryGuard } from "../ui/QueryState";
import { PageHeader } from "../ui/PageHeader";
import { RadarDrawer } from "./RadarDrawer";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * 本地日期 'YYYY-MM-DD'。刻意不用 toISOString() —— 那是 UTC,台北的凌晨會被算成前一天,
 * 而 updatedAt 存的是本地時間字串;兩邊基準不一致時「幾天沒動」就會整整差一天。
 * (core 的 time.ts 有同一支 todayLocal,但前端不 import @lcos/core:那條型別鏈會把
 *  drizzle/better-sqlite3 拖進 bundle。這裡重述的是同一條規則。)
 */
export function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * updatedAt 距 today 幾天。兩邊都取日期部分、錨在中午再相減 —— 時分秒與 DST 就都影響不了天數。
 * 與 core `queries.ts` 的 daysBetween 同一個式子;today 由呼叫端傳入,這支才測得動(不讀時鐘)。
 */
export function staleDays(updatedAt: string, today: string): number {
  const from = new Date(`${updatedAt.slice(0, 10)}T12:00:00`).getTime();
  const to = new Date(`${today}T12:00:00`).getTime();
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

const STATUS_FILTERS = ["", "Open", "In Progress", "Resolved"] as const;
const SEVERITY_FILTERS = ["", "P0", "P1", "P2", "P3"] as const;

/** 篩選 pill 一列。兩列都有一顆「全部」,靠 group 的 aria-label 才分得出是哪一種的全部。 */
function FilterPills({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-1">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          aria-pressed={value === o}
          onClick={() => onChange(o)}
          className={`rounded-full px-2 text-[11px] font-semibold ${
            value === o ? "bg-accent-soft text-accent" : "bg-surface2 text-muted"
          }`}
        >
          {o || "全部"}
        </button>
      ))}
    </div>
  );
}

export function RadarPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState("");
  const [severity, setSeverity] = useState("");
  const radar = useQuery({
    queryKey: ["radar", status, severity],
    queryFn: () =>
      api.get<Radar[]>("/radar", {
        ...(status ? { status } : {}),
        ...(severity ? { severity } : {}),
      }),
  });
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api.get<Project[]>("/projects") });
  // 編輯選取走網址(可深連結、可從別頁反向連進來);「新增」沒有 id 可放網址,留在 local state。
  // 單筆自己查而不是從清單撈 —— 直開網址時清單可能還沒回來,或被目前的篩選排除掉。
  // retry: false —— 壞掉的深連結(已刪除/打錯的 id)是 404,重試三次只是把同一個答案再問三遍,
  // 代價是使用者盯著「載入中…」看好幾秒才等到「讀取失敗」。SourceNote 也是同一個理由。
  const selected = useQuery({
    queryKey: ["radar-item", id],
    queryFn: () => api.get<Radar>(`/radar/${id}`),
    enabled: !!id,
    retry: false,
  });
  // 每次 render 重算,不記進 state:分頁開著跨過午夜時,天數該跟著換日,而不是停在開頁那天。
  const today = todayLocal();
  // 專案刪除策略(spec):不 cascade — 關聯照常顯示,已刪除(或不存在)的專案標示為「(已刪除專案)」。
  // 但只有在專案清單真的回來之後才能這樣說:查詢還在飛的時候「查無」= 還沒查到,不是被刪了。
  // 參數叫 projectId 而不是 id:網址參數的 id 就在同一個作用域,同名會讀成另一件事。
  const pname = (projectId: number | null) =>
    projectId === null || !projects.isSuccess
      ? ""
      : (projects.data.find((p) => p.id === projectId)?.name ?? "(已刪除專案)");

  return (
    <div className="grid gap-3.5">
      <PageHeader>
        <h3 className="text-base font-semibold">Radar</h3>
        <FilterPills label="狀態篩選" options={STATUS_FILTERS} value={status} onChange={setStatus} />
        <FilterPills label="Severity 篩選" options={SEVERITY_FILTERS} value={severity} onChange={setSeverity} />
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="ml-auto rounded-lg bg-accent px-2.5 py-0.5 text-xs font-semibold text-white"
        >
          ＋ 新增
        </button>
      </PageHeader>
      {/* 讀不到就說讀不到:一張只剩表頭的空表格看起來像「沒有任何風險」,那是最不該被誤讀的一句話。 */}
      {queryGuard(radar) ?? (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[11.5px] tracking-widest text-muted">
                {["SEV", "標題", "專案", "狀態", "最後更新"].map((h) => (
                  <th key={h} className="border-b border-line2 px-2.5 py-1.5">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {radar.data?.map((r) => {
                // 已 Resolved 的項目擺著不動是正常結局,不該被催 —— 只有還沒收掉的才算「放太久」。
                const days = staleDays(r.updatedAt, today);
                const stale = r.status !== "Resolved" && days >= 7;
                return (
                  <tr
                    key={r.id}
                    onClick={() => nav(`/radar/${r.id}`)}
                    className="cursor-pointer border-b border-line hover:bg-surface2"
                  >
                    <td className="px-2.5 py-1.5">
                      <Pill tone={priorityTone(r.severity)}>{r.severity}</Pill>
                    </td>
                    <td className="px-2.5 py-1.5">{r.title}</td>
                    <td className="px-2.5 py-1.5 font-mono text-[11.5px] text-muted">{pname(r.projectId)}</td>
                    <td className="px-2.5 py-1.5">
                      {stale ? (
                        <Pill tone="warn">
                          {r.status} · {days} 天
                        </Pill>
                      ) : (
                        <Pill tone="mute">{r.status}</Pill>
                      )}
                    </td>
                    <td className="px-2.5 py-1.5 font-mono text-[11.5px] text-muted">{r.updatedAt.slice(0, 10)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {/* 網址裡有 id 卻讀不到時不能沉默 —— NOT_FOUND 與連線失敗都要說出來,
          否則深連結進來只會看到一張沒有 drawer 的表格,像是連結壞了。 */}
      {id && queryGuard(selected)}
      <RadarDrawer
        key={creating ? "new" : (selected.data?.id ?? "none")}
        item={creating ? "new" : (selected.data ?? null)}
        onClose={() => {
          setCreating(false);
          if (id) nav("/radar");
        }}
      />
    </div>
  );
}
