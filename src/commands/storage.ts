import type { CommandServices } from "./types.ts";

export async function handleStorageClearNetdok(
  input: Record<string, unknown>,
  services: CommandServices,
): Promise<unknown> {
  return services.storageClearNetdok.run(input);
}

export async function handleStorageReset(
  input: Record<string, unknown>,
  services: CommandServices,
): Promise<unknown> {
  return services.storageReset.run(input);
}
