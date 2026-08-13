import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor, act, renderHook, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "./helpers";

vi.mock("../src/api", async (orig) => {
  const mod = (await orig()) as object;
  return { ...mod, api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
import { api, ApiError } from "../src/api";
import { NotesPage } from "../src/pages/Notes";
import { useAutosave } from "../src/pages/useAutosave";

const NOTES = [
  { id: 1, title: "API 版本策略會議", date: "2026-08-01", type: "Meeting", processedAt: null, bodyMd: "## 決議", projectId: null, attendees: null },
  { id: 2, title: null, date: "2026-08-02", type: "Scratch", processedAt: "2026-08-02T10:00:00", bodyMd: "retention 太長\n其餘", projectId: null, attendees: null },
];

/** 「＋ 新增」建出來的空筆記 —— server 回什麼,導過去之後編輯器就該長成什麼。 */
const CREATED = { id: 9, title: null, date: "2026-08-02", type: "Meeting", processedAt: null, bodyMd: " ", projectId: null, attendees: null };

const PROJECTS = [{ id: 5, name: "Payment GW", status: "Active" }];

function mockApi({ notes = NOTES as unknown }: { notes?: unknown } = {}) {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === "/notes") return notes;
    if (path === "/notes/1") return NOTES[0];
    if (path === "/notes/2") return NOTES[1];
    if (path === "/notes/9") return CREATED;
    if (path === "/projects") return PROJECTS;
    return [];
  });
}

beforeEach(() => {
  // 呼叫紀錄由 vite.config.ts 的 clearMocks 清掉;本頁多數斷言問的正是「送了幾次 PATCH」。
  // 計時器不在 clearMocks 的管轄範圍,仍要自己收。
  vi.useRealTimers();
  mockApi();
  vi.mocked(api.post).mockResolvedValue({ id: 9 });
  vi.mocked(api.patch).mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
});

/** 這一頁一律經由真實路由渲染 —— id 來自 useParams,沒有 Route 包著就永遠是 undefined。 */
function renderNotes(route = "/notes") {
  return renderWithProviders(<NotesPage />, { route, path: "/notes/:id?" });
}

