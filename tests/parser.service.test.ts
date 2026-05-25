import { describe, expect, test } from "bun:test";
import {
  UNSPECIFIED_PROJECT,
  applyDateHint,
  cleanSlackLinks,
  evaluateMessage,
  extractDateHint,
  extractHours,
  normalizeProjectHeader,
  parseMessageText,
} from "../src/services/parser.service.ts";

describe("parser — section selection", () => {
  test("pure Brief message yields no entries", () => {
    const text = "Brief:\nMetabase\n• Plan migration [2h]";
    expect(parseMessageText(text)).toEqual([]);
  });

  test("pure Debrief yields one entry per bullet", () => {
    const text =
      "Debrief:\nMetabase\n• First [1h]\n• Second [2h]\n• Third [3h]";
    const out = parseMessageText(text);
    expect(out.map((e) => e.text)).toEqual(["First", "Second", "Third"]);
    expect(out.map((e) => e.hours)).toEqual([1, 2, 3]);
  });

  test("Debrief then Brief in same message returns only the Debrief bullets", () => {
    const text =
      "Debrief: Yesterday\nVenulog\n• Shipped [3h]\nBrief:\nVenulog\n• Plan [4h]";
    const out = parseMessageText(text);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      project: "Venulog",
      text: "Shipped",
      hours: 3,
    });
  });
});

describe("parser — project headers", () => {
  test("multiple project headers assign by position", () => {
    const text =
      "Debrief:\nMetabase:\n• Task A [1h]\nVenulog:\n• Task B [2h]\n• Task C [3h]";
    const out = parseMessageText(text);
    expect(out.map((e) => e.project)).toEqual([
      "Metabase",
      "Venulog",
      "Venulog",
    ]);
  });

  test("project header without colon still recognised", () => {
    const text = "Debrief:\nVenulog\n• Task [1h]";
    const out = parseMessageText(text);
    expect(out[0]?.project).toBe("Venulog");
  });

  test("bullets before any header fall under _unspecified", () => {
    const text =
      "Debrief:\n• Orphan bullet [0.5h]\nMetabase\n• Has project [1h]";
    const out = parseMessageText(text);
    expect(out[0]?.project).toBe(UNSPECIFIED_PROJECT);
    expect(out[1]?.project).toBe("Metabase");
  });
});

describe("parser — bullet content", () => {
  test("sub-bullets fold into preceding bullet's text on new lines", () => {
    const text =
      "Debrief:\nMetabase\n• Task [2h]\n    ◦ subtask one\n    ◦ subtask two";
    const out = parseMessageText(text);
    expect(out).toHaveLength(1);
    expect(out[0]?.text).toBe("Task\nsubtask one\nsubtask two");
  });

  test("missing hours keeps entry with hours=null", () => {
    const text = "Debrief:\nMetabase\n• Task with no hours\n• Has hours [1h]";
    const out = parseMessageText(text);
    expect(out[0]).toMatchObject({ text: "Task with no hours", hours: null });
    expect(out[1]).toMatchObject({ text: "Has hours", hours: 1 });
  });

  test("Slack link markup is normalised", () => {
    const text =
      "Debrief:\nVenulog\n• Fixed <https://example.com/i/3586|#3586> [1h]\n• Saw <https://example.com/i/3582>";
    const out = parseMessageText(text);
    expect(out[0]?.text).toBe("Fixed #3586");
    expect(out[1]?.text).toBe("Saw https://example.com/i/3582");
  });
});

describe("parser — helpers", () => {
  test("extractHours strips trailing [Nh] and parses decimals", () => {
    expect(extractHours("Task [0.25h]")).toEqual({ text: "Task", hours: 0.25 });
    expect(extractHours("Task [8h]")).toEqual({ text: "Task", hours: 8 });
    expect(extractHours("Task")).toEqual({ text: "Task", hours: null });
  });

  test("cleanSlackLinks handles labeled + bare links", () => {
    expect(cleanSlackLinks("see <https://a|alpha> and <https://b>")).toBe(
      "see alpha and https://b",
    );
  });
});

