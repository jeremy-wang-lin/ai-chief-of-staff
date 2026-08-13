import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthGate } from "../src/AuthGate";
import * as apiMod from "../src/api";

vi.mock("../src/api", () => ({
  checkAuth: vi.fn(),
  getToken: vi.fn(() => null),
  setToken: vi.fn(),
  clearToken: vi.fn(),
}));
const checkAuth = vi.mocked(apiMod.checkAuth);
const setToken = vi.mocked(apiMod.setToken);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AuthGate", () => {
  it("驗證通過 → 直接渲染內容(免登入環境零改變)", async () => {
    checkAuth.mockResolvedValue(true);
    render(
      <AuthGate>
        <div>app 內容</div>
      </AuthGate>,
    );
    expect(await screen.findByText("app 內容")).toBeInTheDocument();
  });

  // 貼上金鑰時很容易多帶一個尾端空白/換行,而 server 端的 LCOS_TOKEN 是 trim 過的,
  // 不 trim 就會回「金鑰不正確」—— 使用者看著一模一樣的字串,沒有任何線索。
  it("401 → 顯示登入頁;輸入正確金鑰(含尾端空白)→ trim 後驗證並存入", async () => {
    checkAuth.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(
      <AuthGate>
        <div>app 內容</div>
      </AuthGate>,
    );
    const input = await screen.findByLabelText("存取金鑰");
    await userEvent.type(input, "my-token ");
    await userEvent.click(screen.getByRole("button", { name: "登入" }));
    expect(await screen.findByText("app 內容")).toBeInTheDocument();
    expect(checkAuth).toHaveBeenLastCalledWith("my-token");
    expect(setToken).toHaveBeenCalledWith("my-token");
  });

  it("金鑰錯誤 → 顯示錯誤訊息,停留在登入頁", async () => {
    checkAuth.mockResolvedValue(false);
    render(
      <AuthGate>
        <div>app 內容</div>
      </AuthGate>,
    );
    await userEvent.type(await screen.findByLabelText("存取金鑰"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: "登入" }));
    expect(await screen.findByText("金鑰不正確")).toBeInTheDocument();
    expect(screen.queryByText("app 內容")).not.toBeInTheDocument();
  });

  it("連線失敗 → 顯示連線錯誤而不是白畫面", async () => {
    checkAuth.mockRejectedValue(new Error("boom"));
    render(
      <AuthGate>
        <div>app 內容</div>
      </AuthGate>,
    );
    expect(await screen.findByText("無法連線伺服器")).toBeInTheDocument();
  });
});
