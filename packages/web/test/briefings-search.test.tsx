import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router-dom";
import { renderWithProviders } from "./helpers";

vi.mock("../src/api", async (orig) => {
  const mod = (await orig()) as object;
  return { ...mod, api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
import { api } from "../src/api";
import { BriefingsPage } from "../src/pages/Briefings";
import { SearchOverlay, sanitizeSnippet, hitPath } from "../src/SearchOverlay";
import { AppRoot } from "../src/App";

const NOTE_HIT = {
  table: "notes",
  rowId: 2,
  title: "隨手記",
  snippet: "log <mark>retention</mark> 太長",
  isRevision: false,
};
// 刻意挑非 projects 的表:命中若本來就是 projects,把 isRevision 分支刪掉也會落在
// /projects/5,「歷史版本一律導回專案列表」這條規則就等於沒被測到。
const REVISION_HIT = {
  table: "tasks",
  rowId: 9,
  title: "tasks.body_md",
  snippet: "<mark>retention</mark> 舊版",
  isRevision: true,
  revisionCreatedAt: "2026-07-24T10:00:00",
};

beforeEach(() => {
  // 呼叫紀錄由 vite.config.ts 的 clearMocks 清掉;「打了幾次 /search」問的正是次數。
  vi.mocked(api.get).mockImplementation(async (path: string, params?: Record<string, unknown>) => {
    if (path === "/briefings")
      return [
        { id: 1, kind: params?.kind ?? "daily", date: "2026-08-01", summary: "摘要", bodyMd: "## 內容" },
      ];
    if (path === "/search") return params?.includeRevisions ? [REVISION_HIT] : [NOTE_HIT];
    return [];
  });
});

/** debounce 是 300ms:等得比它久才能斷言「這段時間內半個請求都沒發」。 */
const settle = () => new Promise((r) => setTimeout(r, 400));
const searchCalls = () => vi.mocked(api.get).mock.calls.filter(([p]) => p === "/search");

function LocationProbe() {
  return <span data-testid="loc">{useLocation().pathname}</span>;
}

/** overlay 自己不帶路由,但點結果會導頁 —— 探針把導到哪讀出來。 */
function renderOverlay(onClose = () => {}) {
  return renderWithProviders(
    <>
      <SearchOverlay open onClose={onClose} />
      <LocationProbe />
    </>,
  );
}

describe("Briefings", () => {
  it("lists briefings and opens body", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BriefingsPage />);
    await user.click(await screen.findByText(/2026-08-01/));
    expect(screen.getByRole("heading", { name: "內容" })).toBeInTheDocument();
  });

  it("asks the server for the selected kind and closes the open body when switching", async () => {
    // kind 沒帶到後端就會回 daily,週報 tab 會靜靜地顯示日報。
    const user = userEvent.setup();
    renderWithProviders(<BriefingsPage />);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/briefings", { kind: "daily" }));
    await user.click(await screen.findByText(/2026-08-01/));
    expect(screen.getByRole("heading", { name: "內容" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "weekly" }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/briefings", { kind: "weekly" }));
    // 換 tab 沒清掉展開中的那篇,畫面會停在另一種 kind 的內文上。
    await waitFor(() => expect(screen.queryByRole("heading", { name: "內容" })).not.toBeInTheDocument());
  });

  it("keeps the server's date-desc order", async () => {
    vi.mocked(api.get).mockResolvedValue([
      { id: 2, kind: "daily", date: "2026-08-02", summary: "新", bodyMd: "# 新" },
      { id: 1, kind: "daily", date: "2026-08-01", summary: "舊", bodyMd: "# 舊" },
    ]);
    renderWithProviders(<BriefingsPage />);
    await screen.findByText(/2026-08-02/);
    const dates = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    expect(dates.filter((t) => t.includes("2026-08"))).toEqual([
      expect.stringContaining("2026-08-02"),
      expect.stringContaining("2026-08-01"),
    ]);
  });

  it("says the list is empty instead of rendering nothing", async () => {
    vi.mocked(api.get).mockResolvedValue([]);
    renderWithProviders(<BriefingsPage />);
    expect(await screen.findByText(/尚無 daily briefing/)).toBeInTheDocument();
  });
});

describe("sanitizeSnippet", () => {
  it("keeps mark and strips everything else", () => {
    expect(sanitizeSnippet("a <mark>b</mark> c")).toBe("a <mark>b</mark> c");
    expect(sanitizeSnippet('<img src=x onerror=alert(1)>hit')).toBe("hit");
    expect(sanitizeSnippet("<script>alert(1)</script>x")).toBe("alert(1)x");
    expect(sanitizeSnippet('<mark class="x">b</mark>')).toBe("b</mark>");
  });
});

describe("hitPath", () => {
  it("deep-links tasks and radar hits to their detail routes", () => {
    expect(hitPath({ table: "tasks", rowId: 12 } as never)).toBe("/tasks/12");
    expect(hitPath({ table: "radar", rowId: 3 } as never)).toBe("/radar/3");
  });
});

describe("SearchOverlay", () => {
  it("searches after typing; toggle adds revisions", async () => {
    const user = userEvent.setup();
    const { container } = renderOverlay();
    await user.type(screen.getByPlaceholderText(/搜尋/), "retention");
    await waitFor(() => expect(screen.getByText("隨手記")).toBeInTheDocument());
    expect(screen.getByText(/retention/)).toBeInTheDocument(); // snippet 渲染
    // snippet 必須真的當成 HTML 注入:純文字渲染下 getByText 一樣會過,但高亮就沒了。
    expect(container.querySelector("mark")).toHaveTextContent("retention");
    await user.click(screen.getByRole("checkbox", { name: /包含歷史版本/ }));
    await waitFor(() => expect(screen.getByText(/2026-07-24/)).toBeInTheDocument());
  });

  it("leaves the revision toggle off by default", async () => {
    const user = userEvent.setup();
    renderOverlay();
    await user.type(screen.getByPlaceholderText(/搜尋/), "retention");
    await screen.findByText("隨手記");
    expect(screen.getByRole("checkbox", { name: /包含歷史版本/ })).not.toBeChecked();
    // 預設就帶歷史版本會讓一般搜尋被舊版洗版。
    expect(searchCalls()[0]?.[1]).toEqual({ q: "retention" });
  });

  it("debounces typing into a single request", async () => {
    const user = userEvent.setup();
    renderOverlay();
    await user.type(screen.getByPlaceholderText(/搜尋/), "retention");
    await screen.findByText("隨手記");
    // 沒 debounce 的話每個按鍵都是一次全文檢索。
    expect(searchCalls()).toHaveLength(1);
  });

  it("never queries on a blank query", async () => {
    const user = userEvent.setup();
    renderOverlay();
    await user.type(screen.getByPlaceholderText(/搜尋/), "   ");
    await settle();
    expect(searchCalls()).toHaveLength(0);
  });

  it("navigates to the hit's own page and closes", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderOverlay(onClose);
    await user.type(screen.getByPlaceholderText(/搜尋/), "retention");
    await user.click(await screen.findByText("隨手記"));
    expect(screen.getByTestId("loc")).toHaveTextContent("/notes/2");
    expect(onClose).toHaveBeenCalled();
  });

  it("marks a revision hit with the ai-toned pill and sends it to /projects", async () => {
    const user = userEvent.setup();
    renderOverlay();
    await user.type(screen.getByPlaceholderText(/搜尋/), "retention");
    await user.click(screen.getByRole("checkbox", { name: /包含歷史版本/ }));
    const pill = await screen.findByText("Revision");
    expect(pill).toHaveClass("bg-ai-soft", "text-ai");
    expect(screen.getByText(/2026-07-24/)).toBeInTheDocument();
    await user.click(screen.getByText("tasks.body_md"));
    // 歷史版本沒有自己的頁面 —— MVP 導回專案列表,不會導到一個不存在的深連結。
    // 正規表達式錨定:toHaveTextContent("/projects") 是子字串比對,/projects/5 也會過。
    expect(screen.getByTestId("loc")).toHaveTextContent(/^\/projects$/);
  });

  it("sanitizes snippet html except mark", async () => {
    vi.mocked(api.get).mockResolvedValueOnce([
      {
        table: "notes",
        rowId: 1,
        title: "x",
        snippet: "<img src=x onerror=alert(1)><mark>hit</mark>",
        isRevision: false,
      },
    ]);
    const user = userEvent.setup();
    renderOverlay();
    await user.type(screen.getByPlaceholderText(/搜尋/), "hit");
    await waitFor(() => expect(screen.getByText("hit")).toBeInTheDocument());
    expect(document.querySelector("img")).toBeNull();
  });

  it("says so when nothing matched", async () => {
    vi.mocked(api.get).mockResolvedValue([]);
    const user = userEvent.setup();
    renderOverlay();
    await user.type(screen.getByPlaceholderText(/搜尋/), "zzz");
    expect(await screen.findByText("沒有結果。")).toBeInTheDocument();
  });

  it("closes on Escape and on a backdrop click, but not on a click inside", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    const { container } = renderOverlay(onClose);
    await user.click(screen.getByPlaceholderText(/搜尋/));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(container.firstElementChild as Element);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("renders nothing while closed and stops listening for Escape", () => {
    const onClose = vi.fn();
    renderWithProviders(<SearchOverlay open={false} onClose={onClose} />);
    expect(screen.queryByPlaceholderText(/搜尋/)).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("AppRoot", () => {
  it("opens the overlay on cmd-k and ctrl-k, and closes it on Escape", async () => {
    renderWithProviders(<AppRoot />);
    expect(screen.queryByPlaceholderText(/搜尋所有內容/)).not.toBeInTheDocument();
    // 瀏覽器自己的 ⌘K(Chrome = 網址列搜尋)得擋下來,否則焦點會被搶走。
    expect(fireEvent.keyDown(window, { key: "k", metaKey: true })).toBe(false);
    expect(await screen.findByPlaceholderText(/搜尋所有內容/)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByPlaceholderText(/搜尋所有內容/)).not.toBeInTheDocument());
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(await screen.findByPlaceholderText(/搜尋所有內容/)).toBeInTheDocument();
  });

  it("opens the same overlay from the sidebar search button", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AppRoot />);
    await user.click(screen.getByRole("button", { name: /搜尋 ⌘K/ }));
    expect(await screen.findByPlaceholderText(/搜尋所有內容/)).toBeInTheDocument();
  });

  it("ignores a bare k so typing is not hijacked", async () => {
    renderWithProviders(<AppRoot />);
    fireEvent.keyDown(window, { key: "k" });
    await settle();
    expect(screen.queryByPlaceholderText(/搜尋所有內容/)).not.toBeInTheDocument();
  });
});
