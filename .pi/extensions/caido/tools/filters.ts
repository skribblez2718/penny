import type { Client } from "@caido/sdk-client";

export interface CaidoFiltersParams {
  action: "list" | "create" | "update" | "delete";
  filter_id?: string;
  name?: string;
  query?: string;
  alias?: string;
}

/** Auto-generate an alias from a filter name: lowercase, spaces→hyphens, strip special chars */
function nameToAlias(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

export async function caidoFiltersImpl(params: CaidoFiltersParams, client: Client): Promise<unknown> {
  switch (params.action) {
    case "list":
      return await client.filter.list();
    case "create": {
      if (!params.name || !params.query) throw new Error("name and query are required for create");
      const createOpts: any = {
        name: params.name,
        clause: params.query,
        alias: params.alias || nameToAlias(params.name),
      };
      return await client.filter.create(createOpts);
    }
    case "update": {
      if (!params.filter_id) throw new Error("filter_id is required for update");
      const existing = await client.filter.get(params.filter_id);
      if (!existing) throw new Error(`Filter ${params.filter_id} not found`);
      return await client.filter.update(params.filter_id, {
        name: params.name ?? existing.name,
        clause: params.query ?? existing.clause,
        alias: params.alias ?? existing.alias,
      });
    }
    case "delete": {
      if (!params.filter_id) throw new Error("filter_id is required for delete");
      await client.filter.delete(params.filter_id);
      return { deleted: params.filter_id };
    }
    default:
      throw new Error(`Unknown action: ${params.action}`);
  }
}
