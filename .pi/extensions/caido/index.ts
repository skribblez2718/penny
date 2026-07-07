/** Caido Extension — wraps the Caido SDK for Pi
 *
 * Provides tools for interacting with a Caido instance:
 *  - caido_info: health, viewer, plugins
 *  - caido_search: search HTTP history
 *  - caido_request: get request/response details or curl
 *  - caido_intercept: status, enable, disable
 *  - caido_scopes: CRUD scope management
 *  - caido_filters: CRUD filter presets
 *  - caido_environments: CRUD environments
 *  - caido_findings: CRUD findings
 *  - caido_sessions: replay session management
 *  - caido_collections: replay collection management
 *  - caido_edit: replay an edited request
 *  - caido_send: send raw or replay existing
 *  - caido_fuzz: create automate session and start fuzzing
 *  - caido_projects: list/select projects
 *  - caido_tasks: list/cancel tasks
 *  - caido_files: list/delete hosted files
 *
 * Authentication: CAIDO_PAT via .env
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createLogger, setSessionId } from "../../lib/logger/logger.js";
import { getClient, loadConfig, withCaidoClient } from "./client.js";
import { caidoInfoImpl, type CaidoInfoParams } from "./tools/info.js";
import { caidoSearchImpl, type CaidoSearchParams } from "./tools/search.js";
import { caidoRequestImpl, type CaidoRequestParams } from "./tools/request.js";
import { caidoInterceptImpl, type CaidoInterceptParams } from "./tools/intercept.js";
import { caidoScopesImpl, type CaidoScopesParams } from "./tools/scopes.js";
import { caidoFiltersImpl, type CaidoFiltersParams } from "./tools/filters.js";
import { caidoEnvironmentsImpl, type CaidoEnvironmentsParams } from "./tools/environments.js";
import { caidoFindingsImpl, type CaidoFindingsParams } from "./tools/findings.js";
import { caidoSessionsImpl, type CaidoSessionsParams } from "./tools/sessions.js";
import { caidoCollectionsImpl, type CaidoCollectionsParams } from "./tools/collections.js";
import { caidoEditImpl, type CaidoEditParams } from "./tools/edit.js";
import { caidoSendImpl, type CaidoSendParams } from "./tools/send.js";
import { caidoFuzzImpl, type CaidoFuzzParams } from "./tools/fuzz.js";
import { caidoProjectsImpl, type CaidoProjectsParams } from "./tools/projects.js";
import { caidoTasksImpl, type CaidoTasksParams } from "./tools/tasks.js";
import { caidoFilesImpl, type CaidoFilesParams } from "./tools/files.js";

const logger = createLogger("caido");

/** Minimal shape of the session lifecycle context the Pi runtime passes to
 *  event handlers. The Pi SDK is loaded at runtime and exposes no static types
 *  (ExtensionAPI resolves to `any`), so we declare the fields we actually use. */
interface CaidoSessionContext {
  sessionManager: { getSessionId(): string };
}

/** Minimal shape of the command context used by registered commands. */
interface CaidoCommandContext {
  ui: { notify(message: string, level: "info" | "warn"): void };
}

// Semaphore infrastructure
const SEMAPHORE_MAX = 10;
let semaphoreCount = 0;
const semaphoreQueue: Array<() => void> = [];

function acquireSemaphore(): Promise<void> {
  return new Promise((resolve) => {
    if (semaphoreCount < SEMAPHORE_MAX) {
      semaphoreCount++;
      resolve();
    } else {
      semaphoreQueue.push(() => {
        semaphoreCount++;
        resolve();
      });
    }
  });
}

function releaseSemaphore(): void {
  semaphoreCount--;
  const next = semaphoreQueue.shift();
  if (next) next();
}

