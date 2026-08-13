#!/usr/bin/env tsx
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, closeDb, resolveDbPath } from "@lcos/core";
import { buildMcpServer } from "./build.ts";

/**
 * stdio 模式下 stdout 是 JSON-RPC 的協定通道:任何 console.log 都會被對方當成一則畸形訊息,
 * 連線直接壞掉。要輸出診斷訊息只能走 stderr。
 */
export async function startMcpServer(): Promise<void> {
  const ctx = openDb(resolveDbPath());
  const shutdown = () => {
    // 不收掉的話 sqlite 的 -wal/-shm 留在磁碟上等下一個開檔的人做 recovery。
    closeDb(ctx);
    process.exit(0);
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, shutdown);
  await buildMcpServer(ctx).connect(new StdioServerTransport());
}

// 直接執行時啟動(tsx packages/app/src/mcp/main.ts)。
// 比對自身路徑而不是 endsWith("main.ts"):後者對 cli/main.ts 與 server/main.ts 也成立。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startMcpServer();
}
