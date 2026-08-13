import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { api, type Task, type Project } from "../api";
import { Pill, priorityTone } from "../ui/Pill";
import { queryGuard } from "../ui/QueryState";
import { PageHeader } from "../ui/PageHeader";
import { TaskDrawer } from "./TaskDrawer";

const COLUMNS = ["To-do", "In Progress", "Done", "Blocked"] as const;

/**
 * 拖曳結束後「要不要送 PATCH」的判斷 —— 抽成純函式,因為模擬一次真實拖曳的成本
 * 遠高於這段邏輯本身的風險(掉在空白處、掉回原欄、拖到一半資料被換掉)。
 * 回傳 null = 不動作。
 */
export function resolveMove(
  tasks: Task[],
  activeId: number,
  overId: string | undefined,
): { id: number; status: string } | null {
  if (!overId) return null;
  const current = tasks.find((t) => t.id === activeId);
  if (!current || current.status === overId) return null;
  return { id: activeId, status: overId };
}

function Card({ t, onOpen }: { t: Task; onOpen: () => void }) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({ id: t.id });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={onOpen}
      style={transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : undefined}
      className="mb-2 cursor-pointer rounded-lg border border-line bg-surface px-2.5 py-2 text-[13px] shadow-sm"
    >
      {t.title}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {t.origin === "ai" && <Pill tone="ai">AI</Pill>}
        <Pill tone={priorityTone(t.priority)}>{t.priority}</Pill>
        {/* owner 非空才顯示 —— 自己的任務(絕大多數)不該每張卡都掛一個空 pill 加噪。 */}
        {t.owner && <Pill tone="mute">{t.owner}</Pill>}
        {t.dueDate && <span className="font-mono text-[11px] text-muted">{t.dueDate}</span>}
      </div>
    </div>
  );
}

function Column({
  status,
  tasks,
  onOpen,
  onQuickAdd,
}: {
  status: (typeof COLUMNS)[number];
  tasks: Task[];
  onOpen: (t: Task) => void;
  onQuickAdd: (title: string) => Promise<unknown>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const [draft, setDraft] = useState("");
  // 失敗狀態留在欄位自己身上:四欄共用一個 mutation 的話,一欄送失敗會讓四欄同時喊失敗。
  const [failed, setFailed] = useState(false);
  return (
    <div ref={setNodeRef} className={`rounded-xl bg-sunk p-2.5 ${isOver ? "ring-2 ring-accent" : ""}`}>
      <h6 className="mb-2 flex text-[11.5px] font-bold tracking-widest text-muted">
        {status.toUpperCase()}
        <span className="ml-auto font-mono">{tasks.length}</span>
      </h6>
      {tasks.map((t) => (
        <Card key={t.id} t={t} onOpen={() => onOpen(t)} />
      ))}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const title = draft.trim();
          if (!title) return;
          // 清空只能發生在 POST 成功之後:先清再送,一次連線失敗就吞掉使用者剛打的標題。
          // 失敗分支要接住 —— mutateAsync 的 rejection 沒人接會變成 unhandled rejection
          // (錯誤狀態 react-query 已經記著了,這裡只需要「不要清空」)。
          void onQuickAdd(title).then(
            () => {
              setDraft("");
              setFailed(false);
            },
            // 草稿留著但畫面毫無反應,使用者只會以為 Enter 沒按到,再按一次 —— 然後又一次。
            () => setFailed(true),
          );
        }}
      >
        <input
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setFailed(false); // 打字就是重新開始一次,舊的失敗訊息不該還掛著
          }}
          aria-label={`在 ${status} 新增任務`}
          placeholder="＋ 輸入標題,Enter 即建…"
          className="w-full rounded-lg border border-dashed border-line bg-transparent px-2 py-1 text-xs"
        />
        {failed && <p role="alert" className="mt-1 text-[11.5px] text-danger">儲存失敗,內容已保留</p>}
      </form>
    </div>
  );
}

