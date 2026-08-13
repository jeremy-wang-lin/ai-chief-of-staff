import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "./helpers";

vi.mock("../src/api", async (orig) => {
  const mod = (await orig()) as object;
  return { ...mod, api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
import { api } from "../src/api";
import { ProjectsPage } from "../src/pages/Projects";

const P = {
  id: 5,
  name: "Payment GW",
  status: "Active",
  elevatorPitch: "重構進入第二階段",
  bodyMd: "## 架構決策",
  team: null,
  risk: null,
  nextMilestone: null,
  updatedAt: "2026-08-02T09:00:00",
};

const REV = {
  id: 7,
  tableName: "projects",
  rowId: 5,
  field: "body_md",
  oldValue: "舊版知識庫",
  actor: "ai",
  workflow: "summarize-projects",
  createdAt: "2026-08-01T09:00:00",
};

/** 關聯項目現在是可點擊清單,不是數量 —— fixture 得是完整的列,不能只有 id。 */
const T1 = {
  id: 1,
  title: "review API",
  status: "To-do",
  priority: "P1",
  dueDate: "2000-01-01",
  source: "human",
  origin: "human",
  owner: null,
  projectId: 5,
  radarId: null,
  noteId: null,
  bodyMd: null,
  completedAt: null,
  createdAt: "2026-08-01T09:00:00",
  updatedAt: "2026-08-01T09:00:00",
};

const N2 = {
  id: 2,
  title: "策略會議",
  date: "2026-08-03",
  type: "Meeting",
  attendees: null,
  projectId: 5,
  processedAt: null,
  bodyMd: "x",
  createdAt: "2026-08-03T09:00:00",
  updatedAt: "2026-08-03T09:00:00",
};

const N3 = { ...N2, id: 3, title: null, bodyMd: "隨手記的想法\n第二行" };

const R4 = {
  id: 4,
  title: "供應商延遲",
  severity: "P0",
  status: "Open",
  source: null,
  owner: null,
  projectId: 5,
  noteId: null,
  bodyMd: null,
  updatedAt: "2026-08-02T09:00:00",
};

/** 每個 test 都能換掉專案本體、版本清單與關聯項目 —— 空知識庫、空歷史都是真實會遇到的第一天狀態。 */
function mockApi({
  project = P as unknown,
  revisions = [REV] as unknown[],
  tasks = [T1] as unknown[],
  radar = [] as unknown[],
  notes = [N2, N3] as unknown[],
} = {}) {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === "/projects") return [project];
    if (path === "/projects/5") return project;
    if (path === "/projects/5/context") return { project, tasks, radar, notes };
    if (path === "/revisions") return revisions;
    return [];
  });
}

