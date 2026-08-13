import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startServer,
  isLoopback,
  interfaceHosts,
  parseAllowedHosts,
  listenUrls,
} from "../src/server/main.ts";
import { isolateLanEnv } from "./env-isolation.ts";

// 檔案層級:startServer() 沒收到 opts 的欄位就讀 env,所以每一條測試(不只 lan 那組)
// 都會被開發機上外流的 LCOS_HOST / LCOS_TOKEN 改變行為。
isolateLanEnv();

let closer: (() => void) | undefined;
// 先清掉再呼叫:重跑同一個 closer 會撞上 ERR_SERVER_NOT_RUNNING,
// 那個錯誤會蓋掉測試本身真正的失敗原因。
afterEach(() => {
  const c = closer;
  closer = undefined;
  c?.();
});

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), "lcos-db-")), "t.db");
}

function tmpWeb(): string {
  const dir = mkdtempSync(join(tmpdir(), "lcos-web-"));
  writeFileSync(join(dir, "index.html"), "<title>LCOS</title>");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "x.js"), "// js");
  return dir;
}

/**
 * 走 node:http 而不是 fetch:要驗的正是「Host 是區網位址時 allow-list 放行」,
 * 而 undici 會用連線的目標位址覆寫掉自訂的 host header —— 那樣測到的永遠是 127.0.0.1。
 */
function rawGet(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((res, rej) => {
    const req = http.get({ host: "127.0.0.1", port, path, headers }, (r) => {
      let body = "";
      r.setEncoding("utf8");
      r.on("data", (c: string) => (body += c));
      r.once("end", () => res({ status: r.statusCode ?? 0, body }));
    });
    req.once("error", rej);
  });
}

describe("startServer", () => {
  it("serves api and static with SPA fallback", async () => {
    const s = await startServer({ port: 0, dbPath: tmpDb(), webDist: tmpWeb() });
    closer = s.close;
    const base = `http://127.0.0.1:${s.port}`;
    expect((await (await fetch(`${base}/api/health`)).json()).ok).toBe(true);
    expect(await (await fetch(`${base}/assets/x.js`)).text()).toContain("js");
    // SPA fallback:未知路徑回 index.html
    expect(await (await fetch(`${base}/tasks`)).text()).toContain("LCOS");
    // /api 未知路徑仍是 JSON 404,不 fallback。只驗 status 不夠:
    // 回 index.html 的話 status 也可能被改成 404,body 才問得出有沒有走錯分支。
    const miss = await fetch(`${base}/api/nope`);
    expect(miss.status).toBe(404);
    expect((await miss.json()).error.code).toBe("NOT_FOUND");
  });

  it("skips static mounting when webDist is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lcos-db-"));
    const s = await startServer({ port: 0, dbPath: join(dir, "t.db"), webDist: join(dir, "nope") });
    closer = s.close;
    const base = `http://127.0.0.1:${s.port}`;
    expect((await (await fetch(`${base}/api/health`)).json()).ok).toBe(true);
    // 沒有 dist 就沒有 SPA fallback:非 API 路徑落到 createApp 的純文字 404
    const res = await fetch(`${base}/tasks`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found");
  });

  it("releases the db handle when listen fails", async () => {
    const first = await startServer({ port: 0, dbPath: tmpDb() });
    closer = first.close;

    const db = tmpDb();
    await expect(startServer({ port: first.port, dbPath: db })).rejects.toThrow(/EADDRINUSE/);

    // 連線真的關掉的證據:WAL 模式下 SQLite 會在最後一個連線關閉時刪掉 -wal/-shm。
    // 檔案還在就代表那個 handle(連同它的 fd)還被 leak 的 ctx 抓著。
    expect(existsSync(`${db}-wal`)).toBe(false);
    expect(existsSync(`${db}-shm`)).toBe(false);
  });

  // 埠號超出範圍時 serve() 是「同步」丟 ERR_SOCKET_BAD_PORT,不是 reject ——
  // 只包住 await 的 try/catch 接不到,ctx 就跟著漏掉。
  // (openDb 會跑 migration,所以進到這裡時 -wal/-shm 必定已經存在,這個斷言不會是空的。)
  it("releases the db handle when serve() throws synchronously", async () => {
    const db = tmpDb();
    await expect(startServer({ port: 470000, dbPath: db })).rejects.toThrow();
    expect(existsSync(`${db}-wal`)).toBe(false);
    expect(existsSync(`${db}-shm`)).toBe(false);
  });
});

