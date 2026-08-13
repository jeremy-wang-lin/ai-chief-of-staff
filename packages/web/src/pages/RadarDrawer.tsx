import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Radar, type Project } from "../api";
import { Drawer } from "../ui/Drawer";
import { MdTabEditor } from "../ui/MdTabEditor";
import { SelectField, TextField } from "../ui/fields";
import { SourceNote } from "../ui/SourceNote";

const SEVERITIES = ["P0", "P1", "P2", "P3"] as const;
const STATUSES = ["Open", "In Progress", "Resolved"] as const;

/** item === null 即關閉;"new" 為新增。呼叫端以 key 綁 id,換一筆就整個重掛(表單狀態只在掛載時初始化)。 */
export function RadarDrawer({ item, onClose }: { item: Radar | "new" | null; onClose: () => void }) {
  const qc = useQueryClient();
  const isNew = item === "new";
  const base = isNew || !item ? null : item;
  const [form, setForm] = useState({
    title: base?.title ?? "",
    severity: (base?.severity ?? "P2") as string,
    status: (base?.status ?? "Open") as string,
    projectId: base?.projectId ? String(base.projectId) : "",
    source: base?.source ?? "",
    owner: base?.owner ?? "",
    bodyMd: base?.bodyMd ?? "",
  });
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api.get<Project[]>("/projects") });
  // 清單與單筆是兩個 key,而 prefix 比對是逐段精確的 —— ["radar"] 掃不到 ["radar-item", id]。
  // 兩個都要失效,否則再次點開這筆會拿到存檔前的快取(表單只在掛載時初始化一次)。
  // 順序也是有意義的:失效必須發生在 onClose(關閉/導航)之前 —— 此刻單筆查詢的 observer 還掛著,
  // 失效才會真的觸發重取;先關再失效的話沒有 observer,重取不會發生,快取就一直停在存檔前的值。
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["radar"] });
    qc.invalidateQueries({ queryKey: ["radar-item"] });
    onClose();
  };
  // 空值送 null 而不是省略:這三欄在 write/update.radar 都是 nullable,null 的意思正是
  // 「清成 NULL」。省略等於「別動它」,清空就會在重整後又冒回來;送 "" 則是把空字串當值存起來。
  const payload = () => ({
    title: form.title,
    severity: form.severity,
    status: form.status,
    projectId: form.projectId ? Number(form.projectId) : null,
    source: form.source || null,
    owner: form.owner || null,
    bodyMd: form.bodyMd || null,
  });
  const create = useMutation({ mutationFn: () => api.post("/radar", payload()), onSuccess: invalidate });
  const save = useMutation({ mutationFn: () => api.patch(`/radar/${base!.id}`, payload()), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: () => api.del(`/radar/${base!.id}`), onSuccess: invalidate });

  if (!item) return null;
  const set = (k: keyof typeof form) => (v: string) => setForm({ ...form, [k]: v });

  // 寫入失敗必須說出來:成功才關 drawer,所以失敗時內容還在畫面上 ——
  // 但沒有這一行的話什麼都不會變,看起來就像按鈕沒反應。
  const failure = create.error ?? save.error ?? remove.error;
  const failureLabel = create.error ? "建立失敗" : save.error ? "儲存失敗" : "刪除失敗";

  return (
    <Drawer open title={isNew ? "新增雷達項目" : "編輯雷達項目"} onClose={onClose}>
      <TextField
        label="標題"
        value={form.title}
        onChange={set("title")}
        placeholder="一句話描述這個風險/觀察…"
      />
      <div className="grid grid-cols-2 gap-2">
        <SelectField label="Severity" value={form.severity} options={SEVERITIES} onChange={set("severity")} />
        <SelectField label="狀態" value={form.status} options={STATUSES} onChange={set("status")} />
      </div>
      <TextField label="負責人" value={form.owner} onChange={set("owner")} placeholder="留空 = 自己" />
      {/* 專案下拉不走 SelectField:那個元件的 option 文字等於值,這裡值是 id、要顯示的是專案名。 */}
      <label className="grid gap-1 text-sm">
        <span className="font-mono text-[11.5px] text-muted">專案</span>
        <select
          value={form.projectId}
          onChange={(e) => set("projectId")(e.target.value)}
          className="rounded-lg border border-line bg-surface px-2 py-1.5"
        >
          <option value="">無專案</option>
          {projects.data?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <TextField label="來源(自由文字,可引 Jira ID)" value={form.source} onChange={set("source")} />
      {/* 只有既有項目才有來源筆記可連;新增時 base 為 null,noteId 由後端在筆記升級時寫入。 */}
      {base?.noteId != null && <SourceNote noteId={base.noteId} />}
      <MdTabEditor value={form.bodyMd} onChange={set("bodyMd")} />
      {failure && (
        <p role="alert" className="rounded-lg bg-danger-soft px-2.5 py-1.5 text-[12.5px] text-danger">
          {failureLabel}:{failure.message}
        </p>
      )}
      <div className="flex gap-2">
        {isNew ? (
          // 標題是 write.radar 唯一的必填(z.string().min(1))。空標題按下去只會換來一個
          // 目前沒人顯示的 400 —— 在按鈕上先擋住,比讓它看起來沒反應誠實。
          <button
            type="button"
            disabled={!form.title.trim()}
            onClick={() => create.mutate()}
            className="rounded-lg bg-accent px-3.5 py-1 text-xs font-semibold text-white disabled:opacity-40"
          >
            建立
          </button>
        ) : (
          <>
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
          </>
        )}
      </div>
    </Drawer>
  );
}
