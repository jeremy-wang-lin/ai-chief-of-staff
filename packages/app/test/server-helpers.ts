import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "@lcos/core";
import { createApp, type AppOptions } from "../src/server/app.ts";

export function tmpApp(opts?: AppOptions) {
  const dir = mkdtempSync(join(tmpdir(), "lcos-srv-"));
  const ctx = openDb(join(dir, "t.db"));
  return { app: createApp(ctx, opts), ctx };
}
