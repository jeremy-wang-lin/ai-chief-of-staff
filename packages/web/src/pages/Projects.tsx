import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Project, type ProjectContext, type Revision } from "../api";
import { Pill, priorityTone } from "../ui/Pill";
import { Markdown } from "../ui/Markdown";
import { queryGuard } from "../ui/QueryState";
import { PageHeader } from "../ui/PageHeader";
import { noteLabel } from "../noteLabel";
import { todayLocal } from "./Radar";

/** 電梯簡報是 /daily 產出的,不是使用者要填的欄位 —— 空的時候要說清楚它會自己出現。 */
const NO_PITCH = "（尚無電梯簡報 — /daily 會自動產生）";

function Cards() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api.get<Project[]>("/projects") });
  const create = useMutation({
    mutationFn: () => api.post("/projects", { name: name.trim() }),
    onSuccess: () => {
      setName("");
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  // write.project 的 name 是 min(1):空字串送出去只會換來一個使用者看不見的 400。
  const canCreate = name.trim().length > 0;

  return (
    <div className="grid gap-3.5">
      <PageHeader>
        <h3 className="text-base font-semibold">Projects</h3>
        <form
          className="ml-auto flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (canCreate) create.mutate();
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="＋ 新專案名稱"
            className="rounded-lg border border-line bg-surface px-2 py-1 text-xs"
          />
          <button
            disabled={!canCreate}
            className="rounded-lg bg-accent px-2.5 text-xs font-semibold text-white disabled:opacity-40"
          >
            建立
          </button>
        </form>
      </PageHeader>
      {/* 一片空白的專案牆看起來像「你還沒有任何專案」;讀取失敗時那句話是假的。 */}
      {queryGuard(projects) ?? (
        <div className="grid grid-cols-3 gap-3 max-lg:grid-cols-1">
          {projects.data?.map((p) => (
            <Link
              key={p.id}
              to={`/projects/${p.id}`}
              className="rounded-xl border border-line bg-surface p-3.5 hover:border-accent"
            >
              <div className="flex items-center gap-2 font-semibold">
                {p.name} <Pill tone={p.status === "Active" ? "accent" : "mute"}>{p.status}</Pill>
              </div>
              <p className="mt-1 text-[13px] text-muted">{p.elevatorPitch ?? NO_PITCH}</p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function RevisionRow({ r, onRestored }: { r: Revision; onRestored: () => void }) {
  const [show, setShow] = useState(false);
  const restore = useMutation({ mutationFn: () => api.post(`/revisions/${r.id}/restore`), onSuccess: onRestored });
  return (
    <div className="border-t border-line py-1.5 text-[12.5px] first:border-t-0">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11.5px] text-muted">{r.createdAt.slice(0, 16).replace("T", " ")}</span>
        <Pill tone={r.actor === "ai" ? "ai" : "accent"}>{r.actor === "ai" ? "AI" : "人"}</Pill>
        {r.workflow && <span className="text-[11px] text-muted">{r.workflow}</span>}
        <span className="ml-auto flex gap-1.5">
          <button
            type="button"
            onClick={() => setShow(!show)}
            className="rounded-lg border border-accent px-2 text-[11px] font-semibold text-accent"
          >
            檢視
          </button>
          {/* 還原會覆蓋目前的知識庫 —— 破壞性動作先問一句,不能只靠一顆小按鈕。 */}
          <button
            type="button"
            onClick={() => window.confirm("還原到此版本?目前內容會先存為新版本。") && restore.mutate()}
            className="rounded-lg border border-accent px-2 text-[11px] font-semibold text-accent"
          >
            還原
          </button>
        </span>
      </div>
      {/* 還原失敗時,畫面上唯一會變的東西本來是「什麼都沒變」—— 而使用者剛按下的是
          一個他以為已經生效的破壞性動作。訊息就留在這一列旁邊,不用 alert 打斷。 */}
      {restore.error && (
        <p role="alert" className="mt-1 text-[11.5px] text-danger">
          還原失敗:{restore.error.message}
        </p>
      )}
      {show && (
        <div className="mt-1.5 rounded-lg border border-line bg-sunk p-2.5">
          {/* oldValue 為 null = 這是第一次寫入,之前本來就沒有東西;空白區塊看起來像壞掉。 */}
          <Markdown source={r.oldValue ?? "（首次寫入前為空）"} />
        </div>
      )}
    </div>
  );
}

function Detail({ id }: { id: string }) {
  const qc = useQueryClient();
  const cx = useQuery({
    queryKey: ["project-context", id],
    queryFn: () => api.get<ProjectContext>(`/projects/${id}/context`),
  });
  const revs = useQuery({
    queryKey: ["revisions", "projects", id],
    queryFn: () => api.get<Revision[]>("/revisions", { table: "projects", rowId: id, field: "body_md" }),
  });
  // 還原本身也會寫下一筆新版本:只重抓內文的話歷史清單會停在還原前,
  // 使用者會以為剛剛那一下沒被記錄。
  const refetchAll = () => {
    qc.invalidateQueries({ queryKey: ["project-context", id] });
    qc.invalidateQueries({ queryKey: ["revisions", "projects", id] });
  };

  const data = cx.data;
  // 讀不到就把伺服器的話原樣說出來 —— 一律顯示「找不到」會把連線失敗與 500 都謊報成專案不存在。
  const guard = queryGuard(cx);
  if (!data) return <div className="pt-8">{guard}</div>;
  const p = data.project;
  const today = todayLocal();

  return (
    <div className="grid gap-3.5">
      <div className="flex items-center gap-2">
        <Link to="/projects" className="text-[12.5px] text-muted hover:text-accent">
          ← Projects
        </Link>
        <h3 className="text-base font-semibold">{p.name}</h3>
        <Pill tone={p.status === "Active" ? "accent" : "mute"}>{p.status}</Pill>
      </div>
      <p className="text-[13px] text-muted">
        <Pill tone="ai">AI</Pill> 電梯簡報:{p.elevatorPitch ?? NO_PITCH}
      </p>
      <div className="grid grid-cols-[1.6fr_1fr] gap-3 max-lg:grid-cols-1">
        <section className="rounded-xl border border-line bg-surface p-3.5">
          <h5 className="mb-2 flex items-center gap-2 text-xs font-bold tracking-widest text-muted">
            <Pill tone="ai">AI</Pill> 專案知識庫
          </h5>
          {p.bodyMd ? (
            <Markdown source={p.bodyMd} />
          ) : (
            <p className="text-sm text-muted">尚無內容 — /daily 會自動累積知識。</p>
          )}
        </section>
        <div className="grid content-start gap-3">
          {/* 只報數量的話,使用者知道「有 3 個任務」卻沒有任何辦法走過去看它們是什麼。 */}
          <section className="rounded-xl border border-line bg-surface p-3.5 text-[13px]">
            <h5 className="mb-2 text-xs font-bold tracking-widest text-muted">關聯項目</h5>
            {data.tasks.length + data.radar.length + data.notes.length === 0 && (
              <p className="text-[12.5px] text-muted">尚無關聯項目。</p>
            )}
            {/* 空的分組標題永遠是 0,只是噪音 —— 有東西才給標題。 */}
            {data.tasks.length > 0 && (
              <div className="mb-2">
                <h6 className="mb-1 font-mono text-[11px] tracking-widest text-muted">TASKS({data.tasks.length})</h6>
                {data.tasks.map((t) => {
                  // 完成的任務不管日期多舊都不是逾期;標紅只會製造假警報。
                  const overdue = t.status !== "Done" && t.dueDate !== null && t.dueDate < today;
                  return (
                    <Link
                      key={t.id}
                      to={`/tasks/${t.id}`}
                      className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-accent-soft"
                    >
                      <Pill tone={priorityTone(t.priority)}>{t.priority}</Pill>
                      <span className="truncate underline underline-offset-2">{t.title}</span>
                      <span className={`ml-auto font-mono text-[11.5px] ${overdue ? "text-danger" : "text-muted"}`}>
                        {t.dueDate ?? t.owner ?? ""}
                      </span>
                    </Link>
                  );
                })}
              </div>
            )}
            {data.radar.length > 0 && (
              <div className="mb-2">
                <h6 className="mb-1 font-mono text-[11px] tracking-widest text-muted">RADAR({data.radar.length})</h6>
                {data.radar.map((r) => (
                  <Link
                    key={r.id}
                    to={`/radar/${r.id}`}
                    className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-accent-soft"
                  >
                    <Pill tone={priorityTone(r.severity)}>{r.severity}</Pill>
                    <span className="truncate underline underline-offset-2">{r.title}</span>
                    <span className="ml-auto font-mono text-[11.5px] text-muted">{r.status}</span>
                  </Link>
                ))}
              </div>
            )}
            {data.notes.length > 0 && (
              <div>
                <h6 className="mb-1 font-mono text-[11px] tracking-widest text-muted">NOTES({data.notes.length})</h6>
                {data.notes.map((n) => (
                  <Link
                    key={n.id}
                    to={`/notes/${n.id}`}
                    className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-accent-soft"
                  >
                    <Pill tone="mute">{n.type}</Pill>
                    {/* 沒有標題的 Scratch 要拿內文首行當名字,否則就是一列看不見的東西。 */}
                    <span className="truncate underline underline-offset-2">{noteLabel(n)}</span>
                    <span className="ml-auto font-mono text-[11.5px] text-muted">{n.date}</span>
                  </Link>
                ))}
              </div>
            )}
          </section>
          <section className="rounded-xl border border-line bg-surface p-3.5">
            <h5 className="mb-1 text-xs font-bold tracking-widest text-muted">歷史版本(body_md)</h5>
            {queryGuard(revs) ??
              (revs.data?.length ? (
                revs.data.map((r) => <RevisionRow key={r.id} r={r} onRestored={refetchAll} />)
              ) : (
                // 「尚無版本紀錄」是個結論;讀取失敗時說出這句話,等於謊報這個專案沒有歷史。
                <p className="text-[12.5px] text-muted">尚無版本紀錄。</p>
              ))}
          </section>
        </div>
      </div>
    </div>
  );
}

export function ProjectsPage() {
  const { id } = useParams();
  return id ? <Detail id={id} /> : <Cards />;
}
