import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { checkAuth, getToken, setToken, clearToken } from "./api";

/**
 * 登入 gate:server 設了 LCOS_TOKEN 時,/api/* 全部 401,這裡是唯一的入口。
 * 未設 token 的環境 checkAuth 直接成功,gate 透明通過 —— 本機體驗零改變。
 * 放在 router 之外:登入頁不需要導航,也不該掛在任何路由之下。
 *
 * children 一定要等驗證通過才渲染:提早掛上去的頁面會馬上打 /api/*,
 * 撞 401 觸發 api.ts 的整頁 reload,變成永不停止的重載迴圈。
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"checking" | "authed" | "login">("checking");
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    checkAuth(getToken() ?? undefined)
      .then((ok) => {
        if (ok) {
          setState("authed");
        } else {
          clearToken();
          setState("login");
        }
      })
      .catch(() => {
        setError("無法連線伺服器");
        setState("login");
      });
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    // 貼上金鑰幾乎一定會多帶尾端空白或換行,而 server 端的 LCOS_TOKEN 是 trim 過的 ——
    // 不 trim 的話使用者看到的是「金鑰不正確」配上一個看起來完全正確的字串,無從查起。
    const key = input.trim();
    try {
      if (await checkAuth(key)) {
        setToken(key);
        setState("authed");
      } else {
        setError("金鑰不正確");
      }
    } catch {
      setError("無法連線伺服器");
    }
  }

  if (state === "authed") return <>{children}</>;
  if (state === "checking") return null;
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg">
      <form onSubmit={submit} className="w-[320px] rounded-xl border border-line bg-surface p-6">
        <div className="pb-4 text-sm font-bold">
          LCOS
          <span className="block text-[11px] font-medium tracking-widest text-muted">CHIEF OF STAFF</span>
        </div>
        <label htmlFor="lcos-token" className="block pb-1 text-[13px] text-muted">
          存取金鑰
        </label>
        <input
          id="lcos-token"
          type="password"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          autoFocus
          className="w-full rounded-lg border border-line bg-surface2 px-3 py-1.5 text-sm"
        />
        {error && <p className="pt-2 text-[13px] text-danger">{error}</p>}
        <button
          type="submit"
          className="mt-4 w-full rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white"
        >
          登入
        </button>
      </form>
    </div>
  );
}
