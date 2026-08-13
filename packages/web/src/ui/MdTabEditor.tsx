import { useId, useState } from "react";
import { Markdown } from "./Markdown";

/** Drawer 內的 body 編輯:tab 切換,有內容預設預覽、空白預設編輯(spec §5)。切 tab 不儲存。 */
export function MdTabEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [tab, setTab] = useState<"edit" | "preview">(value.trim() ? "preview" : "edit");
  // 綁 label:drawer 裡通常還有別的 textbox,呼叫端要能用 getByLabelText("內文") 指到這一個。
  const textareaId = useId();
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <label htmlFor={textareaId} className="font-mono text-[11.5px] text-muted">
          內文
        </label>
        <span className="ml-auto" />
        {(["edit", "preview"] as const).map((t) => (
          <button
            key={t}
            type="button"
            aria-pressed={tab === t}
            onClick={() => setTab(t)}
            className={`rounded-full px-2 text-[10.5px] font-semibold ${
              tab === t ? "bg-accent-soft text-accent" : "bg-surface2 text-muted"
            }`}
          >
            {t === "edit" ? "編輯" : "預覽"}
          </button>
        ))}
      </div>
      {tab === "edit" ? (
        <textarea
          id={textareaId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={6}
          className="w-full rounded-lg border border-line bg-sunk p-2.5 font-mono text-xs leading-relaxed"
        />
      ) : (
        <div className="rounded-lg border border-line p-2.5 text-[13px]">
          <Markdown source={value || "*（空白）*"} />
        </div>
      )}
    </div>
  );
}
