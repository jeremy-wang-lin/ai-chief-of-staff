import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Ctx } from "../src/db.ts";

/** 每次都開一個全新的暫存 DB,絕不碰預設 DB 路徑。 */
export function tmpCtx(): Ctx {
  const dir = mkdtempSync(join(tmpdir(), "lcos-test-"));
  return openDb(join(dir, "test.db"));
}
