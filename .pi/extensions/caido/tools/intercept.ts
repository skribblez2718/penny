import type { Client } from "@caido/sdk-client";
import { INTERCEPT_OPTIONS_QUERY, PAUSE_INTERCEPT, RESUME_INTERCEPT } from "../graphql.js";

export interface CaidoInterceptParams {
  action: "status" | "enable" | "disable";
}

export async function caidoInterceptImpl(params: CaidoInterceptParams, client: Client): Promise<unknown> {
  switch (params.action) {
    case "status": {
      const result = await client.graphql.query(INTERCEPT_OPTIONS_QUERY, {});
      return (result as any).interceptOptions;
    }
    case "enable": {
      const result = await client.graphql.mutation(RESUME_INTERCEPT, {});
      return (result as any).resumeIntercept;
    }
    case "disable": {
      const result = await client.graphql.mutation(PAUSE_INTERCEPT, {});
      return (result as any).pauseIntercept;
    }
    default:
      throw new Error(`Unknown action: ${params.action}`);
  }
}
