import type { Client } from "@caido/sdk-client";

export interface CaidoCollectionsParams {
  action: "list" | "create" | "rename" | "delete";
  limit?: number;
  collection_id?: string;
  name?: string;
}

export async function caidoCollectionsImpl(
  params: CaidoCollectionsParams,
  client: Client
): Promise<unknown> {
  switch (params.action) {
    case "list": {
      const limit = params.limit ?? 50;
      const connection = await client.replay.collections.list().first(limit);
      return connection.edges.map((e) => ({
        id: e.node.id,
        name: e.node.name,
      }));
    }
    case "create": {
      if (!params.name) throw new Error("name is required for create");
      const collection = await client.replay.collections.create({ name: params.name });
      return { id: collection.id, name: collection.name };
    }
    case "rename": {
      if (!params.collection_id || !params.name)
        throw new Error("collection_id and name are required for rename");
      await client.replay.collections.rename(params.collection_id, params.name);
      return { id: params.collection_id, name: params.name, renamed: true };
    }
    case "delete": {
      if (!params.collection_id) throw new Error("collection_id is required for delete");
      await client.replay.collections.delete(params.collection_id);
      return { deleted: params.collection_id };
    }
    default:
      throw new Error(`Unknown action: ${params.action}`);
  }
}
