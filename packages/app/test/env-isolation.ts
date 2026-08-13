import { beforeEach, afterAll } from "vitest";

const ENV_KEYS = ["LCOS_HOST", "LCOS_TOKEN", "LCOS_ALLOWED_HOSTS"] as const;

/**
 * 任何會呼叫 startServer() 的測試檔都要在最上方呼叫一次。
 *
 * startServer() 沒拿到 opts 時直接讀 env,所以開發機上外流進來的 LCOS_HOST /
 * LCOS_TOKEN 會改變被測行為:`LCOS_HOST=0.0.0.0` 讓沒帶 token 的呼叫全部拒絕啟動,
 * 而 `LCOS_TOKEN` 讓每個請求都變 401。那是「環境紅燈」——測試本身沒問題,
 * 但只有設過那些變數的人看得到,最難查的一種假失敗。
 *
 * 清除發生在「呼叫的當下」而不是只在 beforeEach:e2e-smoke 在 module top level
 * 就 await startServer(),那時候 hook 一次都還沒跑過。beforeEach 仍然註冊,
 * 讓個別測試自己設進去的值不會外溢到下一條;afterAll 把原值還給 process。
 */
export function isolateLanEnv(): void {
  const saved: Record<string, string | undefined> = Object.fromEntries(
    ENV_KEYS.map((k) => [k, process.env[k]]),
  );
  const clear = () => {
    for (const k of ENV_KEYS) delete process.env[k];
  };
  clear();
  beforeEach(clear);
  afterAll(() => {
    for (const k of ENV_KEYS) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}
