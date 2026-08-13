import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Task, type Project } from "../api";
import { Drawer } from "../ui/Drawer";
import { MdTabEditor } from "../ui/MdTabEditor";
import { SelectField, TextField, DateField } from "../ui/fields";
import { SourceNote } from "../ui/SourceNote";

const STATUSES = ["To-do", "In Progress", "Done", "Blocked"] as const;
const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;

/** task === null 即關閉。呼叫端以 key 綁 task.id,換一筆就整個重掛(表單狀態只在掛載時初始化)。 */
export function TaskDrawer({ task, onClose }: { task: Task | null; onClose: () => void }) {
  const qc = useQueryClient();
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api.get<Project[]>("/projects") });
  // 清單與單筆是兩個 key,而 prefix 比對是逐段精確的 —— ["tasks"] 掃不到 ["task", id]。
  // 兩個都要失效,否則再次點開這筆會拿到存檔前的快取(表單只在掛載時初始化一次)。
  // 順序也是有意義的:失效必須發生在關閉/導航之前 —— 此刻單筆查詢的 observer 還掛著,
  // 失效才會真的觸發重取;先關再失效的話沒有 observer,重取不會發生,快取就一直停在存檔前的值。
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["tasks"] });
    qc.invalidateQueries({ queryKey: ["task"] });
  };
  const [form, setForm] = useState(() =>
    task
      ? {
          title: task.title,
          status: task.status as string,
          priority: task.priority as string,
          dueDate: task.dueDate ?? "",
          owner: task.owner ?? "",
          projectId: task.projectId ? String(task.projectId) : "",
          bodyMd: task.bodyMd ?? "",
        }
      : null,
  );
  const save = useMutation({
    // 清空的欄位送 null,不是省略:這幾欄在 update.task 都是 nullable,null 的意思正是
    // 「清成 NULL」。省略等於「別動它」—— 那會讓畫面上清掉的值在重整後又冒回來。
    // 送 "" 也不行:那是把空字串當成值存進去,查詢時它既不是空也不是有值。
    mutationFn: () =>
      api.patch(`/tasks/${task!.id}`, {
        title: form!.title,
        status: form!.status,
        priority: form!.priority,
        dueDate: form!.dueDate || null,
        owner: form!.owner || null,
        projectId: form!.projectId ? Number(form!.projectId) : null,
        bodyMd: form!.bodyMd || null,
      }),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/tasks/${task!.id}`),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });

  if (!task || !form) return null;
  const set = (k: keyof NonNullable<typeof form>) => (v: string) => setForm({ ...form, [k]: v });

  // 寫入失敗必須說出來:onSuccess 才關 drawer,所以失敗時 drawer 還開著、內容還在 ——
  // 但沒有這一行的話畫面上什麼都不會變,看起來就像按鈕壞了。
  const failure = save.error ?? remove.error;

  return (
    <Drawer open title="編輯任務" onClose={onClose}>
      <TextField label="標題" value={form.title} onChange={set("title")} />
      <div className="grid grid-cols-2 gap-2">
        <SelectField label="狀態" value={form.status} options={STATUSES} onChange={set("status")} />
        <SelectField label="優先級" value={form.priority} options={PRIORITIES} onChange={set("priority")} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <DateField label="到期日" value={form.dueDate} onChange={set("dueDate")} />
        <TextField label="負責人" value={form.owner} onChange={set("owner")} placeholder="留空 = 自己" />
      </div>
      {/* 專案下拉不走 SelectField:那個元件的 option 文字等於值,這裡值是 id、要顯示的是專案名。 */}
      <label className="grid gap-1 text-sm">
        <span className="font-mono text-[11.5px] text-muted">專案</span>
        <select
          value={form.projectId}
          onChange={(e) => set("projectId")(e.target.value)}
          className="rounded-lg border border-line bg-surface px-2 py-1.5"
        >
          <option value="">（無專案）</option>
          {projects.data?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {task.noteId != null && <SourceNote noteId={task.noteId} />}
      <MdTabEditor value={form.bodyMd} onChange={set("bodyMd")} />
      {failure && (
        <p role="alert" className="rounded-lg bg-danger-soft px-2.5 py-1.5 text-[12.5px] text-danger">
          {save.error ? "儲存失敗" : "刪除失敗"}:{failure.message}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => save.mutate()}
          className="rounded-lg bg-accent px-3.5 py-1 text-xs font-semibold text-white"
        >
          儲存
        </button>
        <button
          type="button"
          onClick={() => remove.mutate()}
          className="rounded-lg border border-danger px-3.5 py-1 text-xs font-semibold text-danger"
        >
          刪除
        </button>
      </div>
    </Drawer>
  );
}
