import type { Client } from "@caido/sdk-client";

export interface CaidoFindingsParams {
  action: "list" | "get" | "create" | "update";
  limit?: number;
  finding_id?: string;
  request_id?: string;
  title?: string;
  description?: string;
  reporter?: string;
  dedupe_key?: string;
  hidden?: boolean;
}

export async function caidoFindingsImpl(
  params: CaidoFindingsParams,
  client: Client
): Promise<unknown> {
  switch (params.action) {
    case "list": {
      const limit = params.limit ?? 50;
      const connection = await client.finding.list().first(limit);
      return connection.edges.map((e) => ({
        id: e.node.id,
        title: e.node.title,
        reporter: e.node.reporter,
        host: e.node.host,
        path: e.node.path,
        hidden: e.node.hidden,
        dedupeKey: e.node.dedupeKey,
        createdAt: e.node.createdAt,
      }));
    }
    case "get": {
      if (!params.finding_id) throw new Error("finding_id is required for get");
      const finding = await client.finding.get(params.finding_id);
      if (!finding) throw new Error(`Finding ${params.finding_id} not found`);
      return finding;
    }
    case "create": {
      if (!params.request_id || !params.title)
        throw new Error("request_id and title are required for create");
      return await client.finding.create(params.request_id, {
        title: params.title,
        reporter: params.reporter || "caido-extension",
        description: params.description,
        dedupeKey: params.dedupe_key,
      });
    }
    case "update": {
      if (!params.finding_id) throw new Error("finding_id is required for update");
      const existing = await client.finding.get(params.finding_id);
      if (!existing) throw new Error(`Finding ${params.finding_id} not found`);
      return await client.finding.update(params.finding_id, {
        title: params.title ?? existing.title,
        description: params.description ?? existing.description ?? "",
        hidden: params.hidden ?? existing.hidden,
      });
    }
    default:
      throw new Error(`Unknown action: ${params.action}`);
  }
}
