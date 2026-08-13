import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";

/**
 * 右側滑出面板:Esc 或點 backdrop 關閉。關著時不掛 keydown,免得看不見的面板吃掉 Esc。
 * 開啟時把焦點搬進面板、關閉時還給原本的元素 —— aria-modal 對輔助技術的承諾是「焦點在這裡面」,不搬就是騙人。
 * 刻意不做 focus trap:面板內容由呼叫端決定,硬圈住 Tab 超出這層元件該管的範圍(Esc 隨時可離開)。
 */
export function Drawer({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
  useEffect(() => {
    if (!open) return;
    // 存的是開啟前的焦點,關閉(或整個 unmount)時還回去,使用者才不會被丟回頁面頂端。
    const restoreTo = document.activeElement;
    panelRef.current?.focus();
    return () => {
      if (restoreTo instanceof HTMLElement && restoreTo.isConnected) restoreTo.focus();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40">
      <div data-testid="drawer-backdrop" className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="absolute right-0 top-0 h-full w-[420px] overflow-y-auto border-l border-line2 bg-surface shadow-xl outline-none"
      >
        <div className="flex items-center gap-2 border-b border-line bg-surface2 px-4 py-2">
          <h2 id={titleId} className="text-xs font-bold tracking-widest text-muted">
            {title}
          </h2>
          <button type="button" aria-label="關閉" onClick={onClose} className="ml-auto text-xs text-muted">
            ✕
          </button>
        </div>
        <div className="grid gap-2.5 p-4 text-sm">{children}</div>
      </div>
    </div>
  );
}
