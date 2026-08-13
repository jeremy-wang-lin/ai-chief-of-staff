import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * AppShell 的 topbar 左側插槽。頁面用 <PageHeader> 把自己的標題列(h3、篩選、
 * 動作按鈕)投影進去,和右側固定的搜尋框排成同一列(mockup 的 .topbar 規格)。
 */
export const TopbarSlotContext = createContext<HTMLElement | null>(null);

export function PageHeader({ children }: { children: ReactNode }) {
  const slot = useContext(TopbarSlotContext);
  // 沒有插槽(頁面在測試中單獨渲染、或未包在 AppShell 下)就原地渲染,標題不能消失。
  if (!slot) return <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>;
  return createPortal(children, slot);
}
