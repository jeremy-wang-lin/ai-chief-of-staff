import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { NotFoundError, OpInputError, type Op } from "./registry.ts";
import { JiraError } from "./jira.ts";

/**
 * 註冊表投影層 —— 每個介面(CLI、MCP、未來的 HTTP)都需要同一組問題的答案:
 * 「這個操作有哪些參數、哪些必填、值長什麼樣?」「這個錯誤該回哪個碼?」「DB 在哪?」
 * 這些答案只能有一份。放任各介面自己 instanceof zod、自己 map 錯誤,
 * 就等於把註冊表的權威性拆成兩半,而漂移永遠是從「兩邊各寫一次」開始的。
 */

export type ErrorCode = "INVALID_INPUT" | "NOT_FOUND" | "JIRA_UNAVAILABLE" | "OP_FAILED";

/** core 的錯誤分類翻成穩定的錯誤碼;不認得的一律 OP_FAILED,不猜、也不假裝是使用者的輸入問題。 */
export function errorCode(e: unknown): ErrorCode {
  if (e instanceof OpInputError) return "INVALID_INPUT";
  if (e instanceof NotFoundError) return "NOT_FOUND";
  // 讀不到外部 Jira(未設定、連線失敗、非 2xx)是暫時性降級,不是 500 系統故障 —— 獨立成碼讓介面層映到 503。
  if (e instanceof JiraError) return "JIRA_UNAVAILABLE";
  return "OP_FAILED";
}

/**
 * "array" 是刻意獨立的一類:陣列沒有「一個旗標一個值」的自然形式,
 * 混進 string 只會讓 CLI 長出一個永遠給不對值的旗標。介面層看到它就知道要另外開路
 * (CLI 用 --file 讀檔,一行一個元素;未來的 HTTP/MCP 直接收 JSON 陣列)。
 */
export type FieldKind = "string" | "number" | "boolean" | "enum" | "array";

export interface InputField {
  key: string;
  required: boolean;
  kind: FieldKind;
  /** 只有 kind === "enum" 時存在,且必為完整的合法值列舉。 */
  options?: string[];
}

/** 剝掉 optional / default / nullable 的外殼,取得真正描述值域的那一層。 */
function unwrap(field: z.ZodTypeAny): z.ZodTypeAny {
  let inner = field;
  while (inner instanceof z.ZodOptional || inner instanceof z.ZodDefault || inner instanceof z.ZodNullable) {
    inner = inner._def.innerType;
  }
  return inner;
}

/**
 * 把 op 的 zod schema 攤平成介面層可直接消費的欄位描述。
 * CLI 用它產旗標與 --help 提示,MCP 用它產 JSON Schema —— 兩邊看到的必然是同一份事實。
 */
export function inputFields(op: Op): InputField[] {
  const shape = (op.input as z.ZodObject<z.ZodRawShape>).shape ?? {};
  return Object.entries(shape).map(([key, field]) => {
    const inner = unwrap(field);
    // required 以「schema 是否接受 undefined」判定:有 default 的欄位在介面上不必填,
    // 因為使用者不給時 core 會補 —— 標成必填只會逼人重打一次預設值。
    const required = !field.isOptional();
    if (inner instanceof z.ZodEnum) {
      return { key, required, kind: "enum" as const, options: inner.options as string[] };
    }
    if (inner instanceof z.ZodNumber) return { key, required, kind: "number" as const };
    if (inner instanceof z.ZodArray) return { key, required, kind: "array" as const };
    // boolean 在註冊表裡是 boolish union(要能吃 "true"/"false" 字串)而不是 ZodBoolean。
    if (inner instanceof z.ZodUnion || inner instanceof z.ZodBoolean) {
      return { key, required, kind: "boolean" as const };
    }
    return { key, required, kind: "string" as const };
  });
}

/** DB 位置:env 優先,否則 ~/.lcos/data.db。測試必須設 LCOS_DB_PATH,絕不碰預設路徑。 */
export function resolveDbPath(): string {
  return process.env.LCOS_DB_PATH || join(homedir(), ".lcos", "data.db");
}
