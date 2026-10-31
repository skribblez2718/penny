/** Child preload: fail closed before SDK startup. Test instrumentation, not OS isolation. */
import { Socket } from "node:net";
import { appendFileSync } from "node:fs";
import path from "node:path";

function forbiddenNetwork(): never {
  const root = process.env.PROJECT_ROOT;
  if (root !== undefined)
    appendFileSync(
      path.join(root, "observations.jsonl"),
      JSON.stringify({ type: "forbidden_network" }) + "\n"
    );
  throw new Error("Offline direct fixture forbids network before SDK startup");
}
Socket.prototype.connect = forbiddenNetwork;
globalThis.fetch = async () => forbiddenNetwork();
