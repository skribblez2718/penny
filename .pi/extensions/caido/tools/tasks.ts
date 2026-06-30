import type { Client } from "@caido/sdk-client";

export interface CaidoTasksParams {
  action: "list" | "cancel";
  task_id?: string;
}

export async function caidoTasksImpl(params: CaidoTasksParams, client: Client): Promise<unknown> {
  switch (params.action) {
    case "list":
      return await client.task.list();
    case "cancel": {
      if (!params.task_id) throw new Error("task_id is required for cancel");
      await client.task.cancel(params.task_id);
      return { cancelled: params.task_id };
    }
    default:
      throw new Error(`Unknown action: ${params.action}`);
  }
}