describe("lan access 純函式", () => {
  const FAKE_IFACES = {
    lo0: [
      { address: "127.0.0.1", family: "IPv4", internal: true },
      { address: "::1", family: "IPv6", internal: true },
    ],
    en0: [
      { address: "192.168.1.23", family: "IPv4", internal: false },
      { address: "FE80::1", family: "IPv6", internal: false },
    ],
    down: undefined,
  };

  it("isLoopback 認得 loopback 家族(含大小寫與 IPv6 兩種寫法)", () => {
    for (const h of ["127.0.0.1", "localhost", "LOCALHOST", "::1", "[::1]"]) {
      expect(isLoopback(h), h).toBe(true);
    }
    for (const h of ["0.0.0.0", "192.168.1.23", "::"]) {
      expect(isLoopback(h), h).toBe(false);
    }
  });

  // internal 位址一律留著:allow-list 要放行的正是「自己連自己」的那些 Host。
  it("interfaceHosts 轉出 Host 形態(IPv6 小寫加中括號),含 internal,undefined 介面跳過", () => {
    expect(interfaceHosts(FAKE_IFACES)).toEqual(["127.0.0.1", "[::1]", "192.168.1.23", "[fe80::1]"]);
  });

  it("parseAllowedHosts 逗號分隔、trim、小寫、去空", () => {
    expect(parseAllowedHosts(" MyHost.local , 192.168.1.9 ,,")).toEqual([
      "myhost.local",
      "192.168.1.9",
    ]);
    expect(parseAllowedHosts(undefined)).toEqual([]);
    expect(parseAllowedHosts("")).toEqual([]);
  });

  // 0.0.0.0 那一列是要貼給別台電腦用的:loopback / docker / utun 這些 internal 位址
  // 從別台永遠連不上,列出來只會讓人一個個試錯。
  it("listenUrls:loopback → 127.0.0.1;0.0.0.0 → 只列非 internal IPv4;特定 IP → 該 IP", () => {
    expect(listenUrls("127.0.0.1", 4700, FAKE_IFACES as never)).toEqual(["http://127.0.0.1:4700"]);
    expect(listenUrls("0.0.0.0", 4700, FAKE_IFACES as never)).toEqual([
      "http://192.168.1.23:4700",
    ]);
    expect(listenUrls("::", 4700, FAKE_IFACES as never)).toEqual(["http://192.168.1.23:4700"]);
    expect(listenUrls("192.168.1.23", 4700, FAKE_IFACES as never)).toEqual([
      "http://192.168.1.23:4700",
    ]);
  });
});

describe("lan access 接線", () => {
  // env 隔離在檔案最上方的 isolateLanEnv():這一組會自己設 LCOS_HOST / LCOS_TOKEN,
  // 靠它的 beforeEach 清乾淨,不讓值外溢到下一條。

  it("非 loopback 且無 token → 拒絕啟動", async () => {
    const db = tmpDb();
    await expect(startServer({ port: 0, host: "0.0.0.0", dbPath: db })).rejects.toThrow(
      /LCOS_TOKEN/,
    );
    // 閘門在 openDb 之前:擋下時連 DB 都不該被開過(開過就會留下 -wal/-shm)。
    expect(existsSync(db)).toBe(false);
  });

  it("LCOS_TOKEN 是空白字串等同沒設 → 一樣拒絕啟動", async () => {
    // `LCOS_TOKEN=` 或只打了空白時,opts.token: "" 會讓 app 層的驗證中介層靜靜地不掛上,
    // 於是「有開 token」是假的 —— 這種寫法必須落在閘門這邊被擋下,而不是啟動後才發現裸奔。
    process.env.LCOS_HOST = "0.0.0.0";
    process.env.LCOS_TOKEN = "   ";
    await expect(startServer({ port: 0, dbPath: tmpDb() })).rejects.toThrow(/LCOS_TOKEN/);
  });

  it("非 loopback + token → 可啟動,回報 urls,LAN Host + token 可通", async () => {
    const s = await startServer({
      port: 0,
      host: "0.0.0.0",
      token: "sekret",
      dbPath: tmpDb(),
    });
    closer = s.close;
    expect(s.urls.length).toBeGreaterThan(0);
    expect(s.urls[0]).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/);
    // 用本機介面 IP 當 Host 打進去:allow-list 應已含所有介面位址
    const lan = interfaceHosts(os.networkInterfaces()).find(
      (h) => !h.startsWith("[") && h !== "127.0.0.1",
    );
    const host = `${lan ?? "127.0.0.1"}:${s.port}`;
    const unauth = await rawGet(s.port, "/api/health", { host });
    expect(unauth.status).toBe(401);
    const ok = await rawGet(s.port, "/api/health", { host, authorization: "Bearer sekret" });
    expect(ok.status).toBe(200);
  });

  // 登入頁必須在沒有 token 的情況下載得進來,而同一個瀏覽器對 /api/* 必須拿到 401 ——
  // 兩者任一反過來,整條 LAN 流程就斷了(頁面載不進去 = 沒地方輸入金鑰;
  // API 不擋 = token 形同虛設)。這條走真的 server + 真的 dist,不是 app.request()。
  it("開 token 時:登入頁(靜態)照常送出,/api/* 401", async () => {
    const dist = tmpWeb();
    const s = await startServer({
      port: 0,
      host: "0.0.0.0",
      token: "sekret",
      dbPath: tmpDb(),
      webDist: dist,
    });
    closer = s.close;
    const host = `127.0.0.1:${s.port}`;
    const page = await rawGet(s.port, "/", { host });
    expect(page.status).toBe(200);
    expect(page.body).toContain("LCOS");
    const api = await rawGet(s.port, "/api/health", { host });
    expect(api.status).toBe(401);
  });

  it("預設(未給 host)仍綁 127.0.0.1 且免 token(現狀不變)", async () => {
    const s = await startServer({ port: 0, dbPath: tmpDb() });
    closer = s.close;
    expect(s.urls).toEqual([`http://127.0.0.1:${s.port}`]);
    expect((await fetch(`http://127.0.0.1:${s.port}/api/health`)).status).toBe(200);
  });
});
