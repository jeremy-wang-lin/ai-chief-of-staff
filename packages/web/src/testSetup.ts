import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// globals: false ⇒ testing-library 的自動 cleanup(靠全域 afterEach)不會註冊,
// 不清就會讓前一個 test 的 DOM 留在 document 裡,害 getByRole 撞到重複元素。
afterEach(cleanup);
