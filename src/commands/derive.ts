import type { CommandServices } from "./types.ts";

export async function handleDerive(
  input: Record<string, unknown>,
  services: CommandServices,
): Promise<unknown> {
  return services.derive.run(input);
}
