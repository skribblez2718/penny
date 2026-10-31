#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { loadScaServiceConfig } from "./config.js";
import { createScaVmBrokerProductionCompositionV1 } from "./production-vm-config.js";
import { startScaService } from "./server.js";

export * from "./adapters.js";
export * from "./adapters/dependency-inventory-v2.js";
export * from "./adapters/osv-v2.js";
export * from "./adapters/osv-v2-fixed-ip.js";
export * from "./adapters/tree-sitter-index.js";
export * from "./config.js";
export * from "./contracts.js";
export * from "./jobs.js";
export * from "./job-store.js";
export * from "./p01-joern-root.js";
export * from "./p02-component-authority.js";
export * from "./p02-osv-host.js";
export * from "./p02-operations.js";
export * from "./p02-production-runtime.js";
export {
  createP02HostProcessRunnerV1,
  type P02ControlledProcessRunnerV1,
} from "./p02-host-process-runner.js";
export { type HostTree } from "./p02-host-tree.js";
export {
  runP02HostCanary,
  P02_HOST_REQUEST_SCHEMA,
  P02_HOST_RECEIPT_SCHEMA,
  type P02HostRequest,
  type P02HostOutcome,
} from "./p02-host-harness.js";
export * from "./p03-operations.js";
export * from "./p03-production-runtime.js";
export * from "./p07-vm-runtime.js";
export * from "./production-vm-config.js";
export * from "./router.js";
export * from "./server.js";
export * from "./source-custody-materializer.js";
export * from "./vm-broker-adapter.js";
export { ArtifactStore as ScaVmArtifactStore } from "../../orchestration/dist/artifact-store.js";

export async function main(): Promise<void> {
  const productionConfigPath = process.env.PENNY_SCA_SERVICE_VM_CONFIG;
  if (productionConfigPath === undefined || productionConfigPath.length === 0) {
    throw new Error(
      "PENNY_SCA_SERVICE_VM_CONFIG is required; the production binary will not start with null adapters"
    );
  }
  const production = createScaVmBrokerProductionCompositionV1(productionConfigPath);
  let service: Awaited<ReturnType<typeof startScaService>>;
  try {
    service = await startScaService(loadScaServiceConfig(), {
      adapters: production.adapters,
      jobStore: production.jobStore,
    });
  } catch (error) {
    production.close();
    throw error;
  }
  process.stdout.write("penny-sca-service listening with qualified VM broker adapters\n");

  let shutdownStarted = false;
  const shutdown = (): void => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    void service
      .shutdown()
      .then(() => {
        production.close();
        process.exitCode = 0;
      })
      .catch((error: unknown) => {
        try {
          production.close();
        } catch {
          // Preserve the service shutdown error as primary.
        }
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