/** 表格檢視 = 看板的同一份資料換個排法(spec §5);不持久化,純本頁 state。 */
function TaskTable({
  tasks,
  projects,
  projectsReady,
  onOpen,
}: {
  tasks: Task[];
  projects: Project[];
  projectsReady: boolean;
  onOpen: (t: Task) => void;
}) {
  // 專案刪除不 cascade(spec):關聯照常顯示,查無的專案標示為「(已刪除專案)」——
  // projectId 還在,資訊沒遺失,只是要讓人看得出容器已經不在。
  // 但只有在專案清單真的回來之後才能這樣說:查詢還在飛的時候「查無」= 還沒查到,不是被刪了。
  const pname = (id: number | null) =>
    id === null || !projectsReady ? "" : (projects.find((p) => p.id === id)?.name ?? "(已刪除專案)");
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left text-[11.5px] tracking-widest text-muted">
            {["標題", "狀態", "優先級", "到期", "負責", "專案"].map((h) => (
              <th key={h} className="border-b border-line2 px-2.5 py-1.5">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <tr
              key={t.id}
              onClick={() => onOpen(t)}
              className="cursor-pointer border-b border-line hover:bg-surface2"
            >
              <td className="px-2.5 py-1.5">{t.title}</td>
              <td className="px-2.5 py-1.5">
                <Pill tone="mute">{t.status}</Pill>
              </td>
              <td className="px-2.5 py-1.5">
                <Pill tone={priorityTone(t.priority)}>{t.priority}</Pill>
              </td>
              <td className="px-2.5 py-1.5 font-mono text-[11.5px] text-muted">{t.dueDate ?? ""}</td>
              <td className="px-2.5 py-1.5 text-[12.5px]">{t.owner ?? ""}</td>
              <td className="px-2.5 py-1.5 font-mono text-[11.5px] text-muted">{pname(t.projectId)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TasksPage() {
  const qc = useQueryClient();
  const { id } = useParams();
  const nav = useNavigate();
  const [projectFilter, setProjectFilter] = useState("");
  const [view, setView] = useState<"board" | "table">("board");
  const tasks = useQuery({
    queryKey: ["tasks", projectFilter],
    queryFn: () => api.get<Task[]>("/tasks", projectFilter ? { projectId: projectFilter } : {}),
  });
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api.get<Project[]>("/projects") });
  // 選取即網址:深連結、搜尋命中、其他頁的反向連結才有地方可指。
  // 單筆自己查而不是從列表撈 —— 直開網址時列表可能還沒回來(或被篩選排除)。
  // retry: false —— 壞掉的深連結(已刪除/打錯的 id)是 404,重試三次只是把同一個答案再問三遍,
  // 代價是使用者盯著「載入中…」看好幾秒才等到「讀取失敗」。SourceNote 也是同一個理由。
  const selected = useQuery({
    queryKey: ["task", id],
    queryFn: () => api.get<Task>(`/tasks/${id}`),
    enabled: !!id,
    retry: false,
  });
  const openTask = (t: Task) => nav(`/tasks/${t.id}`);
  const closeDrawer = () => nav("/tasks");
  // 清單與單筆是兩個 key,而 prefix 比對是逐段精確的 —— ["tasks"] 掃不到 ["task", id]。
  // 只失效清單的話,看板會更新而點開的 drawer 還是舊值(表單只在掛載時初始化一次)。
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["tasks"] });
    qc.invalidateQueries({ queryKey: ["task"] });
  };
  const move = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) => api.patch(`/tasks/${id}`, { status }),
    onSuccess: invalidate,
  });
  const quickAdd = useMutation({
    mutationFn: (v: { title: string; status: string }) => api.post("/tasks", v),
    onSuccess: invalidate,
  });

  // 沒有 activationConstraint 的 PointerSensor 會在 pointerdown 當下就啟動拖曳,
  // 並在 document 的 capture 階段吃掉隨後的 click —— 卡片就再也點不開 drawer。
  // 給一個位移門檻,單純的點擊就不算拖曳。KeyboardSensor 要一起列回來:一旦手動指定 sensors,
  // dnd-kit 的預設組合就整個被取代,漏掉它等於卡片只剩滑鼠能拖(而卡片是 focusable 的)。
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  const onDragEnd = (e: DragEndEvent) => {
    const m = resolveMove(tasks.data ?? [], Number(e.active.id), e.over?.id as string | undefined);
    if (m) move.mutate(m);
  };

  return (
    <div className="grid gap-3.5">
      <PageHeader>
        <h3 className="text-base font-semibold">Tasks</h3>
        <select
          value={projectFilter}
          onChange={(e) => setProjectFilter(e.target.value)}
          className="rounded-lg border border-line bg-surface px-2 py-1 text-xs"
          aria-label="專案篩選"
        >
          <option value="">專案:全部</option>
          {projects.data?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="ml-auto flex gap-1.5">
          {(["board", "table"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={`rounded-full px-2.5 text-[11.5px] font-semibold leading-relaxed ${
                view === v ? "bg-accent-soft text-accent" : "bg-surface2 text-muted"
              }`}
            >
              {v === "board" ? "看板" : "表格"}
            </button>
          ))}
        </div>
      </PageHeader>
      {/* 讀不到任務時,四個空欄位看起來就是「你今天沒事做」—— 那是資料層的沉默被當成了答案。 */}
      {queryGuard(tasks) ??
        (view === "board" ? (
          <DndContext sensors={sensors} onDragEnd={onDragEnd}>
            <div className="grid grid-cols-4 gap-2.5 max-lg:grid-cols-2">
              {COLUMNS.map((c) => (
                <Column
                  key={c}
                  status={c}
                  tasks={(tasks.data ?? []).filter((t) => t.status === c)}
                  onOpen={openTask}
                  onQuickAdd={(title) => quickAdd.mutateAsync({ title, status: c })}
                />
              ))}
            </div>
          </DndContext>
        ) : (
          <TaskTable
            tasks={tasks.data ?? []}
            projects={projects.data ?? []}
            projectsReady={projects.isSuccess}
            onOpen={openTask}
          />
        ))}
      {/* 網址裡有 id 卻讀不到時不能沉默 —— NOT_FOUND 與連線失敗都要說出來,
          否則深連結進來只會看到一片沒有 drawer 的看板,像是連結壞了。 */}
      {id && queryGuard(selected)}
      <TaskDrawer
        key={selected.data?.id ?? "none"}
        task={selected.data ?? null}
        onClose={closeDrawer}
      />
    </div>
  );
}
