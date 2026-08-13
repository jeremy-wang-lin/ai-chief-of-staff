import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "./helpers";
import { AppShell } from "../src/App";

describe("app shell", () => {
  it("renders sidebar nav entries", () => {
    renderWithProviders(<AppShell />);
    for (const label of ["Home", "Tasks", "Notes", "Radar", "Projects", "Briefings"]) {
      expect(screen.getByRole("link", { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  it("marks the nav entry matching the current route as active", () => {
    renderWithProviders(<AppShell />, { route: "/tasks" });
    expect(screen.getByRole("link", { name: /Tasks/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: /Home/ })).not.toHaveAttribute("aria-current");
  });

  it("styles the active nav entry with the accent token", () => {
    // aria-current 是 react-router 自己加的,拔掉 className callback 也不會紅;
    // 要真的守住樣式就得斷言 class 本身。
    renderWithProviders(<AppShell />, { route: "/tasks" });
    const tasks = screen.getByRole("link", { name: /Tasks/ });
    expect(tasks).toHaveClass("text-accent", "bg-accent-soft", "font-semibold");
    const home = screen.getByRole("link", { name: /Home/ });
    expect(home).not.toHaveClass("text-accent");
    expect(home).toHaveClass("text-muted");
  });

  it("calls onSearchOpen when the search button is clicked", async () => {
    const onSearchOpen = vi.fn();
    renderWithProviders(<AppShell onSearchOpen={onSearchOpen} />);
    await userEvent.click(screen.getByRole("button", { name: /搜尋/ }));
    expect(onSearchOpen).toHaveBeenCalledTimes(1);
  });

  it("tolerates a click when no onSearchOpen prop is given", async () => {
    renderWithProviders(<AppShell />);
    await expect(userEvent.click(screen.getByRole("button", { name: /搜尋/ }))).resolves.not.toThrow();
  });
});
