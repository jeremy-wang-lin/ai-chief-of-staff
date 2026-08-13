import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ops } from "@lcos/core";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli", "main.ts");

/**
 * 以 child process 跑真正的 CLI:flag 解析、字串轉型、JSON 輸出、exit code
 * 都只有端到端才驗得到。用 repo 內的 tsx 而非 `pnpm tsx`,避免 pnpm-in-pnpm 的額外一層。
 */
const TSX = join(HERE, "..", "..", "..", "node_modules", ".bin", "tsx");

function lcos(dbPath: string, args: string[], expectFail = false): any {
  try {
    const out = execFileSync(TSX, [CLI, ...args], {
      env: { ...process.env, LCOS_DB_PATH: dbPath, LCOS_BACKUP_DIR: "" },
      encoding: "utf8",
      // 預期中的錯誤案例會寫 stderr,不轉走的話會被原樣噴進測試輸出裡。
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (expectFail) throw new Error(`expected failure, got: ${out}`);
    return JSON.parse(out);
  } catch (e: any) {
    if (!expectFail) throw new Error(`${e.message}\nstderr: ${e.stderr}`);
    return JSON.parse(e.stderr);
  }
}

/** 每個案例一個獨立暫存 DB,絕不碰預設的 ~/.lcos/data.db。 */
function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), "lcos-cli-")), "t.db");
}

