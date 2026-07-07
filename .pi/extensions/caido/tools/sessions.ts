import type { Client } from "@caido/sdk-client";

export interface CaidoSessionsParams {
  action: "list" | "create" | "rename" | "delete";
  limit?: number;
  session_id?: string;
  request_id?: string;
  name?: string;
}

export async function caidoSessionsImpl(
  params: CaidoSessionsParams,
  client: Client
): Promise<unknown> {
  switch (params.action) {
    case "list": {
      const limit = params.limit ?? 50;
      const connection = await client.replay.sessions.list().first(limit);
      return connection.edges.map((e) => ({
        id: e.node.id,
        name: e.node.name,
        collectionId: e.node.collectionId,
        activeEntryId: e.node.activeEntryId,
      }));
    }
    case "create": {
      if (!params.request_id) throw new Error("request_id is required for create");
      const session = await client.replay.sessions.create({
        requestSource: { id: params.request_id },
      });
      return { id: session.id, name: session.name, collectionId: session.collectionId };
    }
    case "rename": {
      if (!params.session_id || !params.name)
        throw new Error("session_id and name are required for rename");
      await client.replay.sessions.rename(params.session_id, params.name);
      return { id: params.session_id, name: params.name, renamed: true };
    }
    case "delete": {
      if (!params.session_id) throw new Error("session_id is required for delete");
      await client.replay.sessions.delete([params.session_id]);
      return { deleted: params.session_id };
    }
    default:
      throw new Error(`Unknown action: ${params.action}`);
  }
}
