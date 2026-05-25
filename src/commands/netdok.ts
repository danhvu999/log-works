import type { CommandServices } from "./types.ts";

export async function handleNetdokTasks(
  input: Record<string, unknown>,
  services: CommandServices,
): Promise<unknown> {
  return services.netdokTasks.run(input);
}

export async function handleNetdokWorklogs(
  input: Record<string, unknown>,
  services: CommandServices,
): Promise<unknown> {
  return services.netdokWorklogs.run(input);
}