describe("useAutosave", () => {
  it("debounces then saves; reports saved", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook(({ v }) => useAutosave(v, save, 2000), {
      initialProps: { v: "a" },
    });
    rerender({ v: "ab" });
    expect(save).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(2100);
    });
    expect(save).toHaveBeenCalledWith("ab");
    expect(result.current.state).toBe("saved");
    vi.useRealTimers();
  });

  it("does not save on first mount", async () => {
    // 開啟一則筆記不該憑空產生一次寫入(還會蓋掉 updatedAt / 留下假 revision)。
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useAutosave("a", save, 2000));
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(save).not.toHaveBeenCalled();
    expect(result.current.state).toBe("idle");
    vi.useRealTimers();
  });

  it("only saves once for a burst of changes", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(({ v }) => useAutosave(v, save, 2000), {
      initialProps: { v: "a" },
    });
    rerender({ v: "ab" });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    rerender({ v: "abc" });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(save).not.toHaveBeenCalled(); // 前一輪的 timer 被取消
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("abc");
    vi.useRealTimers();
  });

  it("keeps retrying while saves keep failing, then settles on recovery", async () => {
    // 「重試中」是承諾:一直失敗就得一直試。停在第二次卻還印著重試中,等於騙人。
    vi.useFakeTimers();
    const save = vi.fn().mockRejectedValue(new Error("boom"));
    const { result, rerender } = renderHook(({ v }) => useAutosave(v, save, 2000), {
      initialProps: { v: "a" },
    });
    rerender({ v: "ab" });
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        vi.advanceTimersByTime(2100);
      });
    }
    expect(save.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(save.mock.calls.every(([v]) => v === "ab")).toBe(true);
    expect(result.current.state).toBe("error");

    save.mockResolvedValue(undefined);
    await act(async () => {
      vi.advanceTimersByTime(2100);
    });
    const afterRecovery = save.mock.calls.length;
    expect(result.current.state).toBe("saved");
    // 成功之後就該安靜:重試迴圈不能在恢復後又多送一次同樣的內容。
    await act(async () => {
      vi.advanceTimersByTime(10000);
    });
    expect(save.mock.calls.length).toBe(afterRecovery);
    vi.useRealTimers();
  });

  it("does not save on mount under StrictMode", async () => {
    // StrictMode 會把 effect 跑兩次。用一個「跑過了」的旗標擋首次儲存,第二次就擋不住 —— dev
    // 環境於是每開一則筆記就憑空寫一次。守衛必須對重複呼叫免疫(比對 value 本身)。
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useAutosave("a", save, 2000), { wrapper: StrictMode });
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(save).not.toHaveBeenCalled();
    expect(result.current.state).toBe("idle");
    vi.useRealTimers();
  });

  it("flushes a pending save on unmount", async () => {
    // 切換筆記會把編輯器整個換掉(key 重掛)。debounce 還沒到就直接丟掉,
    // 等於使用者最後兩秒打的字消失無蹤。
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue(undefined);
    const { rerender, unmount } = renderHook(({ v }) => useAutosave(v, save, 2000), {
      initialProps: { v: "a" },
    });
    rerender({ v: "ab" });
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(save).not.toHaveBeenCalled();
    await act(async () => {
      unmount();
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("ab");
    vi.useRealTimers();
  });

  it("ignores a stale save that settles after a newer one", async () => {
    // 兩筆儲存在飛時,先派的後回。照單全收的話畫面會在最新那筆失敗之後
    // 亮出「已儲存 ✓」—— 使用者以為存好了,伺服器上其實是舊內容。
    vi.useFakeTimers();
    const pending: { resolve: () => void; reject: () => void }[] = [];
    const save = vi.fn(
      () =>
        new Promise<void>((res, rej) => {
          pending.push({ resolve: () => res(), reject: () => rej(new Error("boom")) });
        }),
    );
    const { result, rerender } = renderHook(({ v }) => useAutosave(v, save, 2000), {
      initialProps: { v: "a" },
    });
    rerender({ v: "ab" });
    await act(async () => {
      vi.advanceTimersByTime(2100);
    });
    rerender({ v: "abc" });
    await act(async () => {
      vi.advanceTimersByTime(2100);
    });
    expect(save).toHaveBeenCalledTimes(2);

    await act(async () => {
      pending[1].reject(); // 最新那筆先回來,而且失敗了
    });
    expect(result.current.state).toBe("error");
    await act(async () => {
      pending[0].resolve(); // 舊的那筆才姍姍來遲地成功
    });
    expect(result.current.state).toBe("error"); // 過期的結果不得覆蓋現況
    vi.useRealTimers();
  });
});

