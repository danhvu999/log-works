import type { CommandServices } from "./types.ts";

export async function handleFetch(
  input: Record<string, unknown>,
  services: CommandServices,
): Promise<unknown> {
  return services.fetch.run(input);
}
