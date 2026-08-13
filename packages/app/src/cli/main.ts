#!/usr/bin/env tsx
import { Command, CommanderError } from "commander";
import { readFileSync, writeSync } from "node:fs";
import {
  openDb, ops, runOp, errorCode, inputFields, resolveDbPath,
  type InputField, type Op,
} from "@lcos/core";

/**
 * lcos CLI —— 註冊表的一種投影,不是第二份操作清單。
 * 這個檔案裡不得出現任何硬編的操作名稱、旗標名稱或參數說明:
 * 子指令樹來自 op.cliPath,旗標來自 core 的 inputFields(op),說明來自 op.desc。
 * 值域判讀、錯誤分類、DB 路徑一律留在 core/projection.ts —— MCP 之後要吃的是同一份事實,
 * 而不是在這裡再複製一份 instanceof zod 的邏輯,然後兩邊各自漂移。
 */

/**
 * 錯誤一律是 stderr 的 JSON + exit 1;呼叫端(人或 agent)只需要 parse 一種格式。
 * 用 writeSync 而非 console.error:macOS 上 pipe 的寫入是非同步的,
 * 緊接著的 process.exit() 會把還沒 flush 的訊息整段吃掉 —— 而錯誤訊息正是最不能掉的東西。
 */
function fail(code: string, message: string): never {
  writeSync(2, `${JSON.stringify({ error: { code, message } })}\n`);
  process.exit(1);
}

/** --projectId 打起來很痛;對外一律 kebab,commander 會在 opts() 轉回 camelCase。 */
function toFlag(key: string): string {
  return key.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`);
}

/** 讓 --help 直接看得到列舉的合法值,省掉「試一次、被 zod 罵、再查一次」的來回。 */
function hint(f: InputField): string {
  const type = f.kind === "enum" ? f.options!.join("|")
    : f.kind === "boolean" ? "true|false"
    : f.kind;
  return f.required ? `${type}, required` : type;
}

const program = new Command("lcos")
  .description("AI chief of staff —— local-first 工作管理 CLI(所有輸出皆為 JSON)");
// commander 預設會自己印一行文字錯誤然後 exit;兩者都要攔下來,
// 否則 stderr 會是「文字 + JSON」的混合物,呼叫端一 parse 就炸。
program.exitOverride();
program.configureOutput({ writeErr: () => {} });

/** 依 cliPath 掛出子指令樹,中繼節點(read / write / …)重複使用同一個 Command。 */
function mount(op: Op): Command {
  let parent = program;
  for (const seg of op.cliPath.slice(0, -1)) {
    parent = parent.commands.find(c => c.name() === seg)
      // 中繼節點沒有自己的操作,但 help 裡不能只留一個沒下文的裸名字。
      ?? parent.command(seg).description(`執行 lcos ${seg} --help 查看子指令`);
  }
  return parent.command(op.cliPath[op.cliPath.length - 1]!).description(op.desc);
}

for (const op of ops) {
  const fields = inputFields(op);
  const cmd = mount(op);
  // 陣列欄位不產旗標:重複的 --lines 既冗長又會被 shell 咬,一律改由 --file 讀檔。
  // 判準取自 core 的 kind === "array" 而不是欄位名字 —— 認名字等於在 CLI 這頭
  // 再開一份「哪些欄位特別」的清單,而那正是兩邊漂移的起點。
  const arrayField = fields.find(f => f.kind === "array");
  for (const f of fields) {
    if (f.kind === "array") continue;
    // 布林值收 optional argument:`--overdue` 就是 true(旗標本來的用法),
    // 同時保留 `--overdue false` —— 少了後者就沒辦法明確關掉一個帶預設的條件。
    cmd.option(`--${toFlag(f.key)} ${f.kind === "boolean" ? "[value]" : "<value>"}`, hint(f));
  }
  // 內文往往是多行 Markdown,塞進 shell 參數既難讀又容易被跳脫字元咬到。
  if (fields.some(f => f.key === "bodyMd")) cmd.option("--body-file <path>", "讀取檔案內容作為 bodyMd");
  // 一個 op 至多一個陣列欄位(projection 測試守住這個不變條件),所以 --file 不必再指明對象。
  if (arrayField) cmd.option("--file <path>", `讀取檔案,每行一個 ${arrayField.key} 元素(空行略過)`);

  cmd.action(async () => {
    const flags = cmd.opts<Record<string, string | boolean | undefined>>();
    // schema 是 .strict() 的,所以只挑得出 schema 認得的 key —— --body-file
    // 和 commander 自己的東西一旦漏進去,整個操作會以「多餘欄位」為由被拒。
    const input: Record<string, unknown> = {};
    for (const f of fields) if (flags[f.key] !== undefined) input[f.key] = flags[f.key];

    if (typeof flags.bodyFile === "string") {
      // 兩個來源同時給就是意圖不明:安靜地挑一邊,使用者要等到讀資料時才會發現存錯了。
      if (input.bodyMd !== undefined) {
        fail("INVALID_INPUT", "--body-md and --body-file are mutually exclusive");
      }
      try {
        input.bodyMd = readFileSync(flags.bodyFile, "utf8");
      } catch (e) {
        fail("INVALID_INPUT", `cannot read --body-file: ${(e as Error).message}`);
      }
    }

    if (arrayField) {
      if (typeof flags.file === "string") {
        try {
          // 原封不動地切行後交給 core:在這裡先濾掉空行會讓 core 回報的行號跟檔案對不上。
          input[arrayField.key] = readFileSync(flags.file, "utf8").split("\n");
        } catch (e) {
          fail("INVALID_INPUT", `cannot read --file: ${(e as Error).message}`);
        }
      } else if (arrayField.required) {
        // 必填與否仍由 schema 決定;這裡只是把訊息翻成使用者打得出來的那個名字 ——
        // zod 會說「lines: Required」,而 CLI 上根本沒有 --lines 這個旗標可打。
        fail("INVALID_INPUT", "--file: Required(NDJSON 檔案路徑)");
      }
    }

    try {
      const ctx = openDb(resolveDbPath());
      // 部分 op(jira)的 handler 為 async,runOp 因此可能回 Promise —— await 再序列化;
      // await 非 Promise 值無害,既有同步 op 不受影響。async handler 的 rejection 在此被 catch,
      // 翻成 stderr 的 JSON + exit 1,與同步錯誤走同一條路。
      const result = await runOp(ctx, op.name, input);
      console.log(result === undefined ? "null" : JSON.stringify(result, null, 2));
    } catch (e) {
      fail(errorCode(e), (e as Error).message);
    }
  });
}

try {
  program.parse();
} catch (e) {
  if (!(e instanceof CommanderError)) fail("OP_FAILED", (e as Error).message);
  // --help / --version 也是走 exitOverride 丟出來的,那些不是錯誤:
  // 什麼都不做地跑完,讓 Node 自己把 help 輸出 flush 完再結束。
  const err = e as CommanderError;
  if (err.exitCode !== 0) {
    // 指令下到一半(`lcos` / `lcos read`)時 commander 只給 "(outputHelp)",
    // 那對呼叫端毫無資訊 —— 換成講得出下一步的訊息。
    fail("INVALID_INPUT", err.code === "commander.help"
      ? "incomplete command; run `lcos --help` to list available commands"
      : err.message);
  }
}
