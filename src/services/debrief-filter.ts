const DEBRIEF_PATTERN = /debrief/i;

export function isDebriefText(text: string): boolean {
  return DEBRIEF_PATTERN.test(text);
}
