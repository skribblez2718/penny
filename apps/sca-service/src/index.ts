#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { loadScaServiceConfig } from "./config.js";
import { startScaService } from "./server.js";

export * from "./adapters.js";
export * from "./config.js";
export * from "./contracts.js";
export * from "./router.js";
export * from "./server.js";

export async function main(): Promise<void> {
  const service = await startScaService(loadScaServiceConfig());
  process.stdout.write("penny-sca-service listening on authenticated local IPC\n");

  const shutdown = (): void => {
    void service
      .shutdown()
      .then(() => {
        process.exitCode = 0;
      })
      .catch((error: unknown) => {
        process.stderr.write(
          `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
        );
        process.exitCode = 1;
      });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exitCode = 1;
  });
}
