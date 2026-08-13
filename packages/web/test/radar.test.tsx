import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "./helpers";

vi.mock("../src/api", async (orig) => {
  const mod = (await orig()) as object;
  return { ...mod, api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
import { api } from "../src/api";
import { RadarPage, staleDays, todayLocal } from "../src/pages/Radar";

/**
 * staleness 是拿 updatedAt 跟「今天」比的,所以 fixture 的日期必須相對於現在算 ——
 * 寫死日期的話這幾個 test 明年就會開始說謊(13 天變 378 天),而且是靜靜地繼續綠。
 *
 * 而且只能用本地日期欄位:toISOString() 是 UTC,在 UTC-8 的下午或 UTC+8 的凌晨會整整差一天,
 * 元件那邊比的卻是本地日期 —— 天數斷言就會隨著跑測試的時區與時刻機率性地紅。
 * 先把時間錨到中午再退 n 天,DST 換日也影響不到日期欄位。
 */
const pad = (n: number) => String(n).padStart(2, "0");
const daysAgo = (n: number) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const RADAR = [
  {
    id: 1, title: "schema 凍結時程未定", severity: "P1", status: "Open",
    projectId: 5, source: null, owner: "王", noteId: 7, bodyMd: null,
    updatedAt: `${daysAgo(13)}T10:00:00`,
  },
  {
    id: 2, title: "監控告警噪音過高", severity: "P3", status: "In Progress",
    projectId: null, source: "JIRA-42", owner: null, noteId: null, bodyMd: "## 現況",
    updatedAt: `${daysAgo(1)}T10:00:00`,
  },
];

const PROJECTS = [{ id: 5, name: "資料平台遷移", status: "Active" }];

const NOTE_7 = { id: 7, title: "API 版本策略會議", bodyMd: "…", date: "2026-08-03", type: "Meeting" };

function mockApi({ radar = RADAR as unknown, projects = PROJECTS as unknown } = {}) {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === "/radar") return radar;
    if (path === "/projects") return projects;
    if (path === "/notes/7") return NOTE_7;
    // 單筆走自己的端點:直開網址進來時清單還沒回來(或被篩選排除),drawer 仍要有東西可顯示。
    const m = /^\/radar\/(\d+)$/.exec(path);
    if (m) return (radar as { id: number }[]).find((r) => r.id === Number(m[1]));
    return [];
  });
}

beforeEach(() => {
  // 呼叫紀錄由 vite.config.ts 的 clearMocks 清掉;「送了幾次 PATCH/POST」的斷言靠它才準。
  mockApi();
  vi.mocked(api.post).mockResolvedValue({ id: 3 });
  vi.mocked(api.patch).mockResolvedValue({});
  vi.mocked(api.del).mockResolvedValue({});
});

