/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://127.0.0.1:4700" } },
  // clearMocks:每個 test 前自動清掉所有 mock 的呼叫紀錄(實作保留,所以 beforeEach 裡設的
  // mockImplementation 照常生效 —— 清除發生在 beforeEach 之前)。這裡幾乎每頁的斷言都在問
  // 「送了幾次 POST/PATCH」,漏抄一個檔案的 clearAllMocks 只會讓次數靜靜地跨 test 累加,
  // 所以這個預設值屬於設定,不屬於每個測試檔的開頭樣板。
  test: {
    environment: "jsdom",
    setupFiles: "./src/testSetup.ts",
    globals: false,
    clearMocks: true,
  },
});
