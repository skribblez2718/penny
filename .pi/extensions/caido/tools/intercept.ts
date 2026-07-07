import type { Client } from "@caido/sdk-client";
import { INTERCEPT_OPTIONS_QUERY, PAUSE_INTERCEPT, RESUME_INTERCEPT } from "../graphql.js";
import type {
  InterceptOptionsResult,
  PauseInterceptResult,
  ResumeInterceptResult,
} from "../graphql.js";

export interface CaidoInterceptParams {
  action: "status" | "enable" | "disable";
}

export async function caidoInterceptImpl(
  params: CaidoInterceptParams,
  client: Client
): Promise<unknown> {
  switch (params.action) {
    case "status": {
      const result = await client.graphql.query<InterceptOptionsResult, Record<string, never>>(
        INTERCEPT_OPTIONS_QUERY,
        {}
      );
      return result.interceptOptions;
    }
    case "enable": {
      const result = await client.graphql.mutation<ResumeInterceptResult, Record<string, never>>(
        RESUME_INTERCEPT,
        {}
      );
      return result.resumeIntercept;
    }
    case "disable": {
      const result = await client.graphql.mutation<PauseInterceptResult, Record<string, never>>(
        PAUSE_INTERCEPT,
        {}
      );
      return result.pauseIntercept;
    }
    default:
      throw new Error(`Unknown action: ${params.action}`);
  }
}
