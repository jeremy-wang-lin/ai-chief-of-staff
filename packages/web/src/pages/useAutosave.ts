import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api";

export type AutosaveState = "idle" | "saving" | "saved" | "error";

/**
 * debounce 自動儲存:value 靜止 delayMs 後呼叫 saveFn;失敗持續重試,卸載前把還沒送的那一筆補送。
 *
 * 沒有「儲存」按鈕的頁面,使用者判斷「存好了沒」的唯一依據就是那一行小字 ——
 * 底下每一條規則都是為了讓那行字不說謊。
 */
export function useAutosave<T>(value: T, saveFn: (v: T) => Promise<unknown>, delayMs = 2000) {
  const [state, setState] = useState<AutosaveState>("idle");

  // 4xx 是「這份內容本身不合法/那一列已經不在了」:同樣的請求再送一萬次,答案都一樣。
  // 繼續重試只會變成一個安靜的無限迴圈(每兩秒一次,直到分頁被關掉),
  // 而且畫面還會一直寫著「重試中」—— 一句永遠不會兌現的承諾。
  const [permanent, setPermanent] = useState(false);

  // 重試計數放 state 而非 ref:ref 不觸發重新渲染,而連續失敗時第二次 setState("error")
  // 與現值相同 → React 直接 bail out → effect 不再重跑 → 重試在第一次失敗後就悄悄停了,
  // 畫面卻還寫著「重試中」。
  const [attempt, setAttempt] = useState(0);

  // 「這一輪跟上一輪一樣嗎」的比對基準。用旗標(跑過一次就關掉)擋不住 StrictMode 的雙重呼叫:
  // 第二次呼叫時旗標已關,於是掛載當下就排了一次無中生有的儲存。比對 value 本身則對重複呼叫
  // 免疫 —— 同樣的輸入永遠得到同樣的結論。
  const last = useRef({ value, attempt });

  // 派工序號:先派的後回是常態(慢請求疊上快請求)。過期的結果必須丟掉,
  // 否則最新那筆失敗了,畫面還會被姍姍來遲的舊成功蓋成「已儲存 ✓」。
  const seq = useRef(0);

  // 還沒觸發的那一次儲存,留給卸載時補送:切換筆記會把編輯器整個換掉,
  // debounce 沒到就丟掉,等於使用者最後兩秒打的字直接蒸發。
  const pending = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    if (Object.is(value, last.current.value) && attempt === last.current.attempt) return;
    last.current = { value, attempt };

    const run = async () => {
      const mySeq = ++seq.current;
      setState("saving");
      try {
        await saveFn(value);
        if (mySeq !== seq.current) return; // 已有更新的儲存派出去了,這個結果過期了
        setPermanent(false);
        setState("saved");
      } catch (e) {
        if (mySeq !== seq.current) return;
        if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
          // 不遞增 attempt = 不排下一輪。這是唯一一條「失敗但不重試」的路徑。
          setPermanent(true);
          setState("error");
          return;
        }
        setPermanent(false);
        // attempt 遞增 = 下一輪 effect 的觸發器。成功時不動它 —— 「歸零」本身也是一次變更,
        // 會讓同一份內容在恢復後又白存一次。
        setAttempt((a) => a + 1);
        setState("error");
      }
    };

    pending.current = run;
    const t = setTimeout(() => {
      pending.current = null;
      void run();
    }, delayMs);
    return () => clearTimeout(t);
  }, [value, attempt]);

  // 卸載補送獨立成一個 mount-scoped effect:上面那個 effect 的 cleanup 每次 value 變都會跑,
  // 在那裡補送等於每按一個鍵存一次,debounce 形同虛設。
  useEffect(
    () => () => {
      const run = pending.current;
      pending.current = null;
      // 元件已經不在了,沒有 state 可以更新,也沒有人能處理錯誤 —— 送出去就好。
      if (run) void run().catch(() => {});
    },
    [],
  );

  // retrying 給畫面用:錯誤有兩種,而「還會不會再試一次」正是使用者接下來該不該等的依據。
  return { state, retrying: state === "error" && !permanent };
}
