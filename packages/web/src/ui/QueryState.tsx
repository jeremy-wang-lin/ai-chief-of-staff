import type { ReactElement } from "react";

/**
 * 每一頁都要回答同一個問題:資料還沒到的時候,這塊區域該長什麼樣?
 *
 * 不回答的下場不是空白,而是說謊 —— `data ?? []` 會讓「連不上 server」渲染成
 * 「今天沒有到期任務 🎉」,讓「讀取失敗」渲染成「尚無版本紀錄」。使用者看到的是一份
 * 語氣輕鬆的空狀態,而真相是那台 server 根本沒起來。
 *
 * 只吃 react-query result 需要的三個欄位,不綁 UseQueryResult 的完整型別:
 * 呼叫端傳什麼 select/型別參數都不影響這裡。
 */
interface QueryLike {
  data: unknown;
  isError: boolean;
  error: { message: string } | null;
}

/**
 * 回傳「該蓋在原內容上的東西」,沒有就是 null —— 呼叫端一律寫成
 * `{queryGuard(q) ?? <真正的內容/>}`,於是「載入中」與「讀取失敗」不可能被漏掉一個。
 */
export function queryGuard(q: QueryLike): ReactElement | null {
  if (q.data !== undefined) return null;
  if (q.isError) {
    return (
      <p role="alert" className="rounded-lg bg-danger-soft px-2.5 py-1.5 text-[12.5px] text-danger">
        {/* 把伺服器的話原樣說出來:一律「載入失敗」會讓連線失敗與 500 看起來一模一樣。 */}
        讀取失敗:{q.error?.message ?? "未知錯誤"}
      </p>
    );
  }
  return <p className="py-2 text-center text-sm text-muted">載入中…</p>;
}
