import { createServer, type IncomingMessage, type Server } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PlatformMemoryClientV1,
  assertDistinctIsolatedMemoryConfigsV1,
  type IsolatedPlatformMemoryConfigV1,
  type PlatformMemoryOperation,
} from "../../src/index.js";
import { ALPHA_TOKEN, BETA_TOKEN, isolatedConfig } from "../fixtures.js";

interface Drawer {
  drawer_id: string;
  content: string;
  wing: string;
  room: string;
}

interface SyntheticPalace {
  token: string;
  diaryId: string;
  drawers: Map<string, Drawer>;
  facts: Array<{ subject: string; predicate: string; object: string }>;
  diary: string[];
  calls: string[];
}

const servers: Server[] = [];

function rpcResult(id: string, data: Record<string, unknown>): Buffer {
  return Buffer.from(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: JSON.stringify(data) }] },
    })
  );
}

async function startSyntheticPalace(state: SyntheticPalace): Promise<string> {
  const server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      if (request.headers.authorization !== `Bearer ${state.token}`) {
        response.writeHead(403).end();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        id: string;
        params: { name: string; arguments: Record<string, unknown> };
      };
      const { name, arguments: input } = body.params;
      state.calls.push(name);
      let data: Record<string, unknown>;
      if (name === "mempalace_search") {
        const query = String(input.query ?? "").toLowerCase();
        const results = [...state.drawers.values()].filter((drawer) =>
          drawer.content.toLowerCase().includes(query)
        );
        data = { query, results, count: results.length };
      } else if (name === "mempalace_get_drawer") {
        const drawer = state.drawers.get(String(input.drawer_id));
        if (!drawer) {
          response.writeHead(404).end();
          return;
        }
        data = { ...drawer };
      } else if (name === "mempalace_add_drawer") {
        const id = `added-${state.drawers.size + 1}`;
        state.drawers.set(id, {
          drawer_id: id,
          content: String(input.content),
          wing: String(input.wing),
          room: String(input.room),
        });
        data = { success: true, drawer_id: id };
      } else if (name === "mempalace_kg_query") {
        const entity = String(input.entity);
        const facts = state.facts.filter(
          (fact) => fact.subject === entity || fact.object === entity
        );
        data = { entity, facts, count: facts.length };
      } else if (name === "mempalace_kg_add") {
        state.facts.push({
          subject: String(input.subject),
          predicate: String(input.predicate),
          object: String(input.object),
        });
        data = { success: true };
      } else if (name === "mempalace_diary_read") {
        if (input.agent_name !== state.diaryId) {
          response.writeHead(403).end();
          return;
        }
        data = { entries: [...state.diary], count: state.diary.length };
      } else if (name === "mempalace_diary_write") {
        if (input.agent_name !== state.diaryId) {
          response.writeHead(403).end();
          return;
        }
        state.diary.push(String(input.entry));
        data = { success: true };
      } else {
        response.writeHead(400).end();
        return;
      }
      const encoded = rpcResult(body.id, data);
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": encoded.length,
      });
      response.end(encoded);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("synthetic palace did not bind");
  return `http://127.0.0.1:${address.port}/mcp`;
}

function withEndpoint(
  config: IsolatedPlatformMemoryConfigV1,
  endpoint: string
): IsolatedPlatformMemoryConfigV1 {
  return { ...config, target: { ...config.target, endpoint } };
}

function data(result: { data: Record<string, unknown> }): Record<string, unknown> {
  return result.data;
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
          )
      )
  );
});

