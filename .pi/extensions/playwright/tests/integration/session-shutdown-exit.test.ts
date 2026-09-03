import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  ".."
);
const runFile = promisify(execFile);
const localBrowserIt = process.env.PENNY_PLAYWRIGHT_LOCAL_EXIT_TESTS === "1" ? it : it.skip;

describe("Playwright session-shutdown process exit", () => {
  localBrowserIt(
    "opens about:blank, awaits the SDK-session teardown path, and exits",
    async () => {
      const modelClientUrl = pathToFileURL(
        path.join(PROJECT_ROOT, "apps", "orchestration", "src", "model-client.ts")
      ).href;
      const browserUrl = pathToFileURL(
        path.join(PROJECT_ROOT, ".pi", "extensions", "playwright", "browser.ts")
      ).href;
      const script = `
        import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
        import { closeCreatedSession, createWorkerResourceLoader } from ${JSON.stringify(modelClientUrl)};
        import { BrowserManager } from ${JSON.stringify(browserUrl)};

        const projectRoot = ${JSON.stringify(PROJECT_ROOT)};
        const sessionManager = SessionManager.inMemory(projectRoot);
        const resourceLoader = await createWorkerResourceLoader(projectRoot);
        const { session } = await createAgentSession({
          cwd: projectRoot,
          sessionManager,
          resourceLoader,
          tools: ["playwright_navigate"],
        });
        const page = await BrowserManager.getBrowser().getPage();
        if (page.url() !== "about:blank") throw new Error("local browser did not open about:blank");
        await closeCreatedSession(session, sessionManager);
        process.stdout.write("session-shutdown-exit-ok\\n");
      `;

      const result = await runFile("bun", ["--eval", script], {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        env: { ...process.env, PLAYWRIGHT_HEADLESS: "true" },
        timeout: 20_000,
        maxBuffer: 1_048_576,
      });
      expect(String(result.stdout)).toContain("session-shutdown-exit-ok");
    },
    25_000
  );
});
