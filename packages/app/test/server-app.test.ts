import { describe, it, expect } from "vitest";
import { runOp } from "@lcos/core";
import { tmpApp } from "./server-helpers.ts";

describe("server app", () => {
  it("health returns today and latestBriefing", async () => {
    const { app } = tmpApp();
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.latestBriefing).toBeNull();
  });

  it("unknown api path → 404 JSON error", async () => {
    const { app } = tmpApp();
    const res = await app.request("/api/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  // 非 /api/ 的 404 不能回 JSON:那是給瀏覽器的,Task 3 的 SPA fallback 會接手這條路徑。
  it("unknown non-api path → plain 404, not JSON", async () => {
    const { app } = tmpApp();
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).not.toMatch(/application\/json/);
  });

  /**
   * server 只綁 127.0.0.1,但那擋不住瀏覽器:任何網頁都可以對 localhost 送出跨站 fetch/表單,
   * 請求會帶著這台機器的身分抵達。這裡沒有 cookie 或 token 可偷,能被偷走的是「寫入」本身。
   */
  describe("origin check", () => {
    const post = (app: ReturnType<typeof tmpApp>["app"], origin?: string) =>
      app.request("http://127.0.0.1:4700/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
        body: JSON.stringify({ title: "從別的網站寫進來的" }),
      });
    const taskCount = async (app: ReturnType<typeof tmpApp>["app"]) =>
      ((await (await app.request("http://127.0.0.1:4700/api/tasks")).json()) as unknown[]).length;

    it("rejects a cross-origin write and writes nothing", async () => {
      const { app } = tmpApp();
      const res = await post(app, "https://evil.example");
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("FORBIDDEN_ORIGIN");
      // 回 403 卻已經寫進去了是最糟的結果:必須在 handler 之前就攔下來
      expect(await taskCount(app)).toBe(0);
    });

    it("allows a same-origin write", async () => {
      const { app } = tmpApp();
      expect((await post(app, "http://127.0.0.1:4700")).status).toBe(200);
      expect(await taskCount(app)).toBe(1);
    });

    it("allows a write with no Origin at all (curl / 腳本)", async () => {
      // 非瀏覽器的呼叫端不送 Origin。要求它必須存在等於把 CLI 與腳本一起擋掉,
      // 而那些呼叫端本來就不受同源政策約束 —— 擋了也換不到任何安全。
      const { app } = tmpApp();
      expect((await post(app)).status).toBe(200);
    });

    it("allows any localhost port, so the Vite dev proxy still works", async () => {
      // 開發模式的瀏覽器在 5173,請求經 proxy 抵達 4700:Origin 與 Host 天生不同埠。
      // 要防的是外部網頁,不是本機的另一個埠。
      const { app } = tmpApp();
      expect((await post(app, "http://127.0.0.1:5173")).status).toBe(200);
      expect((await post(app, "http://localhost:5173")).status).toBe(200);
    });

    it("leaves cross-origin reads alone", async () => {
      // GET 不改變任何東西,而回應會被同源政策擋在對方的 JS 之外。
      // 連讀都擋只是多一條會在別處壞掉的規則,換不到實際的保護。
      const { app } = tmpApp();
      const res = await app.request("http://127.0.0.1:4700/api/tasks", {
        headers: { origin: "https://evil.example" },
      });
      expect(res.status).toBe(200);
    });

    it("rejects PATCH and DELETE from another origin too", async () => {
      const { app } = tmpApp();
      for (const method of ["PATCH", "DELETE"]) {
        const res = await app.request("http://127.0.0.1:4700/api/tasks/1", {
          method,
          headers: { "content-type": "application/json", origin: "https://evil.example" },
          body: method === "PATCH" ? JSON.stringify({ title: "x" }) : undefined,
        });
        expect(res.status, method).toBe(403);
      }
    });
  });

  /**
   * DNS rebinding:惡意網域先把自己的 A record 指向 127.0.0.1,瀏覽器於是把本服務
   * 當成「同源」讀取 —— 那時的請求根本不帶 Origin,origin 檢查完全擋不住。
   * 唯一還說實話的訊號是 Host header:它會是攻擊者的網域,不是 localhost 家族。
   */
  describe("host allow-list (DNS rebinding)", () => {
    it("rejects a foreign Host header on any method", async () => {
      const { app } = tmpApp();
      const res = await app.request("/api/health", { headers: { host: "evil.example" } });
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("FORBIDDEN_HOST");
    });

    it("allows localhost-family hosts", async () => {
      const { app } = tmpApp();
      for (const host of ["127.0.0.1:4700", "localhost:5173", "[::1]:4700"]) {
        expect((await app.request("/api/health", { headers: { host } })).status, host).toBe(200);
      }
    });

    /**
     * 以下兩個只在 in-process 的 app.request 上成立:真實 server 前面的 @hono/node-server
     * 會先 400 掉大小寫不一致與重複的 Host,根本輪不到中介層。仍然測,是因為那是上游的性質
     * 而不是我們的 —— 換個 adapter、或前面擺個 proxy,這裡就是唯一還站著的一層。
     */
    it("treats the host as case-insensitive (in-process; the real server 400s this first)", async () => {
      const { app } = tmpApp();
      expect((await app.request("/api/health", { headers: { host: "LocalHost:4700" } })).status).toBe(200);
    });

    it("rejects a comma-joined duplicate Host (in-process; the real server 400s this first)", async () => {
      // 兩個 Host header 被併成一個值時,只看 split(":")[0] 會讀到合法的前半而放行,
      // 但下游(proxy、log、另一個框架)可能採信後半 —— 兩邊對「這是誰」的答案不一致就是漏洞。
      const { app } = tmpApp();
      const res = await app.request("/api/health", { headers: { host: "localhost:4700, evil.example" } });
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("FORBIDDEN_HOST");
    });

    // 尾綴點是合法的 FQDN 寫法,擋掉是刻意的 fail-closed:少一種寫法沒人會受傷,放過卻是漏洞。
    it("rejects a trailing-dot host, deliberately", async () => {
      const { app } = tmpApp();
      expect((await app.request("/api/health", { headers: { host: "127.0.0.1.:4700" } })).status).toBe(403);
    });

    // 讀也要擋:rebinding 攻擊要的正是把資料讀出去,GET 才是主要的受害面。
    it("rejects a foreign Host on reads and on writes alike", async () => {
      const { app } = tmpApp();
      const get = await app.request("/api/tasks", { headers: { host: "evil.example" } });
      expect(get.status).toBe(403);
      const post = await app.request("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json", host: "evil.example" },
        body: JSON.stringify({ title: "rebinding" }),
      });
      expect(post.status).toBe(403);
      // 403 卻已經寫進去是最糟的結果:必須攔在 handler 之外
      expect(((await (await app.request("/api/tasks")).json()) as unknown[]).length).toBe(0);
    });

    /**
     * 沒有 Host header 時改看 c.req.url 的 host。要說清楚這條退路擋得住什麼:
     * 在真實 server 上它**等於放行** —— adapter 缺 Host 就拿自己綁的 127.0.0.1 組 URL。
     * 撐住這個決定的是「瀏覽器一律送 Host」,不是這條退路本身。
     *
     * 它真正擋下的是 absolute-form 的請求行(`GET http://evil.example/x HTTP/1.0`):
     * 那時 adapter 直接採用該絕對 URL,host 就是攻擊者的網域。下面第二個斷言釘的正是這件事。
     */
    it("falls back to the request URL, pinning absolute-form request targets", async () => {
      const { app } = tmpApp();
      expect((await app.request("http://127.0.0.1:4700/api/health")).status).toBe(200);
      expect((await app.request("http://evil.example/api/health")).status).toBe(403);
    });
  });

  /**
   * 開放區網時要放行本機介面 IP 與設定的主機名,而 rebinding 防護的語意不變 ——
   * 清單是呼叫端明確給的,攻擊者的網域永遠不會在裡面。
   */
  describe("host allow-list 擴充(allowedHosts)", () => {
    it("allowedHosts 額外項放行(含帶埠與大小寫)", async () => {
      const { app } = tmpApp({ allowedHosts: ["192.168.1.50", "myhost.local"] });
      for (const host of ["192.168.1.50:4700", "MYHOST.LOCAL:4700"]) {
        const res = await app.request("/api/health", { headers: { host } });
        expect(res.status, host).toBe(200);
      }
    });

    it("未列入的 Host 仍 403(rebinding 防護不因開放而消失)", async () => {
      const { app } = tmpApp({ allowedHosts: ["192.168.1.50"] });
      const res = await app.request("/api/health", { headers: { host: "evil.example" } });
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("FORBIDDEN_HOST");
    });

    it("不帶 opts 時 localhost 家族以外一律 403(現狀不變)", async () => {
      const { app } = tmpApp();
      const res = await app.request("/api/health", { headers: { host: "192.168.1.50:4700" } });
      expect(res.status).toBe(403);
    });
  });

  describe("token 認證", () => {
    const TOKEN = "test-secret-token-value";

    it("無 Authorization → 401,且回應不含 token 值", async () => {
      const { app } = tmpApp({ token: TOKEN });
      const res = await app.request("/api/health");
      expect(res.status).toBe(401);
      const text = await res.text();
      expect(JSON.parse(text).error.code).toBe("UNAUTHORIZED");
      expect(text).not.toContain(TOKEN);
    });

    it("錯誤 token → 401;正確 token → 200", async () => {
      const { app } = tmpApp({ token: TOKEN });
      const bad = await app.request("/api/health", { headers: { authorization: "Bearer wrong" } });
      expect(bad.status).toBe(401);
      const ok = await app.request("/api/health", { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(ok.status).toBe(200);
    });

    it("寫入路徑同樣被擋,且未寫入任何東西", async () => {
      const { app } = tmpApp({ token: TOKEN });
      const res = await app.request("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "未授權寫入" }),
      });
      expect(res.status).toBe(401);
      const list = await app.request("/api/tasks", { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(((await list.json()) as unknown[]).length).toBe(0);
    });

    it("非 /api/* 路徑不要求 token(登入頁本身要能載入)", async () => {
      const { app } = tmpApp({ token: TOKEN });
      const res = await app.request("/nope");
      expect(res.status).toBe(404); // 走到 notFound,而不是 401
    });

    it("未設定 token 時一切照舊(現狀不變)", async () => {
      const { app } = tmpApp();
      expect((await app.request("/api/health")).status).toBe(200);
    });
  });

  // 錯誤映射是每條資源路由都倚賴的東西 —— 必須有自己的測試,
  // 不能只靠 notFound 兜底那條路徑順帶證明。
  describe("error mapping", () => {
    it("op input error → 400 INVALID_INPUT", async () => {
      const { app, ctx } = tmpApp();
      app.get("/api/boom", () => {
        runOp(ctx, "read.tasks", { status: "Nope" });
        return new Response("unreachable");
      });
      const res = await app.request("/api/boom");
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("INVALID_INPUT");
      expect(body.error.message).toContain("status");
    });

    // async handler 也必須走同一條翻譯:Task 2 的路由會 await request body。
    it("not-found error from an async handler → 404 NOT_FOUND", async () => {
      const { app, ctx } = tmpApp();
      app.get("/api/boom", async () => {
        await Promise.resolve();
        runOp(ctx, "read.project-context", { projectId: 999 });
        return new Response("unreachable");
      });
      const res = await app.request("/api/boom");
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe("NOT_FOUND");
      expect(body.error.message).toContain("999");
    });

    it("unclassified error → 500 OP_FAILED", async () => {
      const { app } = tmpApp();
      app.get("/api/boom", () => {
        throw new Error("kaboom");
      });
      const res = await app.request("/api/boom");
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toEqual({ code: "OP_FAILED", message: "kaboom" });
    });
  });
});