export default async function caidoExtension(pi: ExtensionAPI) {
  // Read env vars inside factory (never throws)
  const config = loadConfig();

  pi.on("session_start", async (_event: unknown, ctx: CaidoSessionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    setSessionId(sessionId);
    logger.debug("Caido extension session start", { sessionId });
  });

  // ============================================
  // TOOL: caido_info
  // ============================================
  pi.registerTool({
    name: "caido_info",
    label: "Caido Info",
    description:
      "Fetch Caido instance health, current user (viewer), or installed plugin packages. Use mode=health as a smoke test.",
    promptSnippet: "Check Caido instance status",
    promptGuidelines: [
      "Use caido_info with mode=health to verify connectivity before other operations.",
      "Use mode=viewer to see the authenticated user.",
      "Use mode=plugins to list installed plugins.",
    ],
    parameters: Type.Object({
      mode: Type.String({ description: "Info mode: health | viewer | plugins" }),
    }),
    async execute(_toolCallId: string, params: CaidoInfoParams) {
      return withCaidoClient(
        "caido_info",
        config,
        { acquireSemaphore, releaseSemaphore, logger },
        async () => {
          const client = await getClient();
          return await caidoInfoImpl(params, client);
        }
      );
    },
  });

  // ============================================
  // TOOL: caido_search
  // ============================================
  pi.registerTool({
    name: "caido_search",
    label: "Caido Search",
    description: "Search HTTP history with optional filters, pagination, and result limits.",
    promptSnippet: "Search Caido HTTP history",
    promptGuidelines: [
      "Use caido_search to find requests by host, path, method, or HTTPQL filter.",
      'HTTPQL syntax: <namespace>.<field>.<operator>:<value>. Examples: req.host.eq:"example.com", resp.code.eq:200, req.method.eq:"GET"',
      "Operators: eq, ne, cont, ncont, like, nlike, regex, nregex, gt, gte, lt, lte.",
      'Combine with AND/OR: req.host.cont:"google" AND resp.code.eq:200',
      "Set ids_only=true for a compact list of request IDs.",
      "Set recent_only=true to get the latest requests without filtering.",
    ],
    parameters: Type.Object({
      filter: Type.Optional(Type.String({ description: "HTTPQL filter expression" })),
      limit: Type.Optional(
        Type.Number({ description: "Max results (1-500, default 50)", minimum: 1, maximum: 500 })
      ),
      after: Type.Optional(Type.String({ description: "Cursor for pagination" })),
      ids_only: Type.Optional(Type.Boolean({ description: "Return only request IDs" })),
      recent_only: Type.Optional(
        Type.Boolean({ description: "Return most recent requests, ignoring filter" })
      ),
    }),
    async execute(_toolCallId: string, params: CaidoSearchParams) {
      return withCaidoClient(
        "caido_search",
        config,
        { acquireSemaphore, releaseSemaphore, logger },
        async () => {
          const client = await getClient();
          return await caidoSearchImpl(params, client);
        }
      );
    },
  });

  // ============================================
  // TOOL: caido_request
  // ============================================
  pi.registerTool({
    name: "caido_request",
    label: "Caido Request",
    description:
      "Get full request/response details, response only, or generate a curl command for a request by ID.",
    promptSnippet: "Fetch request details from Caido",
    promptGuidelines: [
      "Use mode=full for complete request and response with optional body truncation.",
      "Use mode=response for response details only.",
      "Use mode=curl to get a curl command.",
    ],
    parameters: Type.Object({
      request_id: Type.String({ description: "Request ID" }),
      mode: Type.Optional(
        Type.String({ description: "Mode: full | response | curl (default full)" })
      ),
      max_body_lines: Type.Optional(Type.Number({ description: "Max body lines (default 200)" })),
      max_body_chars: Type.Optional(Type.Number({ description: "Max body chars (default 5000)" })),
      no_request: Type.Optional(Type.Boolean({ description: "Omit request from output" })),
      headers_only: Type.Optional(Type.Boolean({ description: "Show headers only" })),
    }),
    async execute(_toolCallId: string, params: CaidoRequestParams) {
      return withCaidoClient(
        "caido_request",
        config,
        { acquireSemaphore, releaseSemaphore, logger },
        async () => {
          const client = await getClient();
          return await caidoRequestImpl(params, client);
        }
      );
    },
  });

  // ============================================
  // TOOL: caido_intercept
  // ============================================
  pi.registerTool({
    name: "caido_intercept",
    label: "Caido Intercept",
    description: "Get intercept status, enable, or disable intercept.",
    promptSnippet: "Control Caido intercept",
    promptGuidelines: [
      "Use action=status to see current intercept configuration.",
      "Use action=enable/disable to toggle intercept.",
    ],
    parameters: Type.Object({
      action: Type.String({ description: "Action: status | enable | disable" }),
    }),
    async execute(_toolCallId: string, params: CaidoInterceptParams) {
      return withCaidoClient(
        "caido_intercept",
        config,
        { acquireSemaphore, releaseSemaphore, logger },
        async () => {
          const client = await getClient();
          return await caidoInterceptImpl(params, client);
        }
      );
    },
  });

  // ============================================
  // TOOL: caido_scopes
  // ============================================
  pi.registerTool({
    name: "caido_scopes",
    label: "Caido Scopes",
    description: "List, create, update, or delete Caido scopes (allowlist/denylist).",
    promptSnippet: "Manage Caido scopes",
    promptGuidelines: [
      "Use action=list to see all scopes.",
      "Use action=create with name, allowlist, and denylist.",
      "Use action=update with scope_id and fields to change.",
      "Use action=delete with scope_id.",
    ],
    parameters: Type.Object({
      action: Type.String({ description: "Action: list | create | update | delete" }),
      scope_id: Type.Optional(
        Type.String({ description: "Scope ID (required for update/delete)" })
      ),
      name: Type.Optional(Type.String({ description: "Scope name (required for create)" })),
      allowlist: Type.Optional(Type.Array(Type.String({ description: "Allowed hosts/patterns" }))),
      denylist: Type.Optional(Type.Array(Type.String({ description: "Denied hosts/patterns" }))),
    }),
    async execute(_toolCallId: string, params: CaidoScopesParams) {
      return withCaidoClient(
        "caido_scopes",
        config,
        { acquireSemaphore, releaseSemaphore, logger },
        async () => {
          const client = await getClient();
          return await caidoScopesImpl(params, client);
        }
      );
    },
  });

  // ============================================
  // TOOL: caido_filters
  // ============================================
  pi.registerTool({
    name: "caido_filters",
    label: "Caido Filters",
    description: "List, create, update, or delete filter presets.",
    promptSnippet: "Manage Caido filter presets",
    promptGuidelines: [
      "Use action=list to see all filters.",
      "Use action=create with name and query (HTTPQL clause). Alias auto-generates from name if not provided.",
      'HTTPQL clause syntax: <namespace>.<field>.<operator>:<value> (e.g., resp.code.eq:200, req.host.cont:"google")',
      "Use action=update with filter_id.",
      "Use action=delete with filter_id.",
    ],
    parameters: Type.Object({
      action: Type.String({ description: "Action: list | create | update | delete" }),
      filter_id: Type.Optional(
        Type.String({ description: "Filter ID (required for update/delete)" })
      ),
      name: Type.Optional(Type.String({ description: "Filter name (required for create)" })),
      query: Type.Optional(
        Type.String({ description: "Filter query / clause (required for create)" })
      ),
      alias: Type.Optional(Type.String({ description: "Optional alias for the filter" })),
    }),
    async execute(_toolCallId: string, params: CaidoFiltersParams) {
      return withCaidoClient(
        "caido_filters",
        config,
        { acquireSemaphore, releaseSemaphore, logger },
        async () => {
          const client = await getClient();
          return await caidoFiltersImpl(params, client);
        }
      );
    },
  });

  // ============================================
  // TOOL: caido_environments
  // ============================================
  pi.registerTool({
    name: "caido_environments",
    label: "Caido Environments",
    description: "Manage Caido environments and variables.",
    promptSnippet: "Manage Caido environments",
    promptGuidelines: [
      "Use action=list to see environments.",
      "Use action=create with name.",
      "Use action=set_var with env_id, var_name, and var_value.",
      "Use action=delete with env_id.",
      "Use action=select with env_id.",
    ],
    parameters: Type.Object({
      action: Type.String({ description: "Action: list | create | delete | select | set_var" }),
      env_id: Type.Optional(Type.String({ description: "Environment ID" })),
      name: Type.Optional(Type.String({ description: "Environment name (required for create)" })),
      var_name: Type.Optional(Type.String({ description: "Variable name (for set_var)" })),
      var_value: Type.Optional(Type.String({ description: "Variable value (for set_var)" })),
    }),
    async execute(_toolCallId: string, params: CaidoEnvironmentsParams) {
      return withCaidoClient(
        "caido_environments",
        config,
        { acquireSemaphore, releaseSemaphore, logger },
        async () => {
          const client = await getClient();
          return await caidoEnvironmentsImpl(params, client);
        }
      );
    },
  });

  // ============================================
  // TOOL: caido_findings
  // ============================================
  pi.registerTool({
    name: "caido_findings",
    label: "Caido Findings",
    description: "List, get, create, or update findings.",
    promptSnippet: "Manage Caido findings",
    promptGuidelines: [
      "Use action=list with optional limit.",
      "Use action=get with finding_id.",
      "Use action=create with request_id and title.",
      "Use action=update with finding_id.",
    ],
    parameters: Type.Object({
      action: Type.String({ description: "Action: list | get | create | update" }),
      limit: Type.Optional(Type.Number({ description: "Limit for list (default 50)" })),
      finding_id: Type.Optional(Type.String({ description: "Finding ID (for get/update)" })),
      request_id: Type.Optional(Type.String({ description: "Request ID (for create)" })),
      title: Type.Optional(Type.String({ description: "Finding title (for create/update)" })),
      description: Type.Optional(Type.String({ description: "Finding description" })),
      reporter: Type.Optional(Type.String({ description: "Reporter name" })),
      dedupe_key: Type.Optional(Type.String({ description: "Deduplication key" })),
      hidden: Type.Optional(Type.Boolean({ description: "Hide finding" })),
    }),
    async execute(_toolCallId: string, params: CaidoFindingsParams) {
      return withCaidoClient(
        "caido_findings",
        config,
        { acquireSemaphore, releaseSemaphore, logger },
        async () => {
          const client = await getClient();
          return await caidoFindingsImpl(params, client);
        }
      );
    },
  });

  // ============================================
  // TOOL: caido_sessions
  // ============================================
  pi.registerTool({
    name: "caido_sessions",
    label: "Caido Replay Sessions",
    description: "List, create, rename, or delete replay sessions.",
    promptSnippet: "Manage replay sessions",
    promptGuidelines: [
      "Use action=list with optional limit.",
      "Use action=create with request_id.",
      "Use action=rename with session_id and name.",
      "Use action=delete with session_id.",
    ],
    parameters: Type.Object({
      action: Type.String({ description: "Action: list | create | rename | delete" }),
      limit: Type.Optional(Type.Number({ description: "Limit for list (default 50)" })),
      session_id: Type.Optional(Type.String({ description: "Session ID (for rename/delete)" })),
      request_id: Type.Optional(Type.String({ description: "Request ID (for create)" })),
      name: Type.Optional(Type.String({ description: "Session name (for rename)" })),
    }),
    async execute(_toolCallId: string, params: CaidoSessionsParams) {
      return withCaidoClient(
        "caido_sessions",
        config,
        { acquireSemaphore, releaseSemaphore, logger },
        async () => {
          const client = await getClient();
          return await caidoSessionsImpl(params, client);
        }
      );
    },
  });

  // ============================================
  // TOOL: caido_collections
  // ============================================
  pi.registerTool({
    name: "caido_collections",
    label: "Caido Replay Collections",
    description: "List, create, rename, or delete replay collections.",
    promptSnippet: "Manage replay collections",
    promptGuidelines: [
      "Use action=list with optional limit.",
      "Use action=create with name.",
      "Use action=rename with collection_id and name.",
      "Use action=delete with collection_id.",
    ],
    parameters: Type.Object({
      action: Type.String({ description: "Action: list | create | rename | delete" }),
      limit: Type.Optional(Type.Number({ description: "Limit for list (default 50)" })),
      collection_id: Type.Optional(
        Type.String({ description: "Collection ID (for rename/delete)" })
      ),
      name: Type.Optional(Type.String({ description: "Collection name (for create/rename)" })),
    }),
    async execute(_toolCallId: string, params: CaidoCollectionsParams) {
      return withCaidoClient(
        "caido_collections",
        config,
        { acquireSemaphore, releaseSemaphore, logger },
        async () => {
          const client = await getClient();
          return await caidoCollectionsImpl(params, client);
        }
      );
    },
  });

  // ============================================
  // TOOL: caido_edit
  // ============================================
  pi.registerTool({
    name: "caido_edit",
    label: "Caido Edit & Replay",
    description:
      "Fetch a request, modify it (method, path, headers, body, replacements), and replay it. Returns the replay result.",
    promptSnippet: "Edit and replay a request in Caido",
    promptGuidelines: [
      "Use caido_edit to modify an existing request and replay it.",
      "Supports method/path changes, header add/remove, body replacement, and string replacements.",
      "The modified request is sent through a replay session.",
    ],
    parameters: Type.Object({
      request_id: Type.String({ description: "Request ID to edit and replay" }),
      method: Type.Optional(Type.String({ description: "Override HTTP method" })),
      path: Type.Optional(Type.String({ description: "Override request path" })),
      set_headers: Type.Optional(
        Type.Array(Type.String({ description: "Headers to add/replace (e.g. 'X-Header: value')" }))
      ),
      remove_headers: Type.Optional(
        Type.Array(Type.String({ description: "Header names to remove" }))
      ),
      body: Type.Optional(Type.String({ description: "Replace request body" })),
      replacements: Type.Optional(
        Type.Array(Type.String({ description: "String replacements as 'from:::to'" }))
      ),
      max_body_lines: Type.Optional(Type.Number({ description: "Max body lines (default 200)" })),
      max_body_chars: Type.Optional(Type.Number({ description: "Max body chars (default 5000)" })),
      no_request: Type.Optional(Type.Boolean({ description: "Omit modified request from output" })),
      headers_only: Type.Optional(Type.Boolean({ description: "Show headers only" })),
    }),
    async execute(_toolCallId: string, params: CaidoEditParams) {
      return withCaidoClient(
        "caido_edit",
        config,
        { acquireSemaphore, releaseSemaphore, logger },
        async () => {
          const client = await getClient();
          return await caidoEditImpl(params, client);
        }
      );
    },
  });

  // ============================================
  // TOOL: caido_send
  // ============================================
  pi.registerTool({
    name: "caido_send",
    label: "Caido Send",
    description: "Send a raw HTTP request or replay an existing request via Caido replay.",
    promptSnippet: "Send raw or replay request in Caido",
    promptGuidelines: [
      "Use mode=raw with raw_request, host, port, and is_tls.",
      "Use mode=replay with request_id to replay an existing request.",
    ],
    parameters: Type.Object({
      mode: Type.String({ description: "Mode: raw | replay" }),
      raw_request: Type.Optional(
        Type.String({ description: "Raw HTTP request text (for raw mode)" })
      ),
      host: Type.Optional(Type.String({ description: "Target host (for raw mode)" })),
      port: Type.Optional(Type.Number({ description: "Target port (for raw mode)" })),
      is_tls: Type.Optional(Type.Boolean({ description: "Use HTTPS (for raw mode)" })),
      request_id: Type.Optional(Type.String({ description: "Request ID (for replay mode)" })),
      max_body_lines: Type.Optional(Type.Number({ description: "Max body lines (default 200)" })),
      max_body_chars: Type.Optional(Type.Number({ description: "Max body chars (default 5000)" })),
      no_request: Type.Optional(Type.Boolean({ description: "Omit request from output" })),
      headers_only: Type.Optional(Type.Boolean({ description: "Show headers only" })),
    }),
    async execute(_toolCallId: string, params: CaidoSendParams) {
      return withCaidoClient(
        "caido_send",
        config,
        { acquireSemaphore, releaseSemaphore, logger },
        async () => {
          const client = await getClient();
          return await caidoSendImpl(params, client);
        }
      );
    },
  });

  // ============================================
  // TOOL: caido_fuzz
  // ============================================
  pi.registerTool({
    name: "caido_fuzz",
    label: "Caido Fuzz",
    description:
      "Create an automate session from a request and start a fuzzing task. Returns task ID immediately (does not wait for completion).",
    promptSnippet: "Start a fuzzing task in Caido",
    promptGuidelines: [
      "Use caido_fuzz with request_id to create a session and start fuzzing.",
      "Use automate_session_id to start fuzzing with an existing session.",
    ],
    parameters: Type.Object({
      request_id: Type.Optional(Type.String({ description: "Request ID to base fuzzing on" })),
      automate_session_id: Type.Optional(
        Type.String({ description: "Existing automate session ID" })
      ),
      payloads: Type.Optional(
        Type.Array(Type.String({ description: "Optional payload hints (informational)" }))
      ),
    }),
    async execute(_toolCallId: string, params: CaidoFuzzParams) {
      return withCaidoClient(
        "caido_fuzz",
        config,
        { acquireSemaphore, releaseSemaphore, logger },
        async () => {
          const client = await getClient();
          return await caidoFuzzImpl(params, client);
        }
      );
    },
  });

  // ============================================
  // TOOL: caido_projects
  // ============================================
  pi.registerTool({
    name: "caido_projects",
    label: "Caido Projects",
    description: "List or select Caido projects.",
    promptSnippet: "Manage Caido projects",
    promptGuidelines: [
      "Use action=list to see all projects.",
      "Use action=select with project_id.",
    ],
    parameters: Type.Object({
      action: Type.String({ description: "Action: list | select" }),
      project_id: Type.Optional(Type.String({ description: "Project ID (for select)" })),
    }),
    async execute(_toolCallId: string, params: CaidoProjectsParams) {
      return withCaidoClient(
        "caido_projects",
        config,
        { acquireSemaphore, releaseSemaphore, logger },
        async () => {
          const client = await getClient();
          return await caidoProjectsImpl(params, client);
        }
      );
    },
  });

  // ============================================
  // TOOL: caido_tasks
  // ============================================
  pi.registerTool({
    name: "caido_tasks",
    label: "Caido Tasks",
    description: "List or cancel Caido tasks.",
    promptSnippet: "Manage Caido tasks",
    promptGuidelines: ["Use action=list to see all tasks.", "Use action=cancel with task_id."],
    parameters: Type.Object({
      action: Type.String({ description: "Action: list | cancel" }),
      task_id: Type.Optional(Type.String({ description: "Task ID (for cancel)" })),
    }),
    async execute(_toolCallId: string, params: CaidoTasksParams) {
      return withCaidoClient(
        "caido_tasks",
        config,
        { acquireSemaphore, releaseSemaphore, logger },
        async () => {
          const client = await getClient();
          return await caidoTasksImpl(params, client);
        }
      );
    },
  });

  // ============================================
  // TOOL: caido_files
  // ============================================
  pi.registerTool({
    name: "caido_files",
    label: "Caido Hosted Files",
    description: "List or delete hosted files.",
    promptSnippet: "Manage Caido hosted files",
    promptGuidelines: ["Use action=list to see hosted files.", "Use action=delete with file_id."],
    parameters: Type.Object({
      action: Type.String({ description: "Action: list | delete" }),
      file_id: Type.Optional(Type.String({ description: "File ID (for delete)" })),
    }),
    async execute(_toolCallId: string, params: CaidoFilesParams) {
      return withCaidoClient(
        "caido_files",
        config,
        { acquireSemaphore, releaseSemaphore, logger },
        async () => {
          const client = await getClient();
          return await caidoFilesImpl(params, client);
        }
      );
    },
  });

  // ============================================
  // COMMAND: caido-status
  // ============================================
  pi.registerCommand("caido-status", {
    description: "Check Caido extension connection and credential status",
    handler: async (_args: string, ctx: CaidoCommandContext) => {
      const hasCreds = !!config.pat;
      const status = hasCreds ? "Configured" : "Missing credentials";
      ctx.ui.notify(`Caido: ${status} | URL: ${config.url}`, hasCreds ? "info" : "warn");
    },
  });
}
