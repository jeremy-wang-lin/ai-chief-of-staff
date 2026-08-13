import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "./helpers";

vi.mock("../src/api", async (orig) => {
  const mod = (await orig()) as object;
  return { ...mod, api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
import { api, ApiError, type Task } from "../src/api";
import { TasksPage, resolveMove } from "../src/pages/Tasks";

const TASKS = [
  { id: 1, title: "整理交接文件", status: "To-do", priority: "P3", origin: "human", dueDate: null, projectId: null, bodyMd: null, owner: null, noteId: null },
  { id: 2, title: "review API", status: "In Progress", priority: "P1", origin: "human", dueDate: null, projectId: 5, bodyMd: "重點", owner: "王", noteId: 7 },
];

const NOTE_7 = { id: 7, title: "API 版本策略會議", bodyMd: "…", date: "2026-08-03", type: "Meeting" };

const PROJECTS = [{ id: 5, name: "Payment GW", status: "Active" }];

/** 每支 test 都可覆寫 /tasks 的回應 —— 專案名 fallback 只有在資料指向不存在的專案時才看得出來。 */
function mockApi({ tasks = TASKS as unknown }: { tasks?: unknown } = {}) {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    // 單筆分支放在 /tasks 之前,否則會被前綴誤匹配成清單。drawer 現在自己查單筆,
    // 所以覆寫的清單也要反映到單筆上 —— 否則覆寫欄位的 test 會拿到原始 fixture。
    if (path === "/tasks/2") return (tasks as Task[]).find((t) => t.id === 2) ?? TASKS[1];
    if (path === "/tasks") return tasks;
    if (path === "/projects") return PROJECTS;
    if (path === "/notes/7") return NOTE_7;
    return [];
  });
}

beforeEach(() => {
  // 呼叫紀錄由 vite.config.ts 的 clearMocks 在每個 test 前清掉(實作留著),這裡只裝實作。
  mockApi();
  vi.mocked(api.post).mockResolvedValue({ id: 9 });
  vi.mocked(api.patch).mockResolvedValue({});
  vi.mocked(api.del).mockResolvedValue({});
});

describe("Tasks", () => {
  it("renders four columns with cards in the right column", async () => {
    renderWithProviders(<TasksPage />, { route: "/tasks", path: "/tasks/:id?" });
    await waitFor(() => expect(screen.getByText("整理交接文件")).toBeInTheDocument());
    for (const col of ["TO-DO", "IN PROGRESS", "DONE", "BLOCKED"]) {
      expect(screen.getByText(col)).toBeInTheDocument();
    }
  });

  it("quick-add posts with the column status", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TasksPage />, { route: "/tasks", path: "/tasks/:id?" });
    const inputs = await screen.findAllByPlaceholderText(/輸入標題/);
    await user.type(inputs[1], "新任務{Enter}"); // 第二欄 = In Progress
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/tasks", { title: "新任務", status: "In Progress" }));
  });

  it("opens drawer on card click, saves patch, deletes soft", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TasksPage />, { route: "/tasks", path: "/tasks/:id?" });
    await user.click(await screen.findByText("review API"));
    expect(screen.getByText("編輯任務")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("狀態"), "Done");
    await user.click(screen.getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith("/tasks/2", expect.objectContaining({ status: "Done" })));
    await user.click(await screen.findByText("review API"));
    await user.click(screen.getByRole("button", { name: "刪除" }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith("/tasks/2"));
  });

  it("deep link /tasks/2 opens the drawer for that task", async () => {
    renderWithProviders(<TasksPage />, { route: "/tasks/2", path: "/tasks/:id?" });
    await waitFor(() => expect(screen.getByText("編輯任務")).toBeInTheDocument());
    expect(screen.getByDisplayValue("review API")).toBeInTheDocument();
  });

  it("reopens a saved task with the saved value, not the pre-save cache", async () => {
    // drawer 的表單只在掛載時初始化一次,所以再次點開時拿到的必須是存檔後的資料。
    // 單筆快取 ["task", id] 不會被 ["tasks"] 的失效掃到(prefix 是逐段精確比對),
    // 漏掉它的話:看板上是新標題,點開卻是舊標題 —— 而且一存就把舊值蓋回去。
    let stored: Record<string, unknown> = { ...TASKS[1] };
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "/tasks/2") return stored;
      if (path === "/tasks") return [stored];
      if (path === "/projects") return PROJECTS;
      if (path === "/notes/7") return NOTE_7;
      return [];
    });
    vi.mocked(api.patch).mockImplementation(async (_path: string, body: unknown) => {
      stored = { ...stored, ...(body as Record<string, unknown>) };
      return {};
    });
    const user = userEvent.setup();
    renderWithProviders(<TasksPage />, { route: "/tasks/2", path: "/tasks/:id?" });
    const title = await screen.findByLabelText("標題");
    await user.clear(title);
    await user.type(title, "review API v2");
    await user.click(screen.getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(screen.queryByText("編輯任務")).toBeNull()); // 存完就關
    await user.click(await screen.findByText("review API v2"));
    expect(await screen.findByDisplayValue("review API v2")).toBeInTheDocument();
  });

  it("shows the task's project by name in the drawer dropdown", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TasksPage />, { route: "/tasks", path: "/tasks/:id?" });
    await user.click(await screen.findByText("review API"));
    // 下拉的 value 是 id,顯示的必須是專案名 —— 使用者不認得 5 是哪個專案。
    const select = await screen.findByLabelText("專案");
    expect((select as HTMLSelectElement).value).toBe("5");
    expect(within(select).getByRole("option", { name: "Payment GW" })).toBeInTheDocument();
  });

  it("switches to the table view and lists the same tasks", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TasksPage />, { route: "/tasks", path: "/tasks/:id?" });
    await screen.findByText("review API");
    await user.click(screen.getByRole("button", { name: "表格" }));
    const table = screen.getByRole("table");
    expect(within(table).getByText("review API")).toBeInTheDocument();
    expect(within(table).getByText("整理交接文件")).toBeInTheDocument();
    expect(within(table).getByText("Payment GW")).toBeInTheDocument();
  });

  it("opens the drawer from a table row", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TasksPage />, { route: "/tasks", path: "/tasks/:id?" });
    await screen.findByText("review API");
    await user.click(screen.getByRole("button", { name: "表格" }));
    await user.click(within(screen.getByRole("table")).getByText("review API"));
    expect(screen.getByText("編輯任務")).toBeInTheDocument();
  });

  it("marks a task whose project no longer exists", async () => {
    // 專案刪除不 cascade:關聯照常顯示,只是要看得出容器已不在。
    mockApi({ tasks: [{ ...TASKS[1], projectId: 99 }] });
    const user = userEvent.setup();
    renderWithProviders(<TasksPage />, { route: "/tasks", path: "/tasks/:id?" });
    await screen.findByText("review API");
    await user.click(screen.getByRole("button", { name: "表格" }));
    expect(within(screen.getByRole("table")).getByText("(已刪除專案)")).toBeInTheDocument();
  });

  it("filters tasks by project", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TasksPage />, { route: "/tasks", path: "/tasks/:id?" });
    await screen.findByText("review API");
    await user.selectOptions(screen.getByLabelText("專案篩選"), "5");
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/tasks", { projectId: "5" }));
  });

  it("keeps the quick-add draft when the post fails, and says so in that column only", async () => {
    // 清空只能發生在 onSuccess:先清再送 = 一次網路故障就吞掉使用者剛打的標題。
    // 但草稿留著而畫面毫無反應,使用者只會以為 Enter 沒按到,再按一次 —— 然後又一次。
    vi.mocked(api.post).mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    renderWithProviders(<TasksPage />, { route: "/tasks", path: "/tasks/:id?" });
    const inputs = await screen.findAllByPlaceholderText(/輸入標題/);
    await user.type(inputs[1], "新任務{Enter}");
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect((inputs[1] as HTMLInputElement).value).toBe("新任務");
    // 四欄共用一個 mutation,但失敗的是這一欄 —— 另外三欄不該跟著喊失敗
    expect(await screen.findAllByText("儲存失敗,內容已保留")).toHaveLength(1);
    await user.type(inputs[1], "!"); // 重新打字 = 重新開始一次
    await waitFor(() => expect(screen.queryByText("儲存失敗,內容已保留")).toBeNull());
  });

  it("reports a failed task list instead of showing four empty columns", async () => {
    // 空看板等於「你今天沒事做」;那是資料層的沉默被當成了答案。
    vi.mocked(api.get).mockRejectedValue(new Error("connect ECONNREFUSED"));
    renderWithProviders(<TasksPage />, { route: "/tasks", path: "/tasks/:id?" });
    expect(await screen.findByText(/讀取失敗:connect ECONNREFUSED/)).toBeInTheDocument();
    expect(screen.queryByText("TO-DO")).toBeNull();
  });

  it("clears the quick-add draft only after the post resolves", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TasksPage />, { route: "/tasks", path: "/tasks/:id?" });
    const inputs = await screen.findAllByPlaceholderText(/輸入標題/);
    await user.type(inputs[0], "新任務{Enter}");
    await waitFor(() => expect((inputs[0] as HTMLInputElement).value).toBe(""));
  });

  it("clears a set project by sending an explicit null", async () => {
    // 清空與「別動這欄」是兩件事,而 null 是唯一說得出前者的方式:
    // 省略欄位會讓畫面上清掉的專案在重整後又冒回來。
    const user = userEvent.setup();
    renderWithProviders(<TasksPage />, { route: "/tasks", path: "/tasks/:id?" });
    await user.click(await screen.findByText("review API"));
    await user.selectOptions(await screen.findByLabelText("專案"), "");
    await user.click(screen.getByRole("button", { name: "儲存" }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/tasks/2", expect.objectContaining({ projectId: null })),
    );
    // 存完就關 —— 清空是一次正常的儲存,不是需要使用者再處理一次的例外
    await waitFor(() => expect(screen.queryByText("編輯任務")).toBeNull());
  });

  it("clears a set due date and empty body by sending null", async () => {
    mockApi({ tasks: [{ ...TASKS[1], dueDate: "2026-08-10" }] });
    const user = userEvent.setup();
    renderWithProviders(<TasksPage />, { route: "/tasks", path: "/tasks/:id?" });
    await user.click(await screen.findByText("review API"));
    // 先確認真的有值可清 —— 否則「清空」測的是一個本來就空的欄位,永遠會通過。
    expect(screen.getByLabelText("到期日")).toHaveValue("2026-08-10");
    await user.clear(screen.getByLabelText("到期日"));
    await user.click(screen.getByRole("button", { name: "儲存" }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/tasks/2", expect.objectContaining({ dueDate: null })),
    );
  });

  it("surfaces a failed save instead of leaving the drawer looking unresponsive", async () => {
    vi.mocked(api.patch).mockRejectedValue(new Error("connect ECONNREFUSED"));
    const user = userEvent.setup();
    renderWithProviders(<TasksPage />, { route: "/tasks", path: "/tasks/:id?" });
    await user.click(await screen.findByText("review API"));
    await user.click(screen.getByRole("button", { name: "儲存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/儲存失敗:connect ECONNREFUSED/);
    expect(screen.getByText("編輯任務")).toBeInTheDocument(); // 失敗不關,內容還在
  });

  it("does not flash (已刪除專案) before the projects query answers", async () => {
    // 專案還沒載完時說「已刪除」是造謠 —— 查詢成功前一律留白。
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "/tasks") return TASKS;
      if (path === "/projects") return new Promise(() => {}); // 永不 resolve
      return [];
    });
    const user = userEvent.setup();
    renderWithProviders(<TasksPage />, { route: "/tasks", path: "/tasks/:id?" });
    await screen.findByText("review API");
    await user.click(screen.getByRole("button", { name: "表格" }));
    expect(within(screen.getByRole("table")).queryByText("(已刪除專案)")).toBeNull();
  });

  it("table view shows the owner column", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TasksPage />, { route: "/tasks", path: "/tasks/:id?" });
    await user.click(await screen.findByRole("button", { name: "表格" }));
    expect(screen.getByText("負責")).toBeInTheDocument();
    expect(screen.getByText("王")).toBeInTheDocument();
  });

  it("drawer shows source note link and saves owner", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TasksPage />, { route: "/tasks/2", path: "/tasks/:id?" });
    await waitFor(() => expect(screen.getByText("編輯任務")).toBeInTheDocument());
    expect(await screen.findByRole("link", { name: "API 版本策略會議" })).toHaveAttribute("href", "/notes/7");
    const owner = screen.getByLabelText("負責人");
    await user.clear(owner);
    await user.type(owner, "林");
    await user.click(screen.getByRole("button", { name: "儲存" }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/tasks/2", expect.objectContaining({ owner: "林" })),
    );
  });

  it("a deep link to a missing task says 讀取失敗, not a silent boardful of nothing", async () => {
    // 壞掉的深連結(已刪除/打錯的 id)必須當場說出來 —— 沉默只會看起來像連結沒作用。
    // 正式碼另外帶 retry: false:404 重試三次答案一樣,只是讓「載入中…」多掛好幾秒。
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "/tasks/999") throw new ApiError("NOT_FOUND", "tasks#999 not found", 404);
      if (path === "/tasks") return TASKS;
      if (path === "/projects") return PROJECTS;
      return [];
    });
    renderWithProviders(<TasksPage />, { route: "/tasks/999", path: "/tasks/:id?" });
    expect(await screen.findByText(/讀取失敗:tasks#999 not found/)).toBeInTheDocument();
    expect(screen.queryByText("編輯任務")).toBeNull();
  });

  it("source note that 404s reads as deleted, not blank", async () => {
    // 筆記可能已被 soft delete:noteId 還在,資訊沒遺失 —— 沉默會看起來像「沒有來源」。
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "/tasks/2") return { ...TASKS[1], noteId: 99 };
      if (path === "/notes/99") throw new ApiError("NOT_FOUND", "not found", 404);
      if (path === "/tasks") return TASKS;
      if (path === "/projects") return PROJECTS;
      return [];
    });
    renderWithProviders(<TasksPage />, { route: "/tasks/2", path: "/tasks/:id?" });
    await waitFor(() => expect(screen.getByText("(已刪除筆記)")).toBeInTheDocument());
  });
});

describe("resolveMove", () => {
  const tasks = TASKS as unknown as Task[];

  it("returns null when the card was not dropped on a column", () => {
    expect(resolveMove(tasks, 2, undefined)).toBeNull();
  });

  it("returns null when dropped back on its own column", () => {
    expect(resolveMove(tasks, 2, "In Progress")).toBeNull();
  });

  it("returns the patch payload when the column changed", () => {
    expect(resolveMove(tasks, 2, "Done")).toEqual({ id: 2, status: "Done" });
  });

  it("returns null for an unknown card id", () => {
    expect(resolveMove(tasks, 999, "Done")).toBeNull();
  });
});
