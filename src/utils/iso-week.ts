export interface IsoWeekRange {
  weekStart: string;
  weekEnd: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function isoWeekRange(date: string): IsoWeekRange {
  const base = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) {
    throw new Error(`Invalid date: ${date}`);
  }
  const dayOfWeek = base.getUTCDay();
  const mondayOffset = (dayOfWeek + 6) % 7;
  const start = new Date(base.getTime() - mondayOffset * DAY_MS);
  const end = new Date(start.getTime() + 6 * DAY_MS);
  return {
    weekStart: start.toISOString().slice(0, 10),
    weekEnd: end.toISOString().slice(0, 10),
  };
}

export function isoWeekTaskName(date: string, project: string): string {
  const { weekStart, weekEnd } = isoWeekRange(date);
  return `[${project}] Task issues from ${weekStart} to ${weekEnd}`;
}
