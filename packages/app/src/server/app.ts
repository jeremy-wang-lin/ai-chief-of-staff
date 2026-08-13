import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Ctx, ErrorCode, Snapshot } from "@lcos/core";
import { runOp, errorCode } from "@lcos/core";
import { mountRoutes } from "./routes.ts";

/**
 * 刻意用 Record<ErrorCode, …> 而非 Record<string, …>:core 哪天多一個錯誤碼,
 * 這裡必須是編譯錯誤。用 string 當 key 的話漏掉的碼會查成 undefined,
 * 而 c.json(body, undefined) 會安靜地回 200 —— 錯誤被當成成功是最糟的失敗模式。
 */
const STATUS: Record<ErrorCode, ContentfulStatusCode> = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  // 外部 Jira 讀不到是暫時性降級,不是本服務故障 —— 503 而非 500,呼叫端才知道值得重試。
  JIRA_UNAVAILABLE: 503,
  OP_FAILED: 500,
};

/**
 * 只擋寫入。GET 不改變任何東西,而跨站讀到的回應本來就會被同源政策關在對方的 JS 之外;
 * 連讀都擋只會多一條在別處壞掉的規則(書籤、瀏覽器擴充、貼到別頁的連結),換不到實際的保護。
 */
const WRITES = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/**
 * 只綁 127.0.0.1 擋得住區網,擋不住瀏覽器:任何一個網頁都能對 http://127.0.0.1:4700
 * 送出跨站的寫入請求,而請求會帶著這台機器的身分抵達。這裡沒有 cookie 或 token 可偷,
 * 會被偷走的是「寫入」本身 —— 一個外部頁面可以靜靜地刪掉你的任務。
 *
 * 判準是主機而不是完整 origin:本機開發時瀏覽器在 5173、server 在 4700,
 * 埠不同是常態(Vite 的 /api proxy)。要防的是外部網頁,不是本機的另一個埠,
 * 所以 localhost / 127.0.0.1 / ::1 一律放行,其餘必須與這台 server 自己的 host 相同。
 */
/**
 * localhost 家族永遠放行 —— 不管有沒有開放區網,自己這台機器叫自己都必須通。
 * 開放區網時經 `allowedHosts` 傳入的額外主機名(本機介面 IP、設定的主機名)一併放行,
 * rebinding 防護的語意不變:清單是呼叫端明確列出的,攻擊者的網域不會出現在裡面。
 *
 * IPv6 只收帶中括號的 `[::1]`:Host header 的規則就是括起來(不括的話冒號無從分辨埠號),
 * 而 hostname() 也永遠產不出裸的 `::1` —— 放一個進去只會是一行沒人會發現已經死掉的程式碼。
 */
const BASE_HOST_ALLOW = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface AppOptions {
  /** 除 localhost 家族外額外放行的 Host(不含埠;IPv6 需帶中括號)。 */
  allowedHosts?: string[];
  /** 設定後所有 /api/* 要求 `Authorization: Bearer <token>`,否則 401。 */
  token?: string;
}

/**
 * "127.0.0.1:4700" → "127.0.0.1";"[::1]:4700" → "[::1]"(IPv6 的冒號不能當埠號的分隔)。
 * 轉小寫:主機名不分大小寫。真實 server 前面那層會先 400 掉大小寫不一致的 Host,
 * 這裡轉小寫換到的是「不依賴上游」—— 少一個換了 adapter 就靜靜失效的假設。
 *
 * 逗號或空白一律回空字串(= 必定落在 allow-list 之外):兩個 Host header 會被中間層
 * 併成 "localhost:4700, evil.example",而 split(":")[0] 只看得到前半,於是放行。
 * 今天的 Node 會自己擋掉重複 Host,但那是上游的性質不是我們的 —— 擺一個 proxy 在前面就沒了。
 * 尾綴點(`127.0.0.1.`)也一併落空:那是合法的 FQDN 寫法,但擋掉只會少一種寫法,放過卻是漏洞。
 */
function hostname(host: string): string {
  if (/[,\s]/.test(host)) return "";
  const h = host.toLowerCase();
  return h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.split(":")[0];
}

function allowedOrigin(origin: string, self: string): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    // 解析不出來的 Origin(含 "null" —— sandboxed iframe 與部分跨站導向會送這個)一律不放行
    return false;
  }
  if (u.host === self) return true;
  return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
}

/**
 * 先各自 SHA-256 再 timingSafeEqual:後者要求等長 buffer,直接比原文會先洩漏長度,
 * 而長度不等時的 early-return 本身就是 timing 差異。雜湊等長化之後,比對時間與內容無關。
 */
