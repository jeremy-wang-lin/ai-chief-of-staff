import { serve, type ServerType } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import type { AddressInfo } from "node:net";
import { openDb, closeDb, resolveDbPath } from "@lcos/core";
import { createApp } from "./app.ts";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host.toLowerCase());
}

/**
 * 介面位址 → Host header 形態的主機名。IPv6 加中括號:Host 的規則就是括起來,
 * 與 app.ts 的 hostname() 解析對齊;一律小寫,與 allow-list 的正規化對齊。
 *
 * 這裡刻意不濾 internal(與 listenUrls 相反):產出的是 allow-list,
 * 而「自己連自己」用的正是 127.0.0.1 這類 internal 位址,濾掉會把本機請求擋成 403。
 */
export function interfaceHosts(
  ifaces: Record<string, { address: string; family: string }[] | undefined>,
): string[] {
  return Object.values(ifaces)
    .flatMap((list) => list ?? [])
    .map((i) => (i.family === "IPv6" ? `[${i.address.toLowerCase()}]` : i.address));
}

export function parseAllowedHosts(env: string | undefined): string[] {
  return (env ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * 啟動訊息用:這個綁定實際可以從哪些 URL 連上。
 *
 * 綁 0.0.0.0 時只列非 internal 的 IPv4:這一列是要唸給「另一台電腦」用的,
 * 而 loopback、docker 橋接、utun(VPN)這些 internal 位址從別台永遠連不上。
 * 全列出來的話使用者只能一個個試,而失敗長得跟服務沒起來一模一樣。
 */
export function listenUrls(
  host: string,
  port: number,
  ifaces: Record<
    string,
    { address: string; family: string; internal: boolean }[] | undefined
  > = os.networkInterfaces(),
): string[] {
  if (isLoopback(host)) return [`http://127.0.0.1:${port}`];
  if (host === "0.0.0.0" || host === "::") {
    return Object.values(ifaces)
      .flatMap((list) => list ?? [])
      .filter((i) => !i.internal && i.family === "IPv4")
      .map((i) => `http://${i.address}:${port}`);
  }
  return [`http://${host}:${port}`];
}

export interface StartedServer {
  server: ServerType;
  /** 實際綁定的埠;傳 port: 0 時由 OS 指派,只有這裡問得到。 */
  port: number;
  /** 這個綁定實際可連的 URL(loopback 一個;0.0.0.0 列出所有 IPv4 介面)。 */
  urls: string[];
  close(): void;
}

export interface StartServerOptions {
  port?: number;
  host?: string;
  token?: string;
  dbPath?: string;
  webDist?: string;
}

export async function startServer(opts: StartServerOptions = {}): Promise<StartedServer> {
  // 預設只綁 127.0.0.1:預設值必須是「筆電帶去咖啡廳也不會把資料庫端出去」的那一個。
  // 開放區網是顯式選擇(LCOS_HOST),而顯式開放必須同時有 token —— 裸奔要做不到,而不是靠記得。
  const host = opts.host ?? (process.env.LCOS_HOST || "127.0.0.1");
  // 空白一律當「沒設」:createApp 只在 token 為 truthy 時才掛驗證中介層,
  // 所以 `LCOS_TOKEN=`(或只打了空白)換到的是「以為有 token、其實整台裸奔」——
  // 最該被閘門擋下的正是這個情況,而不是讓它安靜地啟動。
  const token = (opts.token ?? process.env.LCOS_TOKEN ?? "").trim() || undefined;
  // 閘門在 openDb 之前:擋下時連一個開著的 DB handle 都不該留下。
  if (!isLoopback(host) && !token) {
    throw new Error(
      "LCOS_HOST 開放非本機位址時必須設定 LCOS_TOKEN(建議 openssl rand -hex 32);拒絕啟動。",
    );
  }
  // loopback 綁定不需要額外 allow-list:createApp 的 BASE_HOST_ALLOW 已涵蓋 localhost 家族。
  const allowedHosts = isLoopback(host)
    ? []
    : [
        ...interfaceHosts(os.networkInterfaces()),
        ...parseAllowedHosts(process.env.LCOS_ALLOWED_HOSTS),
      ];

  const ctx = openDb(opts.dbPath ?? resolveDbPath());
  const app = createApp(ctx, { allowedHosts, token });

  const dist = opts.webDist ?? join(process.cwd(), "packages", "web", "dist");
  if (existsSync(dist)) {
    // serveStatic 的 root 相對於 process.cwd() 解析;絕對路徑(測試的 tmp 目錄)先轉相對。
    const root = isAbsolute(dist) ? relative(process.cwd(), dist) : dist;
    app.use("/*", serveStatic({ root }));
    // 註冊在靜態服務之後:檔案沒命中才輪到 SPA fallback。
    // /api/* 一律交回 createApp 的 notFound(JSON 404),絕不回 index.html ——
    // API 呼叫方拿到一份 HTML 當成回應,比拿到 404 更難查。
    app.get("*", (c) => {
      if (c.req.path.startsWith("/api/")) return c.notFound();
      return c.html(readFileSync(join(dist, "index.html"), "utf8"));
    });
  }

  // `LCOS_PORT=`(空字串)或打錯字時 Number() 給的是 NaN 或 0,兩者都會讓 OS 隨便挑一個埠 ——
  // 服務起來了、瀏覽器卻連不到約定的位置,是最不容易聯想到 env 打錯的失敗模式。
  // opts.port 用 ?? 接,測試才傳得進明確的 0(要求 OS 指派)。
  // 上界一起擋:`LCOS_PORT=470000`(多打一個零)過得了整數與正數檢查,卻會讓 serve() 同步爆掉。
  const envPort = Number(process.env.LCOS_PORT);
  const port =
    opts.port ?? (Number.isInteger(envPort) && envPort > 0 && envPort < 65536 ? envPort : 4700);

  // serve() 本身也在 try 裡:埠號超出範圍時它是「同步」丟 ERR_SOCKET_BAD_PORT,
  // 只包住 await 的話那條路徑一樣會漏掉 ctx。
  let server: ServerType | undefined;
  let actual: number;
  try {
    server = serve({ fetch: app.fetch, port, hostname: host });
    actual = await listeningPort(server);
  } catch (e) {
    // 走到這裡 DB 已經開著了。不收掉的話呼叫端只接到例外,
    // 而那組 fd(db、-wal、-shm)會安靜地跟著 process 活到最後。
    server?.close();
    closeDb(ctx);
    throw e;
  }

  return {
    server,
    port: actual,
    urls: listenUrls(host, actual),
    close: () => {
      // 先 server 後 db。server.close() 並不會排空處理中的請求,所以這個順序不是保證;
      // 真正讓它安全的是 runOp 全同步 —— 不存在「await 到一半、handle 已經關掉」的請求。
      server.close();
      closeDb(ctx);
    },
  };
}

/**
 * listen() 是非同步的:serve() 回來的當下 address() 還是 null,
 * 所以埠號必須等 listening 事件 —— 同步讀會拿到 null 而炸在呼叫端。
 */
function listeningPort(server: ServerType): Promise<number> {
  return new Promise((res, rej) => {
    const addr = server.address();
    if (addr && typeof addr === "object") return res(addr.port);
    const onError = (e: Error) => rej(e);
    server.once("error", onError);
    server.once("listening", () => {
      server.removeListener("error", onError);
      res((server.address() as AddressInfo).port);
    });
  });
}

// 直接執行時啟動(tsx packages/app/src/server/main.ts)。
// 比對自身路徑而不是 endsWith("main.ts"):後者對 cli/main.ts 也成立。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await startServer();
  console.log(JSON.stringify({ listening: s.urls }));
  // Ctrl-C 是這支服務唯一的正常結束方式。沒有這段的話 sqlite 連線不會走 close(),
  // -wal 留在磁碟上等下一個開檔的人做 recovery —— 能還原,但那是靠運氣而不是靠設計。
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      s.close();
      process.exit(0);
    });
  }
}
