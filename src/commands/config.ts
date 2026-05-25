import type { CommandServices } from "./types.ts";

export async function handleConfigShow(
  input: Record<string, unknown>,
  services: CommandServices,
): Promise<unknown> {
  return services.config.show(input);
}

export async function handleConfigSet(
  input: Record<string, unknown>,
  services: CommandServices,
): Promise<unknown> {
  return services.config.set(input);
}
