export interface MockRestconfServer {
  readonly server: import("node:http").Server;
  listen(port?: number, host?: string): Promise<string>;
  close(): Promise<void>;
}

export function createMockRestconfServer(options?: {
  data?: Record<string, unknown>;
  cors?: boolean;
}): MockRestconfServer;
