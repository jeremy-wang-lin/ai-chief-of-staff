import { describe, it, expect } from "vitest";
import { nowLocal, todayLocal, addDays } from "../src/time.ts";

describe("time helpers", () => {
  it("nowLocal is local-time ISO without timezone suffix", () => {
    expect(nowLocal()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    expect(nowLocal().startsWith(todayLocal())).toBe(true); // 同一台機器同一瞬間,日期一定一致
  });
  it("todayLocal matches local date, not UTC", () => {
    const d = new Date();
    const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    expect(todayLocal()).toBe(expected);
  });
  it("addDays crosses month boundary", () => {
    expect(addDays("2026-07-31", 1)).toBe("2026-08-01");
    expect(addDays("2026-08-01", -7)).toBe("2026-07-25");
  });
  it("addDays rejects an unparseable date instead of returning NaN", () => {
    expect(() => addDays("not-a-date", 1)).toThrow(/invalid date: not-a-date/);
  });
});
