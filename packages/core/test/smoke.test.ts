import { describe, it, expect } from "vitest";
import { CORE_VERSION } from "../src/index.ts";

describe("workspace smoke", () => {
  it("core package resolves", () => {
    expect(CORE_VERSION).toBe("0.1.0");
  });
});