describe("lcos CLI", () => {
  it("write then read tasks end-to-end", () => {
    const db = tmpDb();
    const created = lcos(db, ["write", "task", "--title", "hello", "--priority", "P1"]);
    expect(created.priority).toBe("P1");
    const listed = lcos(db, ["read", "tasks", "--priority", "P1"]);
    expect(listed).toHaveLength(1);
    expect(listed[0].title).toBe("hello");
  });

  it("validation error → JSON error + exit 1", () => {
    const db = tmpDb();
    const err = lcos(db, ["write", "task"], true);
    expect(err.error.code).toBe("INVALID_INPUT");
    expect(err.error.message).toContain("title");
  });

  it("not-found error → NOT_FOUND + exit 1", () => {
    const db = tmpDb();
    const err = lcos(db, ["update", "task", "--id", "999", "--status", "Done"], true);
    expect(err.error.code).toBe("NOT_FOUND");
  });

  it("restoring a deleted_at revision is INVALID_INPUT, not a generic failure", () => {
    const db = tmpDb();
    const task = lcos(db, ["write", "task", "--title", "x"]);
    lcos(db, ["delete", "--table", "tasks", "--id", String(task.id)]);
    const rev = lcos(db, ["read", "revisions", "--table", "tasks", "--row-id", String(task.id)])[0];
    expect(rev.field).toBe("deleted_at");
    // 刪除紀錄沒有「把舊值寫回去」的意義(那是 trash restore 的事),但它是使用者指錯了
    // revision,不是系統故障 —— 落在 OP_FAILED 會讓人以為程式壞了
    const err = lcos(db, ["revisions", "restore", "--revision-id", String(rev.id)], true);
    expect(err.error.code).toBe("INVALID_INPUT");
  });

  it("get-by-id and pagination are reachable from the CLI", () => {
    const db = tmpDb();
    const a = lcos(db, ["write", "task", "--title", "a"]);
    lcos(db, ["write", "task", "--title", "b"]);
    expect(lcos(db, ["read", "task", "--id", String(a.id)]).title).toBe("a");
    expect(lcos(db, ["read", "tasks", "--limit", "1", "--offset", "1"]).map((t: any) => t.title))
      .toEqual(["b"]);
    expect(lcos(db, ["read", "task", "--id", "999"], true).error.code).toBe("NOT_FOUND");
  });

  it("unknown flag is rejected instead of silently ignored", () => {
    const db = tmpDb();
    const err = lcos(db, ["write", "task", "--title", "x", "--bogus", "1"], true);
    expect(err.error.code).toBe("INVALID_INPUT");
  });

  it("incomplete or unknown commands still answer in JSON", () => {
    const db = tmpDb();
    expect(lcos(db, [], true).error.code).toBe("INVALID_INPUT");
    expect(lcos(db, ["read"], true).error.message).toContain("--help");
    expect(lcos(db, ["nope"], true).error.message).toContain("unknown command");
  });

  it("coerces string flags into numbers and booleans", () => {
    const db = tmpDb();
    const project = lcos(db, ["write", "project", "--name", "Apollo"]);
    lcos(db, ["write", "task", "--title", "linked", "--project-id", String(project.id)]);
    lcos(db, ["write", "task", "--title", "unlinked"]);

    const byProject = lcos(db, ["read", "tasks", "--project-id", String(project.id)]);
    expect(byProject).toHaveLength(1);
    expect(byProject[0].title).toBe("linked");

    // boolish:--overdue false 必須是 false,不能被 Boolean("false") 轉成 true
    expect(lcos(db, ["read", "tasks", "--overdue", "false"])).toHaveLength(2);
    expect(lcos(db, ["read", "tasks", "--overdue", "true"])).toHaveLength(0);
    // 裸旗標即 true —— 旗標本來就該這樣用
    expect(lcos(db, ["read", "tasks", "--overdue"])).toHaveLength(0);
    expect(lcos(db, ["read", "tasks", "--overdue", "--priority", "P2"])).toHaveLength(0);

    lcos(db, ["write", "briefing", "--kind", "daily", "--date", "2026-01-01",
      "--summary", "a", "--body-md", "a"]);
    lcos(db, ["write", "briefing", "--kind", "daily", "--date", "2026-01-02",
      "--summary", "b", "--body-md", "b"]);
    expect(lcos(db, ["read", "briefings", "--limit", "1"])).toHaveLength(1);
  }, 15_000);

  it("--body-file fills bodyMd from disk", () => {
    const db = tmpDb();
    const file = join(mkdtempSync(join(tmpdir(), "lcos-body-")), "note.md");
    writeFileSync(file, "# 從檔案來的內文\n");
    const note = lcos(db, ["write", "note", "--body-file", file, "--type", "Meeting"]);
    expect(note.bodyMd).toContain("從檔案來的內文");
    expect(note.type).toBe("Meeting");
  });

  it("--body-md together with --body-file is rejected", () => {
    const db = tmpDb();
    const file = join(mkdtempSync(join(tmpdir(), "lcos-body-")), "note.md");
    writeFileSync(file, "從檔案來的");
    const err = lcos(db, ["write", "note", "--body-file", file, "--body-md", "從參數來的"], true);
    expect(err.error.code).toBe("INVALID_INPUT");
    expect(err.error.message).toContain("--body-file");
  });

  it("import --file reads NDJSON from disk, with --dry-run first", () => {
    const db = tmpDb();
    const file = join(mkdtempSync(join(tmpdir(), "lcos-ndjson-")), "tasks.ndjson");
    // 結尾換行與空行都是編輯器與 shell 的常態,不該被算成一列
    writeFileSync(file, `${JSON.stringify({ title: "imported-1" })}\n\n${JSON.stringify({ title: "imported-2", priority: "P1" })}\n`);

    const dry = lcos(db, ["import", "--table", "tasks", "--file", file, "--dry-run", "true"]);
    expect(dry).toMatchObject({ ok: true, total: 2, inserted: 0 });
    expect(lcos(db, ["read", "tasks"])).toHaveLength(0);

    // --dry-run false 必須真的落地(boolish,而不是「有給就當 true」)
    const real = lcos(db, ["import", "--table", "tasks", "--file", file, "--dry-run", "false"]);
    expect(real).toMatchObject({ ok: true, total: 2, inserted: 2 });
    expect(lcos(db, ["read", "tasks", "--priority", "P1"])).toHaveLength(1);
  });

  it("import without --file or with an unreadable path fails as INVALID_INPUT", () => {
    const db = tmpDb();
    const noFile = lcos(db, ["import", "--table", "tasks"], true);
    expect(noFile.error.code).toBe("INVALID_INPUT");
    // 使用者打的是 --file,錯誤就得說 --file;講 schema 的內部欄位名(lines)沒人找得到那個旗標
    expect(noFile.error.message).toContain("--file");
    expect(noFile.error.message).not.toContain("lines");

    const missing = lcos(db, ["import", "--table", "tasks", "--file", join(tmpdir(), "lcos-nope.ndjson")], true);
    expect(missing.error.code).toBe("INVALID_INPUT");
    expect(missing.error.message).toContain("--file");
  });

  it("import reports the file's own line numbers, blank lines included", () => {
    const db = tmpDb();
    const file = join(mkdtempSync(join(tmpdir(), "lcos-ndjson-")), "bad.ndjson");
    // 第 1 行合法、第 2 行空白、第 3 行專案不存在 —— 回報必須指向檔案的第 3 行,
    // 否則使用者拿著行號回去改檔案會改錯行
    writeFileSync(file, `${JSON.stringify({ title: "ok" })}\n\n${JSON.stringify({ title: "x", project: "不存在" })}\n`);
    const res = lcos(db, ["import", "--table", "tasks", "--file", file]);
    expect(res.ok).toBe(false);
    expect(res.inserted).toBe(0);
    expect(res.errors[0].line).toBe(3);
    expect(lcos(db, ["read", "tasks"])).toHaveLength(0);
  });

  it("every registry op is reachable as a subcommand", () => {
    const db = tmpDb();
    const help = execFileSync(TSX, [CLI, "--help"], {
      env: { ...process.env, LCOS_DB_PATH: db },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // 由 ops 推導,不手抄清單:註冊表長出新的頂層指令時這個測試自己會跟上
    for (const op of ops) expect(help).toContain(op.cliPath[0]);
    // 中繼節點(read / write / …)也要有說明,help 裡不能出現沒下文的裸名字
    const readHelp = execFileSync(TSX, [CLI, "read", "--help"], {
      env: { ...process.env, LCOS_DB_PATH: db }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    expect(readHelp).toContain("snapshot");
    expect(help).toMatch(/read\s+\S/);
  });

  it("backup creates dated file via VACUUM INTO", () => {
    const dir = mkdtempSync(join(tmpdir(), "lcos-cli-"));
    const db = join(dir, "t.db");
    lcos(db, ["write", "task", "--title", "x"]);
    const dest = mkdtempSync(join(tmpdir(), "lcos-bak-"));
    const res = lcos(db, ["backup", "--dest", dest]);
    expect(res.path).toContain("lcos-");
    expect(isAbsolute(res.path)).toBe(true);
    expect(readdirSync(dest)).toHaveLength(1);
  });

  it("backup without dest or LCOS_BACKUP_DIR → INVALID_INPUT", () => {
    const db = tmpDb();
    const err = lcos(db, ["backup"], true);
    expect(err.error.code).toBe("INVALID_INPUT");
  });
});
