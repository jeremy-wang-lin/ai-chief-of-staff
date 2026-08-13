import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDb, ops } from "@lcos/core";
import { buildMcpServer } from "../src/mcp/build.ts";

async function connected() {
  const dir = mkdtempSync(join(tmpdir(), "lcos-mcp-"));
  const ctx = openDb(join(dir, "t.db"));
  const server = buildMcpServer(ctx);
  const client = new Client({ name: "test", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, ctx };
}

function text(res: any): any { return JSON.parse(res.content[0].text); }

describe("MCP server", () => {
  it("exposes every registry op as a tool", async () => {
    const { client } = await connected();
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(ops.map((o) => o.mcpName).sort());
    const create = tools.find((t) => t.name === "create_task")!;
    expect(create.description).toBeTruthy();
    expect(create.inputSchema.properties).toHaveProperty("title"); // zod shape → JSON Schema
    // 廣告出去的 schema 必須與註冊表逐字相符:必填清單與 strict()(= additionalProperties:false)
    // 都得留著,否則呼叫端只能靠試錯才知道哪些欄位不能少、哪些名字根本不存在。
    expect(create.inputSchema.required).toContain("title");
    expect(create.inputSchema.additionalProperties).toBe(false);
  });

  it("unknown argument → isError with INVALID_INPUT (註冊表的 strict 一路守到 MCP)", async () => {
    const { client } = await connected();
    const res: any = await client.callTool({ name: "create_task", arguments: { title: "x", bogus: 1 } });
    expect(res.isError).toBe(true);
    expect(text(res).error.code).toBe("INVALID_INPUT");
  });

  it("tool call roundtrip: create then query", async () => {
    const { client } = await connected();
    const created = text(await client.callTool({ name: "create_task", arguments: { title: "來自 MCP", priority: "P1" } }));
    expect(created.priority).toBe("P1");
    const listed = text(await client.callTool({ name: "query_tasks", arguments: { priority: "P1" } }));
    expect(listed).toHaveLength(1);
  });

  it("validation error → isError with INVALID_INPUT", async () => {
    const { client } = await connected();
    const res: any = await client.callTool({ name: "create_task", arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res).error.code).toBe("INVALID_INPUT");
  });

  it("not found → isError with NOT_FOUND", async () => {
    const { client } = await connected();
    const res: any = await client.callTool({ name: "get_task", arguments: { id: 999 } });
    expect(res.isError).toBe(true);
    expect(text(res).error.code).toBe("NOT_FOUND");
  });
});
