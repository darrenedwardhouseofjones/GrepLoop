import { describe, it, expect } from "vitest";
import { getStatusBadgeStyle } from "../src/lib/types";

describe("getStatusBadgeStyle", () => {
  it("returns blue styling for In Progress", () => {
    expect(getStatusBadgeStyle("In Progress")).toContain("blue");
  });

  it("returns emerald styling for Completed", () => {
    expect(getStatusBadgeStyle("Completed")).toContain("emerald");
  });

  it("returns emerald styling for scanned", () => {
    expect(getStatusBadgeStyle("scanned")).toContain("emerald");
  });

  it("returns rose styling for Failed", () => {
    expect(getStatusBadgeStyle("Failed")).toContain("rose");
  });

  it("falls back to amber for unknown / Pending / open", () => {
    expect(getStatusBadgeStyle("Pending")).toContain("amber");
    expect(getStatusBadgeStyle("open")).toContain("amber");
    expect(getStatusBadgeStyle("anything-else")).toContain("amber");
  });
});