describe("two synthetic harness conformance", () => {
  it("none mode performs no cross-search/get/add/delete/KG/diary/admin/logstream access", async () => {
    const fetchSpy = vi.fn();
    const clients = [
      new PlatformMemoryClientV1(
        { contractVersion: 1, mode: "none", principalId: "principal-alpha" },
        { fetch: fetchSpy }
      ),
      new PlatformMemoryClientV1(
        { contractVersion: 1, mode: "none", principalId: "principal-beta" },
        { fetch: fetchSpy }
      ),
    ];
    const attempts: Array<[string, Record<string, unknown>]> = [
      ["search", { query: "other" }],
      ["get_drawer", { drawer_id: "other" }],
      ["add_drawer", { wing: "w", room: "r", content: "other" }],
      ["delete", { drawer_id: "other" }],
      ["kg_query", { entity: "other" }],
      ["kg_add", { subject: "other", predicate: "uses", object: "value" }],
      ["diary_read", {}],
      ["diary_write", { entry: "other" }],
      ["admin", {}],
      ["logstream-read", {}],
      ["logstream-write", {}],
    ];
    for (const client of clients) {
      for (const [operation, input] of attempts) {
        await expect(
          client.invoke(operation as PlatformMemoryOperation, input)
        ).rejects.toMatchObject({ code: "MEMORY_DISABLED" });
      }
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("isolated mode denies every tested cross-plane route in both directions", async () => {
    const alphaState: SyntheticPalace = {
      token: ALPHA_TOKEN,
      diaryId: "diary-alpha",
      drawers: new Map([
        [
          "alpha-private",
          {
            drawer_id: "alpha-private",
            content: "alpha-only-memory",
            wing: "private",
            room: "decisions",
          },
        ],
      ]),
      facts: [{ subject: "Alpha", predicate: "uses", object: "alpha-secret" }],
      diary: ["alpha-diary"],
      calls: [],
    };
    const betaState: SyntheticPalace = {
      token: BETA_TOKEN,
      diaryId: "diary-beta",
      drawers: new Map([
        [
          "beta-private",
          {
            drawer_id: "beta-private",
            content: "beta-only-memory",
            wing: "private",
            room: "decisions",
          },
        ],
      ]),
      facts: [{ subject: "Beta", predicate: "uses", object: "beta-secret" }],
      diary: ["beta-diary"],
      calls: [],
    };
    const [alphaEndpoint, betaEndpoint] = await Promise.all([
      startSyntheticPalace(alphaState),
      startSyntheticPalace(betaState),
    ]);
    const alphaConfig = withEndpoint(isolatedConfig("alpha"), alphaEndpoint);
    const betaConfig = withEndpoint(isolatedConfig("beta"), betaEndpoint);
    assertDistinctIsolatedMemoryConfigsV1(alphaConfig, betaConfig);

    const env = { ALPHA_MEMORY_TOKEN: ALPHA_TOKEN, BETA_MEMORY_TOKEN: BETA_TOKEN };
    const alpha = new PlatformMemoryClientV1(alphaConfig, { env });
    const beta = new PlatformMemoryClientV1(betaConfig, { env });

    expect(
      data(await alpha.invoke("search", { query: "beta-only-memory" })).results as unknown[]
    ).toEqual([]);
    expect(
      data(await beta.invoke("search", { query: "alpha-only-memory" })).results as unknown[]
    ).toEqual([]);
    await expect(alpha.invoke("get_drawer", { drawer_id: "beta-private" })).rejects.toMatchObject({
      code: "MEMORY_INVALID_REQUEST",
    });
    await expect(beta.invoke("get_drawer", { drawer_id: "alpha-private" })).rejects.toMatchObject({
      code: "MEMORY_INVALID_REQUEST",
    });

    await expect(
      alpha.invoke("add_drawer", {
        wing: "private",
        room: "decisions",
        content: "forged-cross-add",
        endpoint: betaEndpoint,
      })
    ).rejects.toMatchObject({ code: "MEMORY_INVALID_REQUEST" });
    await alpha.invoke("add_drawer", {
      wing: "private",
      room: "decisions",
      content: "alpha-new-memory",
    });
    expect(
      data(await beta.invoke("search", { query: "alpha-new-memory" })).results as unknown[]
    ).toEqual([]);

    for (const [client, otherEntity] of [
      [alpha, "Beta"],
      [beta, "Alpha"],
    ] as const) {
      expect(
        data(await client.invoke("kg_query", { entity: otherEntity })).facts as unknown[]
      ).toEqual([]);
      await expect(
        client.invoke("diary_read", { agent_name: `diary-${otherEntity.toLowerCase()}` })
      ).rejects.toMatchObject({ code: "MEMORY_INVALID_REQUEST" });
      await expect(
        client.invoke("diary_write", {
          entry: "forged-cross-diary",
          agent_name: `diary-${otherEntity.toLowerCase()}`,
        })
      ).rejects.toMatchObject({ code: "MEMORY_INVALID_REQUEST" });
      for (const operation of ["delete", "admin", "logstream-read", "logstream-write"] as const) {
        await expect(client.invoke(operation as never, {})).rejects.toMatchObject({
          code: "MEMORY_OPERATION_FORBIDDEN",
        });
      }
    }

    await alpha.invoke("kg_add", {
      subject: "Beta",
      predicate: "uses",
      object: "forged-cross-fact",
    });
    const betaFacts = data(await beta.invoke("kg_query", { entity: "Beta" })).facts as Array<{
      object: string;
    }>;
    expect(betaFacts.map((fact) => fact.object)).not.toContain("forged-cross-fact");

    await alpha.invoke("diary_write", { entry: "alpha-new-diary" });
    expect(data(await alpha.invoke("diary_read", {})).entries as string[]).toEqual([
      "alpha-diary",
      "alpha-new-diary",
    ]);
    expect(data(await beta.invoke("diary_read", {})).entries as string[]).toEqual(["beta-diary"]);
    expect(alphaState.calls).not.toContain("mempalace_delete_drawer");
    expect(betaState.calls).not.toContain("mempalace_delete_drawer");
    expect(
      alphaState.calls.some((call) => call.includes("logstream") || call.includes("admin"))
    ).toBe(false);
    expect(
      betaState.calls.some((call) => call.includes("logstream") || call.includes("admin"))
    ).toBe(false);
  });
});
