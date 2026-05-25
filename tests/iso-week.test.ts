import { describe, expect, test } from "bun:test";
import { isoWeekRange, isoWeekTaskName } from "../src/utils/iso-week.ts";

describe("isoWeekRange", () => {
  test("Monday is the start of its own week", () => {
    expect(isoWeekRange("2026-05-18")).toEqual({
      weekStart: "2026-05-18",
      weekEnd: "2026-05-24",
    });
  });

  test("Sunday rolls back to the previous Monday", () => {
    expect(isoWeekRange("2026-05-24")).toEqual({
      weekStart: "2026-05-18",
      weekEnd: "2026-05-24",
    });
  });

  test("midweek Thursday returns the surrounding Mon-Sun", () => {
    expect(isoWeekRange("2026-05-21")).toEqual({
      weekStart: "2026-05-18",
      weekEnd: "2026-05-24",
    });
  });

  test("crosses month boundaries", () => {
    expect(isoWeekRange("2026-06-02")).toEqual({
      weekStart: "2026-06-01",
      weekEnd: "2026-06-07",
    });
  });

  test("crosses year boundaries", () => {
    // 2026-12-30 is Wednesday; its ISO week starts Mon 2026-12-28.
    expect(isoWeekRange("2026-12-30")).toEqual({
      weekStart: "2026-12-28",
      weekEnd: "2027-01-03",
    });
  });

  test("rejects invalid date strings", () => {
    expect(() => isoWeekRange("not-a-date")).toThrow();
  });
});

describe("isoWeekTaskName", () => {
  test("formats the canonical task name with project prefix", () => {
    expect(isoWeekTaskName("2026-05-21", "Venulog")).toBe(
      "[Venulog] Task issues from 2026-05-18 to 2026-05-24",
    );
  });
});