describe("Notes", () => {
  it("lists notes: scratch uses first line, unprocessed badge on meeting note", async () => {
    renderNotes();
    await waitFor(() => expect(screen.getByText("API 版本策略會議")).toBeInTheDocument());
    expect(screen.getByText("retention 太長")).toBeInTheDocument();
    expect(screen.getByText("未處理")).toBeInTheDocument();
  });

  it("sorts notes by date descending", async () => {
    renderNotes();
    await screen.findByText("API 版本策略會議");
    const labels = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    const scratch = labels.findIndex((t) => t.includes("retention 太長"));
    const meeting = labels.findIndex((t) => t.includes("API 版本策略會議"));
    expect(scratch).toBeLessThan(meeting); // 08-02 在 08-01 之前
  });

  it("labels an untitled empty note instead of rendering a blank row", async () => {
    // ＋新增 建立的是 bodyMd=" " 的空筆記:沒有備援字樣的話列表上就是一列看不見的東西。
    mockApi({ notes: [{ ...NOTES[0], id: 7, title: "", bodyMd: " " }] });
    renderNotes();
    expect(await screen.findByText("(未命名)")).toBeInTheDocument();
  });

  it("filters the list by type", async () => {
    const user = userEvent.setup();
    renderNotes();
    await screen.findByText("API 版本策略會議");
    await user.click(screen.getByRole("button", { name: "Scratch" }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/notes", { type: "Scratch" }));
  });

  it("selecting a note opens editor with metadata and preview", async () => {
    const user = userEvent.setup();
    renderNotes();
    await user.click(await screen.findByText("API 版本策略會議"));
    await waitFor(() => expect(screen.getByDisplayValue("API 版本策略會議")).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "決議" })).toBeInTheDocument(); // 並排預覽
  });

  it("swaps the editor content when another note is selected", async () => {
    // 草稿是綁在筆記上的:切過去還看到上一則的內容,下一次自動儲存就會把它寫進錯的筆記。
    const user = userEvent.setup();
    renderNotes("/notes/1");
    await screen.findByDisplayValue("## 決議");
    await user.click(screen.getByText("retention 太長"));
    expect(await screen.findByDisplayValue(/retention 太長\s+其餘/)).toBeInTheDocument();
    expect(screen.queryByDisplayValue("## 決議")).toBeNull();
  });

  it("creates a Meeting note and navigates to it", async () => {
    const user = userEvent.setup();
    renderNotes();
    await screen.findByText("API 版本策略會議");
    await user.click(screen.getByRole("button", { name: "＋ 新增" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/notes", { bodyMd: " ", type: "Meeting" }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/notes/9"));
    // 導過去之後編輯器要真的開起來 —— 這才是「新增」這個動作的完整交付。
    expect(await screen.findByRole("textbox", { name: "內文" })).toBeInTheDocument();
    expect(screen.getByLabelText("類型")).toHaveValue("Meeting");
  });

  it("does not autosave just because a note was opened", async () => {
    // form 只是把 server 的值搬進 state;沒人改過任何東西時送 PATCH 等於偽造一次編輯。
    renderNotes("/notes/1");
    await screen.findByDisplayValue("API 版本策略會議");
    await new Promise((r) => setTimeout(r, 2600));
    expect(api.patch).not.toHaveBeenCalled();
  }, 10000);

  it("autosaves edits after the debounce, sending null for empty nullable fields", async () => {
    // 空欄位送 null(= 清成 NULL)而不是 "":空字串會被當成一個值存進去。
    // bodyMd 是 NOT NULL,永遠原樣送。
    const user = userEvent.setup();
    renderNotes("/notes/1");
    const body = await screen.findByRole("textbox", { name: "內文" });
    await user.type(body, "\n- 先做 v2");
    await waitFor(
      () =>
        expect(api.patch).toHaveBeenCalledWith("/notes/1", {
          title: "API 版本策略會議",
          type: "Meeting",
          date: "2026-08-01",
          attendees: null,
          projectId: null,
          bodyMd: "## 決議\n- 先做 v2",
        }),
      { timeout: 5000 },
    );
    expect(await screen.findByText("已儲存 ✓")).toBeInTheDocument();
  }, 10000);

  it("clears the title by sending null, without warning about it", async () => {
    const user = userEvent.setup();
    renderNotes("/notes/1");
    await user.clear(await screen.findByLabelText("標題"));
    await waitFor(
      () => expect(api.patch).toHaveBeenCalledWith("/notes/1", expect.objectContaining({ title: null })),
      { timeout: 5000 },
    );
    expect(screen.queryByText(/尚不支援清除/)).toBeNull();
  }, 10000);

  it("omits an emptied date and says the original will be kept", async () => {
    // date 是 NOT NULL 且預設今天:清空送 "" 會被原樣寫進去,那則筆記從此在所有
    // 依日期的查詢裡都對不上。整個不送,並且當場說清楚 —— 不能讓畫面看起來清掉了。
    const user = userEvent.setup();
    renderNotes("/notes/1");
    await user.clear(await screen.findByLabelText("日期"));
    expect(await screen.findByText(/尚不支援清除日期.*其餘欄位/)).toBeInTheDocument();
    await waitFor(() => expect(api.patch).toHaveBeenCalled(), { timeout: 5000 });
    expect(vi.mocked(api.patch).mock.calls[0][1]).not.toHaveProperty("date");
  }, 10000);

  it("still says 選一則筆記 when nothing is actually selected", async () => {
    // 把整段換成 queryGuard 之後最容易靜靜壞掉的,就是這個原本就對的狀態。
    renderNotes();
    await screen.findByText("API 版本策略會議");
    expect(screen.getByText(/選一則筆記/)).toBeInTheDocument();
  });

  it("shows 載入中, not 選一則筆記, while the selected note is in flight", async () => {
    // 讀取中說「你還沒選」跟讀取失敗說「你還沒選」是同一個謊,只是短一點。
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "/notes") return NOTES;
      if (path === "/notes/1") return new Promise(() => {}); // 永遠不 settle
      return [];
    });
    renderNotes("/notes/1");
    expect(await screen.findByText(/載入中/)).toBeInTheDocument();
    expect(screen.queryByText(/選一則筆記/)).not.toBeInTheDocument();
  });

  it("reports a failed note read instead of pretending nothing is selected", async () => {
    // 「選一則筆記」是在說「你還沒選」。網址裡明明有 id、只是讀不到的時候,那句話是假的 ——
    // 使用者會以為自己點錯了,而真相是這則筆記讀取失敗了。
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "/notes") return NOTES;
      if (path === "/notes/1") throw new ApiError("OP_FAILED", "伺服器錯誤", 500);
      if (path === "/projects") return [];
      return [];
    });
    renderWithProviders(<NotesPage />, { route: "/notes/1", path: "/notes/:id?" });
    await waitFor(() => expect(screen.getByText(/讀取失敗/)).toBeInTheDocument());
    expect(screen.queryByText(/選一則筆記/)).not.toBeInTheDocument();
  });

  it("shows a retrying message when the save fails", async () => {
    vi.mocked(api.patch).mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    renderNotes("/notes/1");
    const body = await screen.findByRole("textbox", { name: "內文" });
    await user.type(body, "x");
    expect(await screen.findByText("儲存失敗,重試中", undefined, { timeout: 5000 })).toBeInTheDocument();
  }, 10000);

  it("note editor lists derived tasks and radar with deep links", async () => {
    vi.mocked(api.get).mockImplementation(async (path: string, params?: Record<string, unknown>) => {
      if (path === "/notes/5") return { id: 5, title: "會議", bodyMd: "x", date: "2026-08-03", type: "Meeting", attendees: null, projectId: null, processedAt: null };
      if (path === "/notes") return [];
      if (path === "/projects") return [];
      if (path === "/tasks" && params?.noteId === "5")
        return [{ id: 21, title: "衍生任務", status: "To-do", priority: "P2", origin: "ai", dueDate: null, projectId: null, bodyMd: null, owner: null, noteId: 5 }];
      if (path === "/radar" && params?.noteId === "5")
        return [{ id: 31, title: "衍生風險", severity: "P1", status: "Open", projectId: null, noteId: 5, owner: null, source: null, bodyMd: null, updatedAt: "2026-08-03T10:00:00" }];
      return [];
    });
    renderWithProviders(<NotesPage />, { route: "/notes/5", path: "/notes/:id?" });
    expect(await screen.findByRole("link", { name: /衍生任務/ })).toHaveAttribute("href", "/tasks/21");
    expect(await screen.findByRole("link", { name: /衍生風險/ })).toHaveAttribute("href", "/radar/31");
    // 任務列要看得出「現在到哪了」—— 只有優先級的話,已完成與沒開始長得一模一樣。
    // (radar 那側本來就掛著 status,任務側不能少。)
    const section = within(screen.getByRole("region", { name: "衍生項目" }));
    expect(section.getByText("To-do")).toBeInTheDocument();
  });

  it("derived section stays hidden when the note produced nothing", async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "/notes/5") return { id: 5, title: "會議", bodyMd: "x", date: "2026-08-03", type: "Meeting", attendees: null, projectId: null, processedAt: null };
      if (path === "/notes") return [];
      if (path === "/projects") return [];
      return [];
    });
    renderWithProviders(<NotesPage />, { route: "/notes/5", path: "/notes/:id?" });
    await screen.findByLabelText("內文");
    // 兩支衍生查詢在編輯器出現的當下還在飛,那一瞬間區塊會是「載入中」——這是刻意的
    // (區塊不見 =「沒有衍生項目」,讀取中謊報那個結論才是壞的)。settle 之後才是真答案。
    await waitFor(() => expect(screen.queryByText("衍生項目")).not.toBeInTheDocument());
  });

  it("stops retrying a 4xx and stops saying 重試中", async () => {
    // 4xx 重試一萬次答案都一樣 —— 那是一個安靜的無限迴圈,配上一句永遠不會兌現的「重試中」。
    vi.mocked(api.patch).mockRejectedValue(new ApiError("NOT_FOUND", "notes#1 not found", 404));
    const user = userEvent.setup();
    renderNotes("/notes/1");
    const body = await screen.findByRole("textbox", { name: "內文" });
    await user.type(body, "x");
    expect(await screen.findByText("儲存失敗", undefined, { timeout: 5000 })).toBeInTheDocument();
    // 再等兩輪 debounce:還在重試的話這裡就會變成 2、3 次
    await new Promise((r) => setTimeout(r, 4500));
    expect(api.patch).toHaveBeenCalledTimes(1);
  }, 15000);
});