function tokenMatches(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** API 層零商業邏輯:解參數 → runOp → JSON。錯誤統一在此翻譯。 */
export function createApp(ctx: Ctx, opts: AppOptions = {}): Hono {
  const app = new Hono();

  // 額外項一律轉小寫,與 hostname() 的輸出對齊 —— 主機名不分大小寫。
  const hostAllow = new Set([
    ...BASE_HOST_ALLOW,
    ...(opts.allowedHosts ?? []).map((h) => h.toLowerCase()),
  ]);

  app.onError((e, c) => {
    const code = errorCode(e);
    return c.json({ error: { code, message: (e as Error).message } }, STATUS[code]);
  });

  /**
   * DNS rebinding 防護,擋所有方法與所有路徑(含之後的靜態檔 —— 攻擊要的正是把資料讀出去)。
   *
   * 惡意網域先把自己的 A record 指向 127.0.0.1,瀏覽器於是把本服務當成 evil.example 的
   * 「同源」來讀。origin 檢查在這裡完全無效:同源請求根本不帶 Origin。
   * 還說實話的只剩 Host header —— 瀏覽器一律照它連的網域填,而那不會是 localhost 家族。
   *
   * 沒有 Host header 時退回看 c.req.url 的 host,而這在真實 server 上**等於放行**:
   * @hono/node-server 缺 Host 就拿自己綁定的位址(127.0.0.1)去組 URL,組出來的必然在清單裡。
   * 支撐這個決定的只有一件事 —— 瀏覽器在 HTTP/1.1 一律送 Host,而 rebinding 攻擊的載體
   * 就是瀏覽器;送不出 Host 的呼叫端根本不受同源政策約束,擋它換不到任何安全。
   *
   * 退路仍有一個真的會擋下的情況:absolute-form 的請求行(`GET http://evil.example/x HTTP/1.0`)。
   * adapter 這時直接用那個絕對 URL,c.req.url 的 host 就是攻擊者的網域 → 403。
   *
   * `pnpm web:dev` 不能靠這一層:請求先到 Vite(5173)再被 proxy 轉過來,而 Host 是什麼
   * 完全取決於 proxy 的設定 —— 一旦開了 changeOrigin,送到這裡的 Host 永遠是 4700 那端,
   * 這個檢查就等於不存在。dev 模式真正的 rebinding 防線是 Vite 自己的 server.allowedHosts
   * (預設就擋陌生 Host)—— 所以那個設定不能為了圖方便設成 true。
   */
  app.use("*", async (c, next) => {
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    if (!hostAllow.has(hostname(host))) {
      return c.json(
        { error: { code: "FORBIDDEN_HOST", message: `unexpected host: ${host}` } },
        403,
      );
    }
    await next();
  });

  /**
   * 只護 /api/*:靜態 SPA 是公開程式碼不是資料,登入頁本身需要能載入。
   * 掛在 host 檢查之後(rebinding 先擋)、origin 檢查之前。
   * 401 訊息固定字串:任何回顯請求內容的訊息都是把探測結果送回去。
   */
  if (opts.token) {
    const expected = opts.token;
    app.use("/api/*", async (c, next) => {
      const auth = c.req.header("authorization") ?? "";
      const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
      if (!provided || !tokenMatches(provided, expected)) {
        return c.json(
          { error: { code: "UNAUTHORIZED", message: "missing or invalid access token" } },
          401,
        );
      }
      await next();
    });
  }

  // 掛在所有路由之前:攔在 handler 之外才叫擋下來 —— 回了 403 卻已經寫進 DB 是最糟的結果。
  app.use(async (c, next) => {
    const origin = c.req.header("origin");
    // 沒有 Origin 的一律放行:curl、lcos、腳本都不送這個標頭,而它們本來就不受同源政策約束。
    if (origin && WRITES.has(c.req.method) && !allowedOrigin(origin, new URL(c.req.url).host)) {
      return c.json(
        { error: { code: "FORBIDDEN_ORIGIN", message: `cross-origin write refused: ${origin}` } },
        403,
      );
    }
    await next();
  });

  app.get("/api/health", (c) => {
    const snap = runOp(ctx, "read.snapshot", {}) as Snapshot;
    return c.json({ ok: true, today: snap.today, latestBriefing: snap.latestBriefing });
  });

  mountRoutes(app, ctx);

  // 兜底 404 只對 /api/ 回 JSON:API 的呼叫方解析 JSON,而瀏覽器要的是頁面。
  // 非 /api/ 的路徑先回純文字,Task 3 的 SPA fallback 會接手。
  app.notFound((c) =>
    c.req.path.startsWith("/api/")
      ? c.json({ error: { code: "NOT_FOUND", message: `no route: ${c.req.path}` } }, 404)
      : c.text("not found", 404),
  );

  return app;
}
