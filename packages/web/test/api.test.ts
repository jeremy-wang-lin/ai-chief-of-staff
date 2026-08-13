import { describe, it, expect, vi, afterEach } from "vitest";
import { api, ApiError, checkAuth, getToken, setToken, clearToken } from "../src/api";

afterEach(() => vi.unstubAllGlobals());

// 參數要寫出來:vi.fn(async () => …) 推導出的 mock.calls 是空 tuple,
// 之後 calls[0][0] 會被 tsc 擋下(TS2493)。
function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("api client", () => {
  it("get builds query string and parses json", async () => {
    const fn = stubFetch(200, [{ id: 1 }]);
    const out = await api.get("/tasks", { status: "Done", overdue: true });
    expect(fn.mock.calls[0][0]).toBe("/api/tasks?status=Done&overdue=true");
    expect(out).toEqual([{ id: 1 }]);
  });

  it("get omits empty params", async () => {
    const fn = stubFetch(200, []);
    await api.get("/tasks", { status: "", q: undefined, projectId: null, limit: 5 });
    expect(fn.mock.calls[0][0]).toBe("/api/tasks?limit=5");
  });

  it("non-2xx throws ApiError with server code", async () => {
    stubFetch(404, { error: { code: "NOT_FOUND", message: "tasks#9" } });
    await expect(api.get("/tasks/9")).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    stubFetch(400, { error: { code: "INVALID_INPUT", message: "title: Required" } });
    await expect(api.post("/tasks", {})).rejects.toBeInstanceOf(ApiError);
  });

  it("falls back to OP_FAILED when the body carries no error envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>oops</html>", { status: 500, statusText: "" })),
    );
    // statusText 在 HTTP/2 恆為空字串,所以 fallback 必須是自己的文案而不是 res.statusText。
    await expect(api.del("/tasks/1")).rejects.toMatchObject({
      code: "OP_FAILED",
      status: 500,
      message: "請求失敗",
    });
  });

  it("wraps network failures as ApiError with status 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(api.get("/tasks")).rejects.toMatchObject({
      code: "OP_FAILED",
      status: 0,
      message: "Failed to fetch",
    });
    await expect(api.get("/tasks")).rejects.toBeInstanceOf(ApiError);
  });

  it("sends json body on post/patch and no body on delete", async () => {
    const fn = stubFetch(200, { ok: true });
    await api.patch("/tasks/1", { status: "Done" });
    const init = fn.mock.calls[0][1]!;
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(JSON.stringify({ status: "Done" }));
    expect(init.headers).toMatchObject({ "content-type": "application/json" });

    const fn2 = stubFetch(200, { ok: true });
    await api.del("/tasks/1");
    const delInit = fn2.mock.calls[0][1]!;
    expect(delInit.method).toBe("DELETE");
    expect(delInit.body).toBeUndefined();
  });
});

describe("token 附掛與 401 處理", () => {
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("有 token 時所有請求附 Authorization header;無 token 不附", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    await api.get("/tasks");
    expect((spy.mock.calls[0][1] as RequestInit | undefined)?.headers ?? {}).not.toHaveProperty(
      "authorization",
    );
    setToken("sekret");
    await api.get("/tasks");
    expect((spy.mock.calls[1][1] as RequestInit).headers).toMatchObject({
      authorization: "Bearer sekret",
    });
  });

  it("401 → 清 token 並 reload", async () => {
    setToken("stale");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "x" } }), {
        status: 401,
      }),
    );
    // jsdom 的 location 不可覆寫:用 vi.stubGlobal 換掉全域 location ——
    // api.ts 呼叫的是裸 `location.reload()`(讀 global),stub 就攔得到
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    await expect(api.get("/tasks")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(getToken()).toBeNull();
    expect(reload).toHaveBeenCalled();
  });

  it("checkAuth:401 → false 且不 reload;200 → true;帶入的 token 附進 header", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    expect(await checkAuth("abc")).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(await checkAuth("abc")).toBe(true);
    expect((spy.mock.calls[0][1] as RequestInit).headers).toMatchObject({
      authorization: "Bearer abc",
    });
  });

  it("clearToken 之後請求不再附 header", async () => {
    setToken("sekret");
    clearToken();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await api.get("/tasks");
    expect((spy.mock.calls[0][1] as RequestInit | undefined)?.headers ?? {}).not.toHaveProperty(
      "authorization",
    );
  });
});
