import type { Client } from "@caido/sdk-client";

export interface CaidoEnvironmentsParams {
  action: "list" | "create" | "update" | "delete" | "select" | "set_var";
  env_id?: string;
  name?: string;
  var_name?: string;
  var_value?: string;
}

export async function caidoEnvironmentsImpl(params: CaidoEnvironmentsParams, client: Client): Promise<unknown> {
  switch (params.action) {
    case "list":
      return await client.environment.list();
    case "create": {
      if (!params.name) throw new Error("name is required for create");
      return await client.environment.create({ name: params.name, variables: [] });
    }
    case "delete": {
      if (!params.env_id) throw new Error("env_id is required for delete");
      await client.environment.delete(params.env_id);
      return { deleted: params.env_id };
    }
    case "select": {
      await client.environment.select(params.env_id);
      return { selected: params.env_id || null };
    }
    case "set_var": {
      if (!params.env_id || !params.var_name) throw new Error("env_id and var_name are required for set_var");
      const env = await client.environment.get(params.env_id);
      if (!env) throw new Error(`Environment ${params.env_id} not found`);
      const existing = env.variables.find((v: any) => v.name === params.var_name);
      if (existing) {
        await env.updateVariable(params.var_name, { value: params.var_value || "" });
      } else {
        await env.addVariable({ name: params.var_name, value: params.var_value || "", kind: "PLAIN" });
      }
      return { envId: params.env_id, variable: params.var_name, value: params.var_value, action: existing ? "updated" : "created" };
    }
    default:
      throw new Error(`Unknown action: ${params.action}`);
  }
}
