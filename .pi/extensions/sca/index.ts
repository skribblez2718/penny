import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerScaTools } from "./src/tools.js";

/** Ordinary registration exposes only the three broker tools, without native setup. */
export function createScaExtensionV1(): (pi: ExtensionAPI) => void {
  return (pi) => {
    registerScaTools(pi);
  };
}

export default createScaExtensionV1();

export {
  SCA_PROVIDER_REGISTRATION_SHA256,
  SCA_PROVIDER_REGISTRATION_V1,
  registerScaTools,
} from "./src/tools.js";
export * from "./src/contracts.js";
