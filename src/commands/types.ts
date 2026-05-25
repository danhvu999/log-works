export interface CommandServices {
  config: {
    show(input: Record<string, unknown>): Promise<unknown>;
    set(input: Record<string, unknown>): Promise<unknown>;
  };
  fetch: {
    run(input: Record<string, unknown>): Promise<unknown>;
  };
  derive: {
    run(input: Record<string, unknown>): Promise<unknown>;
  };
  export: {
    run(input: Record<string, unknown>): Promise<unknown>;
  };
  netdokTasks: {
    run(input: Record<string, unknown>): Promise<unknown>;
  };
  netdokWorklogs: {
    run(input: Record<string, unknown>): Promise<unknown>;
  };
  storageClearNetdok: {
    run(input: Record<string, unknown>): Promise<unknown>;
  };
  storageReset: {
    run(input: Record<string, unknown>): Promise<unknown>;
  };
}
