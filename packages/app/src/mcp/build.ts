import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import type { Ctx } from "@lcos/core";
import { ops, runOp, errorCode } from "@lcos/core";

/**
 * SDK 會拿 inputSchema 先驗一次參數,不通過就自己回一段純文字錯誤,handler 根本不會被呼叫。
 * 那條路徑繞過了 runOp,MCP 的驗證錯誤於是變成沒有錯誤碼的散文 —— 與 CLI/REST 兩個投影
 * 對同一個 op、同一份 schema 給出不同形狀的失敗,正是註冊表要消滅的漂移。
 *
 * 所以交給 SDK 的是一層委派:JSON Schema 仍由真正的 op schema 導出(欄位、必填、enum、
 * additionalProperties:false 一字不差),但 parse 一律放行,把驗證權留在 runOp 手上。
 * 用 Object.create 而非複製,是為了讓 `_def`/`.shape`/instanceof 都仍指向原 schema —— SDK
 * 產 JSON Schema 讀的就是這些。
 */
function delegatingSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  const relay = Object.create(schema) as z.ZodTypeAny;
  relay.safeParse = ((data: unknown) => ({ success: true, data })) as z.ZodTypeAny["safeParse"];
  relay.safeParseAsync = (async (data: unknown) => ({ success: true, data })) as z.ZodTypeAny["safeParseAsync"];
  return relay;
}

/** 註冊表第三投影:每個 op 一個 MCP tool,名稱/說明/schema 全部取自註冊表,介面層不自帶知識。 */
export function buildMcpServer(ctx: Ctx): McpServer {
  const server = new McpServer({ name: "lcos", version: "0.1.0" });
  for (const op of ops) {
    server.registerTool(
      op.mcpName,
      { description: op.desc, inputSchema: delegatingSchema(op.input) },
      async (args: Record<string, unknown>) => {
        try {
          // handler 未來可能有非同步的(await 非 Promise 值無害),這裡先 await 再序列化。
          const result = await runOp(ctx, op.name, args);
          return { content: [{ type: "text" as const, text: JSON.stringify(result ?? { ok: true }, null, 2) }] };
        } catch (e) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: JSON.stringify({ error: { code: errorCode(e), message: (e as Error).message } }) }],
          };
        }
      },
    );
  }
  return server;
}
