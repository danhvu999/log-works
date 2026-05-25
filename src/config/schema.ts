import type { LogWorksConfig } from "../types/index.ts";

export function isLogWorksConfig(value: unknown): value is LogWorksConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
