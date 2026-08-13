import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { SearchOverlay } from "./SearchOverlay";
import { TopbarSlotContext } from "./ui/PageHeader";

const NAV = [
  { to: "/", label: "⌂ Home", end: true },
  { to: "/tasks", label: "☐ Tasks" },
  { to: "/notes", label: "✎ Notes" },
  { to: "/radar", label: "◎ Radar" },
  { to: "/projects", label: "▤ Projects" },
  { to: "/briefings", label: "✦ Briefings" },
];

// ⌘K 的全域 keydown listener 由 Task 11 的 AppRoot 負責掛;shell 只提供按鈕與 callback。
// 兩邊都掛會讓同一個快捷鍵註冊兩次。
export function AppShell({ onSearchOpen }: { onSearchOpen?: () => void } = {}) {
  // ref callback 進 state:portal 目標要等 DOM 存在才成立,PageHeader 拿到 null 時先原地渲染。
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <div className="grid min-h-screen grid-cols-[176px_1fr]">
      <aside className="flex flex-col gap-0.5 border-r border-line bg-surface2 p-3">
        <div className="px-2 pb-3 text-sm font-bold">
          LCOS
          <span className="block text-[11px] font-medium tracking-widest text-muted">CHIEF OF STAFF</span>
        </div>
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) =>
              `rounded-lg px-2.5 py-1.5 text-sm ${
                isActive ? "bg-accent-soft font-semibold text-accent" : "text-muted hover:bg-surface"
              }`
            }
          >
            {n.label}
          </NavLink>
        ))}
      </aside>
      <main className="min-w-0 bg-bg p-5">
        <header className="mb-3.5 flex items-center gap-3">
          <div ref={setSlot} className="flex min-w-0 flex-1 flex-wrap items-center gap-2" />
          <button
            type="button"
            onClick={onSearchOpen}
            className="flex w-[260px] shrink-0 items-center gap-2 rounded-lg border border-line bg-surface2 px-3 py-1.5 text-left text-[13px] text-muted max-lg:w-auto"
          >
            <span aria-hidden>🔍</span>
            <span className="max-lg:hidden">搜尋所有內容…</span>
            <span className="sr-only">搜尋</span>
            <kbd className="ml-auto rounded border border-line2 px-1 font-mono text-[11px] max-lg:ml-0">⌘K</kbd>
          </button>
        </header>
        <TopbarSlotContext.Provider value={slot}>
          <Outlet />
        </TopbarSlotContext.Provider>
      </main>
    </div>
  );
}

/**
 * 版面的最外層:全域 ⌘K 只在這裡註冊一次,側邊欄按鈕與快捷鍵開的是同一個 overlay。
 * 必須留在 router 的 element 樹裡 —— SearchOverlay 點結果要導頁,沒有 router context 會爆。
 */
export function AppRoot() {
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        // 不擋的話 Chrome 的 ⌘K 會把焦點搶去網址列。
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  return (
    <>
      <SearchOverlay open={searchOpen} onClose={() => setSearchOpen(false)} />
      <AppShell onSearchOpen={() => setSearchOpen(true)} />
    </>
  );
}
