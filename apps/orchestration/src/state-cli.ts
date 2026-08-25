#!/usr/bin/env node

import { executeStateCommand } from "./state/command.js";

try {
  const result = await executeStateCommand(process.argv.slice(2));
  if (result.action === "help") process.stdout.write(`${result.text}\n`);
  else process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ error: "PennyStateError", message })}\n`);
  process.exitCode = 1;
}
