import { describe, expect, test } from "bun:test";
import { isDebriefText } from "../src/services/debrief-filter.ts";

describe("isDebriefText", () => {
  test("matches canonical `Debrief:` opener", () => {
    expect(isDebriefText("Debrief:\nVenulog\n• Fixed bug [1h]")).toBe(true);
  });

  test("matches case-insensitively", () => {
    expect(isDebriefText("DEBRIEF for 2026-05-24")).toBe(true);
    expect(isDebriefText("debrief - quick note")).toBe(true);
  });

  test("matches anywhere in the text, not just at the start", () => {
    expect(isDebriefText("Sending you my debrief later today")).toBe(true);
  });

  test("rejects messages with no `debrief` substring", () => {
    expect(isDebriefText("Brief:\nMetabase\n• Plan migration [2h]")).toBe(
      false,
    );
    expect(isDebriefText("lunch?")).toBe(false);
    expect(isDebriefText("<https://example.com/issue/18>")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(isDebriefText("")).toBe(false);
  });
});
