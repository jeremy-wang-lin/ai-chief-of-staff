import { describe, it, expect, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders } from "./helpers";
import { AppShell } from "../src/App";
import { PageHeader } from "../src/ui/PageHeader";

/** 掛在 AppShell 的 Outlet 底下渲染,模擬真實 router 結構。 */
function renderInShell(child: React.ReactNode, onSearchOpen?: () => void) {
  return renderWithProviders(
    <Routes>
      <Route element={<AppShell onSearchOpen={onSearchOpen} />}>
        <Route index element={child} />
      </Route>
    </Routes>,
  );
}

describe("shared topbar", () => {
  it("renders the search trigger in the topbar, not in the sidebar", () => {
    renderInShell(<p>內文</p>);
    const search = screen.getByRole("button", { name: /搜尋/ });
    // mockup 規格:搜尋框在內容區 topbar 靠右,不在左側 sidebar
    expect(search.closest("header")).not.toBeNull();
    expect(within(screen.getByRole("complementary")).queryByRole("button", { name: /搜尋/ })).toBeNull();
  });

  it("opens search from the topbar trigger", async () => {
    const onSearchOpen = vi.fn();
    renderInShell(<p>內文</p>, onSearchOpen);
    await userEvent.click(screen.getByRole("button", { name: /搜尋/ }));
    expect(onSearchOpen).toHaveBeenCalledTimes(1);
  });

  it("portals PageHeader content into the topbar, leaving page body in place", () => {
    renderInShell(
      <div>
        <PageHeader>
          <h3>測試標題</h3>
        </PageHeader>
        <p>內文段落</p>
      </div>,
    );
    // 標題被投影進 topbar(<header>),內文留在原地(<main> 的內容流)
    expect(screen.getByRole("heading", { name: "測試標題" }).closest("header")).not.toBeNull();
    expect(screen.getByText("內文段落").closest("header")).toBeNull();
  });

  it("renders PageHeader children inline when no topbar slot exists", () => {
    // 頁面元件在測試中單獨渲染(不含 AppShell)時,標題仍要看得到
    renderWithProviders(
      <PageHeader>
        <h3>獨立標題</h3>
      </PageHeader>,
    );
    expect(screen.getByRole("heading", { name: "獨立標題" })).toBeInTheDocument();
  });
});
