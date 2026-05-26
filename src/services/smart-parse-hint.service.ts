import type { ParseEvaluationStatus, SmartParseHint } from "../types/index.ts";

export function computeSmartParseHint(
  statuses: Iterable<ParseEvaluationStatus>,
): SmartParseHint | undefined {
  let emptyCount = 0;
  let partialCount = 0;
  for (const status of statuses) {
    if (status === "empty") emptyCount += 1;
    else if (status === "partial") partialCount += 1;
  }
  const totalNeedingReview = emptyCount + partialCount;
  if (totalNeedingReview === 0) return undefined;
  return {
    emptyCount,
    partialCount,
    totalNeedingReview,
    suggestion:
      "Call log_works_unparsed to list the failing messages, then propose structured entries and pass them to log_works_ingest_entries.",
  };
}
