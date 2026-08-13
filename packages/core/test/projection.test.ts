import { describe, it, expect, afterEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { errorCode, inputFields, resolveDbPath } from "../src/projection.ts";
import { ops, findOp, OpInputError, NotFoundError } from "../src/registry.ts";
import { JiraError } from "../src/jira.ts";

const ORIGINAL_DB_PATH = process.env.LCOS_DB_PATH;
afterEach(() => {
  if (ORIGINAL_DB_PATH === undefined) delete process.env.LCOS_DB_PATH;
  else process.env.LCOS_DB_PATH = ORIGINAL_DB_PATH;
});

describe("errorCode", () => {
  it("maps the core error taxonomy onto stable codes", () => {
    expect(errorCode(new OpInputError("bad"))).toBe("INVALID_INPUT");
    expect(errorCode(new NotFoundError("gone"))).toBe("NOT_FOUND");
    expect(errorCode(new Error("boom"))).toBe("OP_FAILED");
    expect(errorCode("not even an error")).toBe("OP_FAILED");
  });

  it("maps JiraError to JIRA_UNAVAILABLE", () => {
    expect(errorCode(new JiraError("x"))).toBe("JIRA_UNAVAILABLE");
  });
});

describe("inputFields", () => {
  const fields = (name: string) => Object.fromEntries(inputFields(findOp(name)).map(f => [f.key, f]));

  it("classifies enums, numbers and boolish unions", () => {
    const f = fields("read.tasks");
    expect(f.priority).toEqual({ key: "priority", required: false, kind: "enum", options: ["P0", "P1", "P2", "P3"] });
    expect(f.projectId).toEqual({ key: "projectId", required: false, kind: "number" });
    // boolish 是 union 而非 ZodBoolean —— 投影層必須認得它,否則 CLI 給不出裸旗標
    expect(f.overdue).toEqual({ key: "overdue", required: false, kind: "boolean" });
  });

  it("marks fields required only when undefined is rejected", () => {
    expect(fields("write.task").title).toEqual({ key: "title", required: true, kind: "string" });
    expect(fields("write.pitch").actor.required).toBe(true);
    // 有 default 的欄位在介面上不是必填:使用者不給,core 會補
    expect(fields("delete.item").actor).toEqual({
      key: "actor", required: false, kind: "enum", options: ["ai", "human"],
    });
    expect(fields("read.project-context").projectId).toEqual({ key: "projectId", required: true, kind: "number" });
  });

  it("covers every field of every op, in schema order", () => {
    expect(inputFields(findOp("read.snapshot"))).toEqual([]);
    expect(inputFields(findOp("write.briefing")).map(f => f.key))
      .toEqual(["kind", "date", "summary", "bodyMd", "actor", "workflow"]);
    for (const op of [findOp("search"), findOp("update.note"), findOp("backup")]) {
      for (const f of inputFields(op)) {
        expect(f.key).toBeTruthy();
        expect(["string", "number", "boolean", "enum", "array"]).toContain(f.kind);
        if (f.kind === "enum") expect(f.options!.length).toBeGreaterThan(0);
        else expect(f.options).toBeUndefined();
      }
    }
  });

  it("classifies array fields as their own kind, not as strings", () => {
    // 陣列塞不進單一旗標;若被誤判成 string,CLI 會長出一個永遠給不對值的 --lines
    expect(fields("import").lines).toEqual({ key: "lines", required: true, kind: "array" });
  });

  it("gives each op at most one array field", () => {
    // CLI 用 --file 餵陣列,一個指令只有一個 --file;第二個陣列欄位會沒有任何輸入管道
    for (const op of ops) {
      expect(inputFields(op).filter(f => f.kind === "array").length, op.name).toBeLessThanOrEqual(1);
    }
  });

  it("leaves the CLI's synthesized --file / --body-file flags uncontested", () => {
    // CLI 會自己長出 --file(餵陣列欄位)與 --body-file(餵 bodyMd)。
    // 若哪天有欄位的 kebab 形式撞到這兩個名字,commander 會安靜地讓其中一邊失效 ——
    // 而受害的是使用者的資料,不是一個看得見的錯誤。kebab 規則與 CLI 的 toFlag 相同。
    const toFlag = (key: string) => key.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`);
    for (const op of ops) {
      for (const f of inputFields(op)) {
        if (f.kind === "array") continue;
        expect(["file", "body-file"], `${op.name}.${f.key}`).not.toContain(toFlag(f.key));
      }
    }
  });
});

describe("boolish invariant", () => {
  /** 投影層把 ZodUnion 一律當 boolean,所以註冊表裡的 union 只能是 boolish —— 否則 CLI 會誤判值域。 */
  it("every union in the registry is the boolish union", () => {
    for (const op of ops) {
      const shape = (op.input as z.ZodObject<z.ZodRawShape>).shape;
      for (const [key, field] of Object.entries(shape)) {
        let inner: z.ZodTypeAny = field;
        while (inner instanceof z.ZodOptional || inner instanceof z.ZodDefault || inner instanceof z.ZodNullable) {
          inner = inner._def.innerType;
        }
        if (!(inner instanceof z.ZodUnion)) continue;
        const where = `${op.name}.${key}`;
        expect(inner.parse(true), where).toBe(true);
        expect(inner.parse("true"), where).toBe(true);
        expect(inner.parse("1"), where).toBe(true);
        expect(inner.parse(false), where).toBe(false);
        expect(inner.parse("false"), where).toBe(false);
        expect(inner.parse(""), where).toBe(false);
        expect(() => inner.parse("maybe"), where).toThrow();
      }
    }
  });
});

describe("resolveDbPath", () => {
  it("prefers LCOS_DB_PATH", () => {
    process.env.LCOS_DB_PATH = "/somewhere/custom.db";
    expect(resolveDbPath()).toBe("/somewhere/custom.db");
  });

  it("falls back to ~/.lcos/data.db when unset or empty", () => {
    delete process.env.LCOS_DB_PATH;
    expect(resolveDbPath()).toBe(join(homedir(), ".lcos", "data.db"));
    process.env.LCOS_DB_PATH = "";
    expect(resolveDbPath()).toBe(join(homedir(), ".lcos", "data.db"));
  });
});
