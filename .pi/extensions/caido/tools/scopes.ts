import type { Client } from "@caido/sdk-client";

export interface CaidoScopesParams {
  action: "list" | "create" | "update" | "delete";
  scope_id?: string;
  name?: string;
  allowlist?: string[];
  denylist?: string[];
}

export async function caidoScopesImpl(params: CaidoScopesParams, client: Client): Promise<unknown> {
  switch (params.action) {
    case "list":
      return await client.scope.list();
    case "create": {
      if (!params.name) throw new Error("name is required for create");
      const allow = params.allowlist || ["*"];
      const deny = params.denylist || [];
      return await client.scope.create({ name: params.name, allowlist: allow, denylist: deny });
    }
    case "update": {
      if (!params.scope_id) throw new Error("scope_id is required for update");
      const existing = await client.scope.get(params.scope_id);
      if (!existing) throw new Error(`Scope ${params.scope_id} not found`);
      return await client.scope.update(params.scope_id, {
        name: params.name ?? existing.name,
        allowlist: params.allowlist ?? existing.allowlist,
        denylist: params.denylist ?? existing.denylist,
      });
    }
    case "delete": {
      if (!params.scope_id) throw new Error("scope_id is required for delete");
      await client.scope.delete(params.scope_id);
      return { deleted: params.scope_id };
    }
    default:
      throw new Error(`Unknown action: ${params.action}`);
  }
}
