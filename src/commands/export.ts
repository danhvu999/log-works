import type { CommandServices } from "./types.ts";

export async function handleExport(
  input: Record<string, unknown>,
  services: CommandServices,
): Promise<unknown> {
  return services.export.run(input);
}
