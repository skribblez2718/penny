#!/usr/bin/env node

import { executeStateCommand } from "./state/command.js";
import { PennyStateResolutionError } from "./state/setup.js";

try {
  const result = await executeStateCommand(process.argv.slice(2));
  if (result.action === "help") process.stdout.write(`${result.text}\n`);
  else process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const failure =
    error instanceof PennyStateResolutionError
      ? {
          error: "PennyStateError",
          code: error.code,
          message,
          details: error.details,
        }
      : { error: "PennyStateError", message };
  process.stderr.write(`${JSON.stringify(failure)}\n`);
  process.exitCode = 1;
}