beforeEach(() => {
  // 呼叫紀錄由 vite.config.ts 的 clearMocks 清掉;「還原之後有沒有重新抓」問的正是次數。
  mockApi();
  vi.mocked(api.post).mockResolvedValue({});
  vi.stubGlobal("confirm", vi.fn(() => true));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 這一頁的 id 來自 useParams —— 沒有 Route 包著就永遠是 undefined,詳情頁根本不會出現。 */
function renderProjects(route = "/projects") {
  return renderWithProviders(<ProjectsPage />, { route, path: "/projects/:id?" });
}

describe("Projects cards", () => {
  it("cards list shows pitch", async () => {
    renderProjects();
    await waitFor(() => expect(screen.getByText("Payment GW")).toBeInTheDocument());
    expect(screen.getByText(/重構進入第二階段/)).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("says the pitch is AI-generated rather than showing a blank card", async () => {
    mockApi({ project: { ...P, elevatorPitch: null } });
    renderProjects();
    expect(await screen.findByText(/尚無電梯簡報/)).toBeInTheDocument();
  });

  it("creates a project by name and refreshes the list", async () => {
    const user = userEvent.setup();
    renderProjects();
    await screen.findByText("Payment GW");
    await user.type(screen.getByPlaceholderText("＋ 新專案名稱"), "Ledger v2");
    await user.click(screen.getByRole("button", { name: "建立" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/projects", { name: "Ledger v2" }));
    // 建完清空輸入框並重抓 —— 否則新專案要重整才看得到。
    await waitFor(() => expect(screen.getByPlaceholderText("＋ 新專案名稱")).toHaveValue(""));
    expect(vi.mocked(api.get).mock.calls.filter(([p]) => p === "/projects").length).toBeGreaterThan(1);
  });

  it("disables create until a name is typed", async () => {
    // name 必填(min(1)):送空字串只會換來一個看不見的 400。
    const user = userEvent.setup();
    renderProjects();
    await screen.findByText("Payment GW");
    expect(screen.getByRole("button", { name: "建立" })).toBeDisabled();
    await user.type(screen.getByPlaceholderText("＋ 新專案名稱"), "   ");
    expect(screen.getByRole("button", { name: "建立" })).toBeDisabled();
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe("Projects detail", () => {
  it("detail renders knowledge base, related items, revision list with restore", async () => {
    const user = userEvent.setup();
    renderProjects("/projects/5");
    await waitFor(() => expect(screen.getByRole("heading", { name: "架構決策" })).toBeInTheDocument());
    expect(screen.getByText("TASKS(1)")).toBeInTheDocument();
    expect(screen.getByText("NOTES(2)")).toBeInTheDocument();
    expect(screen.getByText("2026-08-01 09:00")).toBeInTheDocument();
    expect(screen.getByText("summarize-projects")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "檢視" }));
    expect(screen.getByText("舊版知識庫")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "還原" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/revisions/7/restore"));
  });

  it("related items render as grouped links, empty groups hidden", async () => {
    // 只給數量的話,使用者知道「有 1 個任務」卻沒有任何辦法走過去看它是什麼。
    renderProjects("/projects/5");
    expect(await screen.findByRole("link", { name: /review API/ })).toHaveAttribute("href", "/tasks/1");
    expect(screen.getByRole("link", { name: /策略會議/ })).toHaveAttribute("href", "/notes/2");
    // 沒有標題的 Scratch 用內文首行當名字,不能變成一列看不見的東西。
    expect(screen.getByRole("link", { name: /隨手記的想法/ })).toHaveAttribute("href", "/notes/3");
    expect(screen.getByText("TASKS(1)")).toBeInTheDocument();
    // 空組不顯示 —— 一個永遠是 0 的標題只是噪音。
    expect(screen.queryByText(/^RADAR/)).not.toBeInTheDocument();
    expect(screen.getByText("2000-01-01")).toBeInTheDocument(); // 逾期日期有顯示
    expect(screen.getByText("2000-01-01")).toHaveClass("text-danger"); // 而且看得出來逾期了
  });

  it("links radar items and only reddens dates that are actually overdue", async () => {
    // 完成的任務不管日期多舊都不是逾期;把它標紅只會製造假警報。
    mockApi({ radar: [R4], tasks: [{ ...T1, dueDate: "2999-01-01" }, { ...T1, id: 9, status: "Done" }] });
    renderProjects("/projects/5");
    expect(await screen.findByRole("link", { name: /供應商延遲/ })).toHaveAttribute("href", "/radar/4");
    expect(screen.getByText("RADAR(1)")).toBeInTheDocument();
    expect(screen.getByText("2999-01-01")).not.toHaveClass("text-danger");
    expect(screen.getByText("2000-01-01")).not.toHaveClass("text-danger");
  });

  it("says there are no related items instead of rendering an empty box", async () => {
    mockApi({ tasks: [], radar: [], notes: [] });
    renderProjects("/projects/5");
    expect(await screen.findByText("尚無關聯項目。")).toBeInTheDocument();
    expect(screen.queryByText(/^TASKS/)).not.toBeInTheDocument();
  });

  it("asks the revisions endpoint for this project's body_md only", async () => {
    renderProjects("/projects/5");
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith("/revisions", { table: "projects", rowId: "5", field: "body_md" }),
    );
  });

  it("does not restore when the confirmation is declined", async () => {
    // 還原會覆蓋現在的知識庫。按下去就做、不問,等於把一個破壞性動作藏在一顆小按鈕後面。
    vi.stubGlobal("confirm", vi.fn(() => false));
    const user = userEvent.setup();
    renderProjects("/projects/5");
    await user.click(await screen.findByRole("button", { name: "還原" }));
    expect(api.post).not.toHaveBeenCalled();
  });

  it("refetches both the project body and the revision list after a restore", async () => {
    // 還原本身也會產生一筆新版本。只重抓內文的話歷史清單就停在還原前,
    // 使用者會以為剛剛那一下沒被記錄。
    const user = userEvent.setup();
    renderProjects("/projects/5");
    await screen.findByRole("heading", { name: "架構決策" });
    const before = (p: string) => vi.mocked(api.get).mock.calls.filter(([x]) => x === p).length;
    const ctxBefore = before("/projects/5/context");
    const revBefore = before("/revisions");
    await user.click(screen.getByRole("button", { name: "還原" }));
    await waitFor(() => expect(before("/projects/5/context")).toBeGreaterThan(ctxBefore));
    await waitFor(() => expect(before("/revisions")).toBeGreaterThan(revBefore));
  });

  it("points at /daily when the knowledge base is empty", async () => {
    mockApi({ project: { ...P, bodyMd: null }, revisions: [] });
    renderProjects("/projects/5");
    expect(await screen.findByText(/尚無內容 — \/daily 會自動累積知識。/)).toBeInTheDocument();
    expect(screen.getByText("尚無版本紀錄。")).toBeInTheDocument();
  });

  it("reports why the detail could not be loaded", async () => {
    // 空白頁或一律「找不到專案」會把 500 / 連線失敗謊報成專案不存在。
    vi.mocked(api.get).mockRejectedValue(new Error("connect ECONNREFUSED"));
    renderProjects("/projects/5");
    expect(await screen.findByText(/讀取失敗:connect ECONNREFUSED/)).toBeInTheDocument();
  });

  it("says a restore failed instead of silently doing nothing", async () => {
    // 使用者剛按下的是一個他以為已經生效的破壞性動作;畫面毫無變化 = 靜靜地失敗。
    vi.mocked(api.post).mockRejectedValue(new Error("connect ECONNREFUSED"));
    const user = userEvent.setup();
    renderProjects("/projects/5");
    await user.click(await screen.findByRole("button", { name: "還原" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/還原失敗:connect ECONNREFUSED/);
  });

  it("labels a first-write revision instead of rendering an empty diff", async () => {
    // oldValue = null 代表「這是第一次寫入,之前沒有東西」。空白區塊看起來像壞掉。
    const user = userEvent.setup();
    mockApi({ revisions: [{ ...REV, oldValue: null, actor: "human", workflow: null }] });
    renderProjects("/projects/5");
    await user.click(await screen.findByRole("button", { name: "檢視" }));
    expect(screen.getByText("（首次寫入前為空）")).toBeInTheDocument();
    expect(screen.getByText("人")).toBeInTheDocument();
  });
});
