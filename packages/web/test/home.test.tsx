import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "./helpers";

vi.mock("../src/api", async (orig) => {
  const mod = await orig() as object;
  return { ...mod, api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
import { api } from "../src/api";
import { HomePage } from "../src/pages/Home";

const SNAP = {
  today: "2026-08-02",
  dueToday: [{ id: 1, title: "due-task", priority: "P2", status: "To-do", dueDate: "2026-08-02", origin: "human" }],
  overdue: [{ id: 2, title: "late-task", priority: "P1", status: "To-do", dueDate: "2026-08-01", origin: "ai" }],
  completedYesterday: [], unprocessedNotes: [], openRadar: [],
  latestBriefing: { kind: "daily", date: "2026-07-31" },
};

const DAILY = [{ id: 9, kind: "daily", date: "2026-07-31", summary: "s", bodyMd: "## 昨日回顧" }];

/** 兩支查詢的回應都可個別覆寫 —— staleness 正不正確,正是取決於這兩者可以不一致。 */
function mockApi({ snap = SNAP, briefings = DAILY }: { snap?: unknown; briefings?: unknown } = {}) {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === "/snapshot") return snap;
    if (path === "/briefings") return briefings;
    return [];
  });
}

beforeEach(() => {
  // 呼叫紀錄由 vite.config.ts 的 clearMocks 在每個 test 前清掉(實作留著),這裡只裝實作。
  mockApi();
  vi.mocked(api.post).mockResolvedValue({ id: 3 });
});

describe("Home", () => {
  it("shows staleness warning when briefing is older than today", async () => {
    renderWithProviders(<HomePage />);
    await waitFor(() => expect(screen.getByText(/最新 daily briefing/)).toBeInTheDocument());
    expect(screen.getByText(/2026-07-31/)).toBeInTheDocument();
  });

  it("warns when only a weekly briefing ran today and daily is still behind", async () => {
    // snapshot.latestBriefing 不分 kind:剛跑過 /weekly 時它的 date 就是今天,
    // 拿它判 staleness 會把「今天還沒跑 /daily」的警示整個蓋掉。
    mockApi({
      snap: { ...SNAP, latestBriefing: { kind: "weekly", date: "2026-08-02" } },
      briefings: [{ id: 8, kind: "daily", date: "2026-07-30", summary: "s", bodyMd: "## 昨日回顧" }],
    });
    renderWithProviders(<HomePage />);
    await waitFor(() => expect(screen.getByText(/最新 daily briefing/)).toBeInTheDocument());
    // 警示上的日期同樣得來自 daily 查詢,不能是 weekly 的今天。
    expect(screen.getByText(/2026-07-30/)).toBeInTheDocument();
  });

  it("hides the staleness warning once today's daily briefing exists", async () => {
    mockApi({
      snap: { ...SNAP, latestBriefing: { kind: "daily", date: "2026-08-02" } },
      briefings: [{ id: 7, kind: "daily", date: "2026-08-02", summary: "s", bodyMd: "## 昨日回顧" }],
    });
    renderWithProviders(<HomePage />);
    await screen.findByRole("heading", { name: "昨日回顧" });
    expect(screen.queryByText(/最新 daily briefing/)).toBeNull();
  });

  it("renders briefing body and today tasks with overdue styling", async () => {
    renderWithProviders(<HomePage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "昨日回顧" })).toBeInTheDocument());
    expect(screen.getByText("due-task")).toBeInTheDocument();
    expect(screen.getByText("late-task")).toBeInTheDocument();
    expect(screen.getByText(/過期/)).toBeInTheDocument();
  });

  it("lists overdue tasks above tasks due today and marks ai origin", async () => {
    const { container } = renderWithProviders(<HomePage />);
    await screen.findByText("late-task");
    const text = container.textContent ?? "";
    expect(text.indexOf("late-task")).toBeLessThan(text.indexOf("due-task"));
    const aiRow = screen.getByText("late-task").closest("div")!;
    expect(within(aiRow).getByText("AI")).toBeInTheDocument();
    const humanRow = screen.getByText("due-task").closest("div")!;
    expect(within(humanRow).queryByText("AI")).toBeNull();
  });

  it("quick capture posts a scratch note on Enter and clears", async () => {
    const user = userEvent.setup();
    renderWithProviders(<HomePage />);
    const input = await screen.findByPlaceholderText(/隨手記/);
    await user.type(input, "想法一枚{Enter}");
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/notes", { bodyMd: "想法一枚" }));
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("keeps the draft when quick capture fails, and says so", async () => {
    // 清空只能發生在 onSuccess:先清再送 = 一次網路故障就吞掉使用者剛打的字。
    // 但草稿留著而畫面毫無反應,使用者只會以為 Enter 沒按到,再按一次 —— 然後又一次。
    vi.mocked(api.post).mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    renderWithProviders(<HomePage />);
    const input = await screen.findByPlaceholderText(/隨手記/);
    await user.type(input, "想法一枚{Enter}");
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect((input as HTMLInputElement).value).toBe("想法一枚");
    expect(await screen.findByText("儲存失敗,內容已保留")).toBeInTheDocument();
    // 再打字就是重新開始一次 —— 舊的失敗訊息不該還掛在那裡
    await user.type(input, "!");
    await waitFor(() => expect(screen.queryByText("儲存失敗,內容已保留")).toBeNull());
  });

  it("labels the quick capture input in Chinese", async () => {
    renderWithProviders(<HomePage />);
    expect(await screen.findByLabelText("隨手記")).toBeInTheDocument();
  });

  it("reports a dead server instead of cheerfully claiming there is nothing due", async () => {
    // 「今天沒有到期任務 🎉」與「我讀不到資料」是完全相反的兩件事。
    // data ?? [] 會把後者渲染成前者,而使用者會照著這句話安心地過完一天。
    vi.mocked(api.get).mockRejectedValue(new Error("connect ECONNREFUSED"));
    renderWithProviders(<HomePage />);
    const errors = await screen.findAllByText(/讀取失敗:connect ECONNREFUSED/);
    expect(errors.length).toBeGreaterThan(0);
    expect(screen.queryByText(/今天沒有到期任務/)).toBeNull();
    // briefing 那半邊同樣不能給出錯誤的建議(「還沒有 briefing,執行 /daily」)
    expect(screen.queryByText(/還沒有 briefing/)).toBeNull();
  });
});
