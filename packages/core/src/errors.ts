/**
 * 錯誤分類 —— 刻意獨立成一個沒有任何相依的模組。
 *
 * 這些類別原本住在 registry.ts,但註冊表 import 了幾乎整個 core,
 * 導致 core 內層(revisions、repos)想丟一個「這是輸入錯誤」時會產生循環相依。
 * 分類本身不該依賴任何東西,所以它自己一個檔;registry.ts 會再 re-export 一次,
 * `import { OpInputError } from "./registry.ts"` 這種既有寫法不受影響。
 */

/** 輸入驗證失敗(zod 不通過,或 handler 收到語意上不合法的組合)。介面層應轉成 400 類錯誤。 */
export class OpInputError extends Error {
  constructor(message: string) { super(message); this.name = "OpInputError"; }
}

/**
 * 目標資料列不存在、已 soft-deleted,或不在 trash 中。
 * repo 層的 updateX / getProjectContext 誠實回傳 undefined,覆寫類函式則丟泛用 Error;
 * 由註冊表在邊界統一翻譯,否則 CLI 只會印出一個 null 或一句無型別的錯誤,
 * 使用者無從分辨「更新成功但沒欄位」和「這筆根本不存在」。
 */
export class NotFoundError extends Error {
  constructor(message: string) { super(message); this.name = "NotFoundError"; }
}