describe("parser — project header normalization", () => {
  test("unwraps [Name] bracket form", () => {
    expect(normalizeProjectHeader("[Venulog]")).toBe("Venulog");
  });

  test("strips trailing [Nh] from header (project-total hours)", () => {
    expect(normalizeProjectHeader("Metabase [4.5h]")).toBe("Metabase");
    expect(normalizeProjectHeader("Dealer tool [1h]")).toBe("Dealer tool");
  });

  test("strips trailing colon", () => {
    expect(normalizeProjectHeader("Metabase:")).toBe("Metabase");
  });

  test("combines bracket + trailing hours", () => {
    expect(normalizeProjectHeader("[Venulog] [2h]")).toBe("Venulog");
  });

  test("parseMessageText recognises [Project] bracket header", () => {
    const text = "Debrief: May 11\n[Venulog]\n• Shipped [4h]";
    const out = parseMessageText(text);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ project: "Venulog", hours: 4 });
  });

  test("parseMessageText recognises Project [Xh] header total", () => {
    const text =
      "Debrief:\nMetabase [4.5h]\n• Researched sync flow\n• Researched clickhouse";
    const out = parseMessageText(text);
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.project)).toEqual(["Metabase", "Metabase"]);
    expect(out.map((e) => e.hours)).toEqual([null, null]);
  });
});

describe("parser — date hint", () => {
  test("returns null when no suffix after Debrief:", () => {
    expect(extractDateHint("Debrief:\nVenulog\n• Task [1h]")).toBeNull();
  });

  test("recognises Yesterday", () => {
    expect(extractDateHint("Debrief: Yesterday\nVenulog\n• Task")).toEqual({
      kind: "yesterday",
    });
  });

  test("recognises Today", () => {
    expect(extractDateHint("Debrief: Today\nVenulog\n• Task")).toEqual({
      kind: "today",
    });
  });

  test("recognises Month Day forms", () => {
    expect(extractDateHint("Debrief: May 4\nVenulog\n• Task")).toEqual({
      kind: "monthday",
      month: 4,
      day: 4,
    });
    expect(extractDateHint("Debrief: November 30\nVenulog\n• Task")).toEqual({
      kind: "monthday",
      month: 10,
      day: 30,
    });
  });

  test("ignores unrecognised suffix", () => {
    expect(
      extractDateHint("Debrief: weekly recap\nVenulog\n• Task"),
    ).toBeNull();
  });

  test("ignores Brief: marker", () => {
    expect(extractDateHint("Brief: Yesterday\nVenulog\n• Task")).toBeNull();
  });
});

describe("parser — evaluateMessage status flags", () => {
  test("freeform message yields empty status and no debrief marker", () => {
    const result = evaluateMessage(
      "Today I shipped a fix on Venulog: invoice line bug took maybe 2 hours.",
    );
    expect(result.entries).toEqual([]);
    expect(result.status).toBe("empty");
    expect(result.flags).toEqual({
      missingProject: false,
      missingHours: false,
      hasDebriefMarker: false,
    });
  });

  test("Debrief with non-`•` bullets yields empty + marker flag", () => {
    const result = evaluateMessage(
      "Debrief:\nVenulog\n- Fixed dashboard regression\n- Reviewed PR #42",
    );
    expect(result.entries).toEqual([]);
    expect(result.status).toBe("empty");
    expect(result.flags.hasDebriefMarker).toBe(true);
  });

  test("bullet missing hours marks status partial + missingHours", () => {
    const result = evaluateMessage(
      "Debrief:\nMetabase\n• Worked on something but forgot to write hours",
    );
    expect(result.entries).toHaveLength(1);
    expect(result.status).toBe("partial");
    expect(result.flags.missingHours).toBe(true);
    expect(result.flags.missingProject).toBe(false);
  });

  test("bullet with project + hours marks status ok", () => {
    const result = evaluateMessage("Debrief:\nMetabase\n• Plan migration [2h]");
    expect(result.status).toBe("ok");
    expect(result.flags).toEqual({
      missingProject: false,
      missingHours: false,
      hasDebriefMarker: true,
    });
  });

  test("bullet under _unspecified marks missingProject partial", () => {
    const result = evaluateMessage("Debrief:\n• Orphan bullet [0.5h]");
    expect(result.status).toBe("partial");
    expect(result.flags.missingProject).toBe(true);
  });
});

describe("parser — applyDateHint", () => {
  test("Yesterday subtracts one UTC day", () => {
    expect(applyDateHint("2026-05-06", { kind: "yesterday" })).toBe(
      "2026-05-05",
    );
  });

  test("Today returns base", () => {
    expect(applyDateHint("2026-05-06", { kind: "today" })).toBe("2026-05-06");
  });

  test("Month Day uses same year when not in the future", () => {
    expect(
      applyDateHint("2026-05-11", { kind: "monthday", month: 4, day: 7 }),
    ).toBe("2026-05-07");
  });

  test("Month Day rolls back a year when otherwise in the future", () => {
    expect(
      applyDateHint("2026-02-15", { kind: "monthday", month: 11, day: 20 }),
    ).toBe("2025-12-20");
  });
});
