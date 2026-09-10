import { accessSync, constants } from "node:fs";

import { chromium } from "playwright";

import { loadConfig } from "../config.js";

function fail(message: string): never {
  process.stderr.write(`Playwright release browser prerequisite failed: ${message}\n`);
  process.exit(1);
}

function verifyReleaseBrowserPrerequisites(): void {
  if (process.env.PENNY_PLAYWRIGHT_BROWSER_TESTS !== "1") {
    fail("set PENNY_PLAYWRIGHT_BROWSER_TESTS=1 to authorize local Chromium execution");
  }

  const config = loadConfig(process.cwd());
  const browserPath = config.browserPath ?? chromium.executablePath();
  try {
    accessSync(browserPath, constants.R_OK | constants.X_OK);
  } catch {
    fail(`Chromium executable is missing or not executable at ${browserPath}`);
  }

  process.stdout.write(`Playwright release browser prerequisites verified: ${browserPath}\n`);
}

verifyReleaseBrowserPrerequisites();
