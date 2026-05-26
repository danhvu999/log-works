import { describe, expect, test } from "bun:test";
import { computeSmartParseHint } from "../src/services/smart-parse-hint.service.ts";

describe("computeSmartParseHint", () => {
  test("returns undefined when every status is ok", () => {
    expect(computeSmartParseHint(["ok", "ok", "ok"])).toBeUndefined();
  });

  test("returns undefined for empty input", () => {
    expect(computeSmartParseHint([])).toBeUndefined();
  });

  test("counts empty and partial separately and sums them", () => {
    const hint = computeSmartParseHint([
      "ok",
      "empty",
      "partial",
      "partial",
      "ok",
    ]);
    expect(hint).toEqual({
      emptyCount: 1,
      partialCount: 2,
      totalNeedingReview: 3,
      suggestion:
        "Call log_works_unparsed to list the failing messages, then propose structured entries and pass them to log_works_ingest_entries.",
    });
  });

  test("only-empty input produces emptyCount-only hint", () => {
    const hint = computeSmartParseHint(["empty", "empty"]);
    expect(hint?.emptyCount).toBe(2);
    expect(hint?.partialCount).toBe(0);
    expect(hint?.totalNeedingReview).toBe(2);
  });

  test("only-partial input produces partialCount-only hint", () => {
    const hint = computeSmartParseHint(["partial"]);
    expect(hint?.emptyCount).toBe(0);
    expect(hint?.partialCount).toBe(1);
    expect(hint?.totalNeedingReview).toBe(1);
  });
});
