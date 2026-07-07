import type { Client } from "@caido/sdk-client";

export interface CaidoSearchParams {
  filter?: string;
  limit?: number;
  after?: string;
  ids_only?: boolean;
  recent_only?: boolean;
}

export async function caidoSearchImpl(params: CaidoSearchParams, client: Client): Promise<unknown> {
  let limit = params.limit ?? 50;
  if (limit < 1) limit = 1;
  if (limit > 500) limit = 500;

  let builder;
  if (params.recent_only) {
    builder = client.request.list().descending("req", "id").first(limit);
  } else {
    const filter = params.filter || "";
    builder = client.request.list().filter(filter).first(limit);
    if (params.after) {
      builder = builder.after(params.after);
    }
  }

  const connection = await builder;

  if (params.ids_only) {
    const ids = connection.edges.map((e) => e.node.request.id);
    return { ids, count: ids.length };
  }

  const results = connection.edges.map((e) => ({
    id: e.node.request.id,
    method: e.node.request.method,
    host: e.node.request.host,
    path: e.node.request.path,
    query: e.node.request.query || undefined,
    isTls: e.node.request.isTls,
    port: e.node.request.port,
    statusCode: e.node.response?.statusCode,
    roundtrip: e.node.response?.roundtripTime,
    responseLength: e.node.response?.length,
    createdAt: e.node.request.createdAt,
    cursor: e.cursor,
  }));

  return {
    results,
    pageInfo: connection.pageInfo,
    count: results.length,
  };
}
