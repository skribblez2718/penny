import type { Client } from "@caido/sdk-client";

export interface CaidoProjectsParams {
  action: "list" | "select";
  project_id?: string;
}

export async function caidoProjectsImpl(params: CaidoProjectsParams, client: Client): Promise<unknown> {
  switch (params.action) {
    case "list":
      return await client.project.list();
    case "select": {
      if (!params.project_id) throw new Error("project_id is required for select");
      await client.project.select(params.project_id);
      return { selected: params.project_id };
    }
    default:
      throw new Error(`Unknown action: ${params.action}`);
  }
}
