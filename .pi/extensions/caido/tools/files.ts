import type { Client } from "@caido/sdk-client";

export interface CaidoFilesParams {
  action: "list" | "delete";
  file_id?: string;
}

export async function caidoFilesImpl(params: CaidoFilesParams, client: Client): Promise<unknown> {
  switch (params.action) {
    case "list":
      return await client.hostedFile.list();
    case "delete": {
      if (!params.file_id) throw new Error("file_id is required for delete");
      await client.hostedFile.delete(params.file_id);
      return { deleted: params.file_id };
    }
    default:
      throw new Error(`Unknown action: ${params.action}`);
  }
}
