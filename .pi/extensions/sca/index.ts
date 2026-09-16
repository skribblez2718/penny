import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerScaTools } from "./src/tools.js";

/** Registers stable SCA facades only; backend configuration and IPC are call-time concerns. */
export default function scaExtension(pi: ExtensionAPI): void {
  registerScaTools(pi);
}

export {
  SCA_PROVIDER_REGISTRATION_SHA256,
  SCA_PROVIDER_REGISTRATION_V1,
  registerScaTools,
} from "./src/tools.js";
export * from "./src/contracts.js";
