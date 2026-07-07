import type { Client } from "@caido/sdk-client";
import { PLUGIN_PACKAGES_QUERY } from "../graphql.js";
import type { PluginPackagesResult } from "../graphql.js";

export interface CaidoInfoParams {
  mode: "health" | "viewer" | "plugins";
}

export async function caidoInfoImpl(params: CaidoInfoParams, client: Client): Promise<unknown> {
  switch (params.mode) {
    case "health":
      return await client.health();
    case "viewer":
      return await client.user.viewer();
    case "plugins": {
      const result = await client.graphql.query<PluginPackagesResult, Record<string, never>>(
        PLUGIN_PACKAGES_QUERY,
        {}
      );
      return result.pluginPackages;
    }
    default:
      throw new Error(`Unknown mode: ${params.mode}`);
  }
}
