import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Pill, priorityTone } from "../src/ui/Pill";
import { MdTabEditor } from "../src/ui/MdTabEditor";
import { Drawer } from "../src/ui/Drawer";
import { Markdown } from "../src/ui/Markdown";
import { TextField, SelectField, DateField } from "../src/ui/fields";
import { noteLabel } from "../src/noteLabel";

describe("ui primitives", () => {
  it("Pill applies tone classes", () => {
    render(<Pill tone="ai">AI</Pill>);
    expect(screen.getByText("AI").className).toContain("ai");
  });

  // 五個 tone 全部釘死:少一個沒測,就有一個 tone 可以悄悄退化成別人的顏色。
  it.each([
    ["accent", "bg-accent-soft", "text-accent"],
    ["ai", "bg-ai-soft", "text-ai"],
    ["warn", "bg-warn-soft", "text-warn"],
    ["danger", "bg-danger-soft", "text-danger"],
    ["mute", "bg-surface2", "text-muted"],
  ] as const)("Pill tone %s maps to its token classes", (tone, bg, text) => {
    render(<Pill tone={tone}>標籤</Pill>);
    expect(screen.getByText("標籤")).toHaveClass(bg, text);
  });

  it("priorityTone maps P0/P1 to danger, P2 to warn, P3 to mute", () => {
    expect(priorityTone("P0")).toBe("danger");
    expect(priorityTone("P1")).toBe("danger");
    expect(priorityTone("P2")).toBe("warn");
    expect(priorityTone("P3")).toBe("mute");
  });

  it("MdTabEditor defaults to 預覽 when content exists, 編輯 when empty", () => {
    const { unmount } = render(<MdTabEditor value="# hi" onChange={() => {}} />);
    expect(screen.getByRole("heading", { name: "hi" })).toBeInTheDocument(); // 渲染中
    unmount();
    render(<MdTabEditor value="" onChange={() => {}} />);
    expect(screen.getByRole("textbox")).toBeInTheDocument(); // 編輯中
  });

  it("MdTabEditor treats whitespace-only content as empty", () => {
    // 只有空白的 body 開在「預覽」等於給使用者看一片空白,還要多按一次才知道能打字。
    render(<MdTabEditor value="   " onChange={() => {}} />);
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("MdTabEditor labels its textarea 內文", () => {
    // Tasks 6-11 的 drawer 裡會同時有 TextField,得靠 label 才分得出哪個 textbox 是內文。
    render(<MdTabEditor value="" onChange={() => {}} />);
    expect(screen.getByLabelText("內文")).toBe(screen.getByRole("textbox"));
  });

  it("MdTabEditor marks the current tab with aria-pressed", async () => {
    const user = userEvent.setup();
    render(<MdTabEditor value="# hi" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "預覽" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "編輯" })).toHaveAttribute("aria-pressed", "false");
    await user.click(screen.getByRole("button", { name: "編輯" }));
    expect(screen.getByRole("button", { name: "編輯" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "預覽" })).toHaveAttribute("aria-pressed", "false");
  });

  it("MdTabEditor switches tabs and edits", async () => {
    const user = userEvent.setup();
    let v = "hello";
    render(<MdTabEditor value={v} onChange={(x) => (v = x)} />);
    await user.click(screen.getByRole("button", { name: "編輯" }));
    await user.type(screen.getByRole("textbox"), "!");
    expect(v).toBe("hello!");
  });

  it("MdTabEditor switching tabs does not emit a change", async () => {
    // 切 tab 不儲存(spec §5):換 tab 只是換檢視,不能偷偷把 value 回寫。
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<MdTabEditor value="# hi" onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "編輯" }));
    await user.click(screen.getByRole("button", { name: "預覽" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Drawer renders when open and closes on Esc", async () => {
    const user = userEvent.setup();
    let open = true;
    const { rerender } = render(
      <Drawer open={open} title="編輯任務" onClose={() => (open = false)}>
        x
      </Drawer>,
    );
    expect(screen.getByText("編輯任務")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    rerender(
      <Drawer open={open} title="編輯任務" onClose={() => {}}>
        x
      </Drawer>,
    );
    expect(screen.queryByText("編輯任務")).not.toBeInTheDocument();
  });

  it("Drawer renders nothing when closed", () => {
    render(
      <Drawer open={false} title="編輯任務" onClose={() => {}}>
        x
      </Drawer>,
    );
    expect(screen.queryByText("編輯任務")).not.toBeInTheDocument();
  });

  it("Drawer closes on backdrop click and on the close button", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Drawer open title="編輯任務" onClose={onClose}>
        x
      </Drawer>,
    );
    await user.click(screen.getByTestId("drawer-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "關閉" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("Drawer does not listen for Esc while closed", async () => {
    // 關著的 drawer 還在監聽 keydown 的話,Esc 會打到已經看不見的面板上。
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Drawer open={false} title="編輯任務" onClose={onClose}>
        x
      </Drawer>,
    );
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Drawer moves focus into the panel on open and restores it on close", () => {
    // aria-modal 對輔助技術的承諾是「焦點在這裡面」;不搬焦點就是騙人。
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    const { rerender } = render(
      <Drawer open title="編輯任務" onClose={() => {}}>
        x
      </Drawer>,
    );
    expect(screen.getByRole("dialog")).toHaveFocus();
    rerender(
      <Drawer open={false} title="編輯任務" onClose={() => {}}>
        x
      </Drawer>,
    );
    expect(outside).toHaveFocus();
    outside.remove();
  });

  it("Drawer takes its accessible name from the title heading", () => {
    render(
      <Drawer open title="編輯任務" onClose={() => {}}>
        x
      </Drawer>,
    );
    expect(screen.getByRole("heading", { name: "編輯任務" })).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveAccessibleName("編輯任務");
  });

  it("Markdown renders headings and lists", () => {
    render(<Markdown source={"# 標題\n\n- 一\n- 二"} />);
    expect(screen.getByRole("heading", { name: "標題" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("TextField renders a labelled input and reports changes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TextField label="標題" value="" onChange={onChange} placeholder="輸入標題" />);
    const input = screen.getByLabelText("標題");
    expect(input).toHaveAttribute("placeholder", "輸入標題");
    await user.type(input, "a");
    expect(onChange).toHaveBeenCalledWith("a");
  });

  it("SelectField renders options and reports the selected value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SelectField label="優先序" value="P2" options={["P0", "P1", "P2", "P3"]} onChange={onChange} />);
    const select = screen.getByLabelText("優先序");
    expect(select).toHaveValue("P2");
    expect(screen.getAllByRole("option")).toHaveLength(4);
    await user.selectOptions(select, "P0");
    expect(onChange).toHaveBeenCalledWith("P0");
  });

  it("DateField renders a date input and reports changes", () => {
    const onChange = vi.fn();
    render(<DateField label="到期日" value="2026-08-02" onChange={onChange} />);
    const input = screen.getByLabelText("到期日");
    expect(input).toHaveAttribute("type", "date");
    expect(input).toHaveValue("2026-08-02");
    // userEvent 對 type=date 的鍵盤輸入在 jsdom 下不穩,直接派 change event。
    fireEvent.change(input, { target: { value: "2026-08-03" } });
    expect(onChange).toHaveBeenCalledWith("2026-08-03");
  });
});

describe("noteLabel", () => {
  it("prefers title, falls back to first body line, then placeholder", () => {
    expect(noteLabel({ title: "會議", bodyMd: "內文" })).toBe("會議");
    expect(noteLabel({ title: null as unknown as string, bodyMd: "第一行\n第二行" })).toBe("第一行");
    expect(noteLabel({ title: "", bodyMd: "  " })).toBe("(未命名)");
  });
});
