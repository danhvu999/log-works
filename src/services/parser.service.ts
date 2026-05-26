import type {
  ParseEvaluation,
  ParseEvaluationFlags,
  ParseEvaluationStatus,
  ParsedWorkLog,
} from "../types/index.ts";

const BULLET = /^\s*•\s+(.+)$/;
const SUBBULLET = /^\s*◦\s+(.+)$/;
const HOURS = /\[(\d+(?:\.\d+)?)\s*h?\]/i;
const SECTION = /^(Brief|Debrief)\b\s*:?\s*(.*)$/;
const LINK_LABELED = /<([^>|]+)\|([^>]+)>/g;
const LINK_BARE = /<([^>]+)>/g;
const BRACKET_WRAP = /^\[(.+)\]$/;

export const UNSPECIFIED_PROJECT = "_unspecified";

const MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

export type DateHint =
  | { kind: "today" }
  | { kind: "yesterday" }
  | { kind: "monthday"; month: number; day: number };

export function parseMessageText(text: string): ParsedWorkLog[] {
  return evaluateMessage(text).entries;
}

export function evaluateMessage(text: string): ParseEvaluation {
  const lines = text.split("\n");
  let inDebrief = false;
  let project = UNSPECIFIED_PROJECT;
  let index = 0;
  let hasDebriefMarker = false;
  const out: ParsedWorkLog[] = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    const sectionMatch = trimmed.match(SECTION);

    if (sectionMatch) {
      const isDebrief = sectionMatch[1] === "Debrief";
      inDebrief = isDebrief;
      if (isDebrief) hasDebriefMarker = true;
      project = UNSPECIFIED_PROJECT;
      continue;
    }

    if (!inDebrief || trimmed.length === 0) {
      continue;
    }

    const bullet = trimmed.match(BULLET);
    if (bullet) {
      const cleaned = cleanSlackLinks(bullet[1] ?? "");
      const { text: stripped, hours } = extractHours(cleaned);
      out.push({
        index: index++,
        project,
        text: stripped.trim(),
        hours,
      });
      continue;
    }

    const sub = trimmed.match(SUBBULLET);
    if (sub) {
      const last = out.at(-1);
      if (last) {
        const subText = cleanSlackLinks(sub[1] ?? "").trim();
        last.text = `${last.text}\n${subText}`;
      }
      continue;
    }

    project = normalizeProjectHeader(trimmed);
  }

  const missingProject = out.some(
    (entry) => entry.project === UNSPECIFIED_PROJECT,
  );
  const missingHours = out.some((entry) => entry.hours === null);
  const status: ParseEvaluationStatus =
    out.length === 0
      ? "empty"
      : missingProject || missingHours
        ? "partial"
        : "ok";

  const flags: ParseEvaluationFlags = {
    missingProject,
    missingHours,
    hasDebriefMarker,
  };

  return { entries: out, status, flags };
}

export function normalizeProjectHeader(raw: string): string {
  let value = raw.replace(/:\s*$/, "");
  value = value.replace(HOURS, "").trim();
  const bracket = value.match(BRACKET_WRAP);
  if (bracket) {
    value = bracket[1]?.trim() ?? value;
  }
  return value || UNSPECIFIED_PROJECT;
}

export function extractDateHint(text: string): DateHint | null {
  for (const rawLine of text.split("\n")) {
    const trimmed = rawLine.trim();
    const sectionMatch = trimmed.match(SECTION);
    if (!sectionMatch) continue;
    if (sectionMatch[1] !== "Debrief") continue;
    const suffix = (sectionMatch[2] ?? "").trim();
    if (!suffix) return null;
    return parseDateSuffix(suffix);
  }
  return null;
}

function parseDateSuffix(suffix: string): DateHint | null {
  const lower = suffix.toLowerCase();
  if (lower === "today") return { kind: "today" };
  if (lower === "yesterday") return { kind: "yesterday" };
  const monthDay = suffix.match(/^([A-Za-z]+)\s+(\d{1,2})$/);
  if (monthDay) {
    const month = MONTHS[monthDay[1]?.toLowerCase() ?? ""];
    const day = Number(monthDay[2]);
    if (month !== undefined && Number.isInteger(day) && day >= 1 && day <= 31) {
      return { kind: "monthday", month, day };
    }
  }
  return null;
}

export function applyDateHint(baseDate: string, hint: DateHint): string {
  const base = new Date(`${baseDate}T00:00:00Z`);
  if (hint.kind === "today") {
    return baseDate;
  }
  if (hint.kind === "yesterday") {
    base.setUTCDate(base.getUTCDate() - 1);
    return base.toISOString().slice(0, 10);
  }
  let year = base.getUTCFullYear();
  let candidate = new Date(Date.UTC(year, hint.month, hint.day));
  if (candidate.getTime() > base.getTime()) {
    year -= 1;
    candidate = new Date(Date.UTC(year, hint.month, hint.day));
  }
  return candidate.toISOString().slice(0, 10);
}

export function cleanSlackLinks(value: string): string {
  return value
    .replace(LINK_LABELED, (_, _url, label) => label)
    .replace(LINK_BARE, (_, url) => url);
}

export function extractHours(value: string): {
  text: string;
  hours: number | null;
} {
  const match = value.match(HOURS);
  if (!match) {
    return { text: value, hours: null };
  }
  const hours = Number(match[1]);
  if (Number.isNaN(hours)) {
    return { text: value, hours: null };
  }
  const stripped = value
    .replace(HOURS, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return { text: stripped, hours };
}