describe("Radar", () => {
  it("renders table rows with project name and severity pill", async () => {
    renderWithProviders(<RadarPage />, { route: "/radar", path: "/radar/:id?" });
    await waitFor(() => expect(screen.getByText("schema 凍結時程未定")).toBeInTheDocument());
    const table = within(screen.getByRole("table"));
    expect(table.getByText("資料平台遷移")).toBeInTheDocument();
    // 篩選那排也有一顆 P1 按鈕,所以要問的是「表格裡的那顆 severity pill」。
    expect(table.getByText("P1")).toBeInTheDocument();
  });

  it("flags a stale non-Resolved item with its day count, and leaves fresh ones plain", async () => {
    renderWithProviders(<RadarPage />, { route: "/radar", path: "/radar/:id?" });
    const stale = await screen.findByText(/Open · 13 天/);
    expect(stale.className).toContain("text-warn");
    // 狀態文字在篩選 pill 上也有一份 —— 問的是表格裡那顆,查詢範圍必須縮到 table。
    // 剛更新過的那筆只有狀態本身,不該長出天數。
    expect(within(screen.getByRole("table")).getByText("In Progress").className).not.toContain("text-warn");
  });

  it("does not flag a Resolved item however long it has sat", async () => {
    mockApi({ radar: [{ ...RADAR[0], status: "Resolved" }] });
    renderWithProviders(<RadarPage />, { route: "/radar", path: "/radar/:id?" });
    await screen.findByText("schema 凍結時程未定");
    const table = within(screen.getByRole("table"));
    expect(table.getByText("Resolved").className).not.toContain("text-warn");
    expect(table.queryByText(/天/)).toBeNull();
  });

  it("filters by status pill", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RadarPage />, { route: "/radar", path: "/radar/:id?" });
    await screen.findByText("schema 凍結時程未定");
    await user.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/radar", { status: "Open" }));
  });

  it("filters by severity pill", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RadarPage />, { route: "/radar", path: "/radar/:id?" });
    await screen.findByText("schema 凍結時程未定");
    // 表格裡也有一顆寫著 P1 的 severity pill,所以查詢範圍要縮到篩選那一排。
    const pills = within(screen.getByRole("group", { name: "Severity 篩選" }));
    await user.click(pills.getByRole("button", { name: "P1" }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/radar", { severity: "P1" }));
  });

  it("combines status and severity filters", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RadarPage />, { route: "/radar", path: "/radar/:id?" });
    await screen.findByText("schema 凍結時程未定");
    await user.click(screen.getByRole("button", { name: "Open" }));
    await user.click(within(screen.getByRole("group", { name: "Severity 篩選" })).getByRole("button", { name: "P1" }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/radar", { status: "Open", severity: "P1" }));
  });

  it("marks an item whose project no longer exists", async () => {
    // 專案刪除不 cascade:關聯照常顯示,只是要看得出容器已不在。
    mockApi({ radar: [{ ...RADAR[0], projectId: 99 }] });
    renderWithProviders(<RadarPage />, { route: "/radar", path: "/radar/:id?" });
    await screen.findByText("schema 凍結時程未定");
    expect(within(screen.getByRole("table")).getByText("(已刪除專案)")).toBeInTheDocument();
  });

  it("does not flash (已刪除專案) before the projects query answers", async () => {
    // 專案還沒載完時說「已刪除」是造謠 —— 查詢成功前一律留白。
    mockApi({ radar: [{ ...RADAR[0], projectId: 99 }], projects: new Promise(() => {}) });
    renderWithProviders(<RadarPage />, { route: "/radar", path: "/radar/:id?" });
    await screen.findByText("schema 凍結時程未定");
    expect(within(screen.getByRole("table")).queryByText("(已刪除專案)")).toBeNull();
  });

  it("new drawer posts a radar item", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RadarPage />, { route: "/radar", path: "/radar/:id?" });
    await user.click(await screen.findByRole("button", { name: /＋ 新增/ }));
    await user.type(screen.getByLabelText("標題"), "新風險");
    await user.click(screen.getByRole("button", { name: "建立" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/radar", expect.objectContaining({ title: "新風險" })),
    );
    // 空欄位送 null 而不是 "":空字串會被當成一個值存進 DB,之後既不是空也不是有值。
    expect(vi.mocked(api.post).mock.calls[0][1]).toMatchObject({ projectId: null, bodyMd: null, source: null });
  });

  it("opens an existing item and patches it", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RadarPage />, { route: "/radar", path: "/radar/:id?" });
    await user.click(await screen.findByText("監控告警噪音過高"));
    expect(await screen.findByText("編輯雷達項目")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("狀態"), "Resolved");
    await user.click(screen.getByRole("button", { name: "儲存" }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/radar/2", expect.objectContaining({ status: "Resolved" })),
    );
  });

  it("deep link /radar/1 opens the edit drawer", async () => {
    renderWithProviders(<RadarPage />, { route: "/radar/1", path: "/radar/:id?" });
    await waitFor(() => expect(screen.getByText("編輯雷達項目")).toBeInTheDocument());
  });

  it("reopens a saved item with the saved value, not the pre-save cache", async () => {
    // drawer 的表單只在掛載時初始化一次,所以再次點開時拿到的必須是存檔後的資料。
    // 單筆快取 ["radar-item", id] 不會被 ["radar"] 的失效掃到(prefix 是逐段精確比對),
    // 漏掉它的話:表格是新標題,點開卻是舊標題 —— 而且一存就把舊值蓋回去。
    let stored: Record<string, unknown> = { ...RADAR[1] };
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "/radar/2") return stored;
      if (path === "/radar") return [stored];
      if (path === "/projects") return PROJECTS;
      return [];
    });
    vi.mocked(api.patch).mockImplementation(async (_path: string, body: unknown) => {
      stored = { ...stored, ...(body as Record<string, unknown>) };
      return {};
    });
    const user = userEvent.setup();
    renderWithProviders(<RadarPage />, { route: "/radar/2", path: "/radar/:id?" });
    const title = await screen.findByLabelText("標題");
    await user.clear(title);
    await user.type(title, "監控告警噪音已收斂");
    await user.click(screen.getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(screen.queryByText("編輯雷達項目")).toBeNull()); // 存完就關
    await user.click(await screen.findByText("監控告警噪音已收斂"));
    expect(await screen.findByDisplayValue("監控告警噪音已收斂")).toBeInTheDocument();
  });

  it("radar drawer shows owner and source note, saves owner", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RadarPage />, { route: "/radar/1", path: "/radar/:id?" });
    await waitFor(() => expect(screen.getByText("編輯雷達項目")).toBeInTheDocument());
    expect(await screen.findByRole("link", { name: "API 版本策略會議" })).toHaveAttribute("href", "/notes/7");
    const owner = screen.getByLabelText("負責人");
    // 先確認 owner 真的被載進表單 —— 否則 clear→type 測的是一個本來就空的欄位,
    // 就算 drawer 根本沒讀到既有 owner 這支 test 也照樣綠。
    expect(owner).toHaveValue("王");
    await user.clear(owner);
    await user.type(owner, "林");
    await user.click(screen.getByRole("button", { name: "儲存" }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/radar/1", expect.objectContaining({ owner: "林" })),
    );
  });

  it("deletes an existing item", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RadarPage />, { route: "/radar", path: "/radar/:id?" });
    await user.click(await screen.findByText("監控告警噪音過高"));
    await user.click(await screen.findByRole("button", { name: "刪除" }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith("/radar/2"));
  });

  it("clears a set project by sending an explicit null, then closes", async () => {
    // 清空與「別動這欄」是兩件事;null 是唯一說得出前者的方式,省略只會讓值在重整後又冒回來。
    const user = userEvent.setup();
    renderWithProviders(<RadarPage />, { route: "/radar", path: "/radar/:id?" });
    await user.click(await screen.findByText("schema 凍結時程未定"));
    await user.selectOptions(await screen.findByLabelText("專案"), "");
    await user.click(screen.getByRole("button", { name: "儲存" }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/radar/1", expect.objectContaining({ projectId: null })),
    );
    // 清空是一次正常的儲存 —— 存完就關,不是需要使用者再處理一次的例外
    await waitFor(() => expect(screen.queryByText("編輯雷達項目")).toBeNull());
  });

  it("clears a set source by sending an explicit null", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RadarPage />, { route: "/radar", path: "/radar/:id?" });
    await user.click(await screen.findByText("監控告警噪音過高")); // source: "JIRA-42"
    await user.clear(await screen.findByLabelText(/來源/));
    await user.click(screen.getByRole("button", { name: "儲存" }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/radar/2", expect.objectContaining({ source: null })),
    );
  });

  it("surfaces a failed save instead of leaving the drawer looking unresponsive", async () => {
    // 失敗時 drawer 不關、內容還在,但畫面上若什麼都不變,看起來就只像按鈕沒反應。
    vi.mocked(api.patch).mockRejectedValue(new Error("connect ECONNREFUSED"));
    const user = userEvent.setup();
    renderWithProviders(<RadarPage />, { route: "/radar", path: "/radar/:id?" });
    await user.click(await screen.findByText("監控告警噪音過高"));
    await user.click(await screen.findByRole("button", { name: "儲存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/儲存失敗:connect ECONNREFUSED/);
    expect(screen.getByText("編輯雷達項目")).toBeInTheDocument();
  });

  it("will not create an item with a blank title", async () => {
    // title 是 write.radar 唯一的必填;讓按鈕可按只會換來一個目前沒人顯示的 400。
    const user = userEvent.setup();
    renderWithProviders(<RadarPage />, { route: "/radar", path: "/radar/:id?" });
    await user.click(await screen.findByRole("button", { name: /＋ 新增/ }));
    const create = screen.getByRole("button", { name: "建立" });
    expect(create).toBeDisabled();
    await user.type(screen.getByLabelText("標題"), "   ");
    expect(create).toBeDisabled(); // 純空白不算標題
    await user.type(screen.getByLabelText("標題"), "新風險");
    expect(create).toBeEnabled();
  });
});

describe("staleDays", () => {
  // 純函式版本才測得動「幾天」這件事本身 —— 不必偽造時鐘,也不受跑測試的時區影響。
  it("counts whole days between two local date strings", () => {
    expect(staleDays("2026-07-20T10:00:00", "2026-08-02")).toBe(13);
    expect(staleDays("2026-08-01T23:59:59", "2026-08-02")).toBe(1);
    expect(staleDays("2026-08-02T00:00:01", "2026-08-02")).toBe(0);
  });

  it("ignores the time of day on both sides", () => {
    // 錨在中午的意義:同一天不管幾點更新,都是 0 天,不會被四捨五入成 1 天。
    expect(staleDays("2026-08-02T00:00:00", "2026-08-02")).toBe(0);
    expect(staleDays("2026-08-02T23:59:59", "2026-08-02")).toBe(0);
  });

  it("never goes negative for an item updated in the future", () => {
    expect(staleDays("2026-08-09T10:00:00", "2026-08-02")).toBe(0);
  });

  it("survives a DST transition (spring forward)", () => {
    // 3/8 是 US DST 起日;若不錨中午而用 00:00,這段會少掉一小時、被 round 成 6 天。
    expect(staleDays("2026-03-05T10:00:00", "2026-03-12")).toBe(7);
  });

  it("todayLocal reports the local calendar date, not the UTC one", () => {
    const d = new Date();
    expect(todayLocal()).toBe(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
  });
});
