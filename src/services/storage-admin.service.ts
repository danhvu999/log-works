import { loadConfig, resolveStoragePath } from "../config/config.manager.ts";
import type {
  LogWorksConfig,
  StorageClearNetdokSummary,
  StorageResetSummary,
} from "../types/index.ts";
import {
  clearNetdokData,
  readDatabase,
  resetDatabase,
  writeDatabase,
} from "./storage.service.ts";

export interface ClearNetdokStorageInput {
  from?: string;
  to?: string;
  apply?: boolean;
  config?: LogWorksConfig;
}

export interface ResetStorageInput {
  apply?: boolean;
  config?: LogWorksConfig;
}

export async function clearNetdokStorage(
  input: ClearNetdokStorageInput = {},
): Promise<StorageClearNetdokSummary> {
  const config = input.config ?? (await loadConfig());
  const storagePath = resolveStoragePath(config);
  const database = await readDatabase(storagePath);
  const result = clearNetdokData(database, {
    from: input.from,
    to: input.to,
  });

  if (input.apply) {
    await writeDatabase(storagePath, result.database);
  }

  return {
    clearedWeekTasks: result.clearedWeekTasks,
    resetEntries: result.resetEntries,
    applied: Boolean(input.apply),
    storagePath,
    from: input.from,
    to: input.to,
  };
}

export async function resetStorage(
  input: ResetStorageInput = {},
): Promise<StorageResetSummary> {
  const config = input.config ?? (await loadConfig());
  const storagePath = resolveStoragePath(config);
  const database = await readDatabase(storagePath);
  const result = resetDatabase(database);

  if (input.apply) {
    await writeDatabase(storagePath, result.database);
  }

  return {
    removedRawMessages: result.removedRawMessages,
    removedWorkLogs: result.removedWorkLogs,
    removedNetdokWeekTasks: result.removedNetdokWeekTasks,
    clearedMeta: result.clearedMeta,
    applied: Boolean(input.apply),
    storagePath,
  };
}
