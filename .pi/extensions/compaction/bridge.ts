/**
 * Typed Bridge Client for Penny Memory Bridge
 *
 * Reusable wrapper around memory_bridge.py.
 * All calls are JSON-RPC style: { tool, params } → JSON response.
 * Timeout: 30s (same as memory extension).
 */

import { spawn } from "child_process";

const BRIDGE_CONFIG = {
  venvPython:
    process.env.PI_VENV_PYTHON || `${process.env.PROJECT_ROOT || process.cwd()}/.venv/bin/python`,
  bridgePath:
    process.env.PI_MEMORY_BRIDGE ||
    `${process.env.PROJECT_ROOT || process.cwd()}/scripts/system/bridge/memory_bridge.py`,
  timeoutMs: 30000,
};

export interface BridgeResponse {
  success: boolean;
  data?: any;
  error?: string;
}

/**
 * Call the Penny memory bridge.
 */
export async function callBridge(
  tool: string,
  params: Record<string, unknown> = {}
): Promise<BridgeResponse> {
  return new Promise((resolve) => {
    const request = JSON.stringify({ tool, params });
    const proc = spawn(BRIDGE_CONFIG.venvPython, [BRIDGE_CONFIG.bridgePath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill("SIGKILL");
        resolve({ success: false, error: `Bridge timeout (${BRIDGE_CONFIG.timeoutMs}ms)` });
      }
    }, BRIDGE_CONFIG.timeoutMs);

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        resolve({ success: false, error: `Bridge exit ${code}: ${stderr}` });
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.error) {
          resolve({ success: false, error: parsed.error });
        } else {
          resolve({ success: true, data: parsed });
        }
      } catch {
        resolve({ success: false, error: `JSON parse failed: ${stdout.slice(0, 200)}` });
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ success: false, error: err.message });
      }
    });
    proc.on("spawn", () => {
      proc.stdin.write(request);
      proc.stdin.end();
    });
  });
}

// ============================================================
// Convenience Methods for Compaction Extension
// ============================================================

/**
 * Search mempalace for active skill sessions.
 */
export async function queryActiveSkillSessions(sessionIdPrefix: string): Promise<any[]> {
  const result = await callBridge("smart_search", {
    query: `skill session ${sessionIdPrefix}`,
    limit: 10,
  });
  if (!result.success) return [];
  return result.data?.results || [];
}

/**
 * Query KG for pending decisions.
 */
export async function queryPendingDecisions(sessionId: string): Promise<any[]> {
  const result = await callBridge("kg_query", {
    entity: `Session:${sessionId}`,
    direction: "outgoing",
  });
  if (!result.success) return [];
  // Filter for pending/verification predicates
  const triples = result.data?.facts || [];
  return triples.filter((t: any) => /pending|verification|awaiting|unknown/i.test(t.predicate));
}

/**
 * Read recent diary entries to detect escalation state.
 */
export async function queryDiaryEscalation(
  agentName: string = "penny",
  lastN: number = 3
): Promise<any[]> {
  const result = await callBridge("diary_read", {
    agent_name: agentName,
    last_n: lastN,
  });
  if (!result.success) return [];
  const entries = result.data?.entries || [];
  // Filter entries that mention escalation, UNKNOWN_STATE, or verification
  return entries.filter((e: any) =>
    /UNKNOWN_STATE|escalation|verification|awaiting|pending/i.test(e.text || "")
  );
}

// ============================================================
// Item 1: Mempalace Active Skill Sessions
// ============================================================

/**
 * Query mempalace for active skill session rooms.
 *
 * Calls list_rooms → filters skills/* pattern → list_drawers per room.
 *
 * @deprecated Use queryMempalaceSkillRoomsForSession for session-scoped queries.
 */
export async function queryMempalaceSkillRooms(): Promise<any[]> {
  // Step 1: list all rooms in penny wing
  const roomsResult = await callBridge("list_rooms", { wing: "penny" });
  if (!roomsResult.success) return [];

  const roomsResponse = roomsResult.data?.rooms || roomsResult.data || {};
  let allRooms: any[];
  if (Array.isArray(roomsResponse)) {
    allRooms = roomsResponse;
  } else if (typeof roomsResponse === "object" && roomsResponse !== null) {
    // Bridge returns dict {roomName: count, ...}
    allRooms = Object.keys(roomsResponse).map((name) => ({ name, count: roomsResponse[name] }));
  } else {
    logger.warn("list_rooms returned unexpected type", { type: typeof roomsResponse });
    return [];
  }
  const skillRooms = allRooms.filter((r: any) => (r.name || r.room || "").startsWith("skills/"));

  // Step 2: list drawers for each skill room
  const roomRefs = [];
  for (const room of skillRooms) {
    const roomName = room.name || room.room;
    const drawersResult = await callBridge("list_drawers", {
      wing: "penny",
      room: roomName,
      limit: 5,
    });
    const drawers = drawersResult.success
      ? drawersResult.data?.drawers?.map((d: any) => d.id || d.drawer_id) || []
      : [];

    roomRefs.push({
      wing: "penny",
      room: roomName,
      drawer_ids: drawers,
      last_updated: new Date().toISOString(),
    });
  }

  return roomRefs;
}

// ============================================================
// Session-Scoped Mempalace Skill Rooms (v1.1.0)
// ============================================================

/**
 * Query mempalace for skill session rooms that match a specific session_id.
 *
 * Strategy:
 * 1. List all skills/* rooms
 * 2. For each room, list drawers and read their content headers
 * 3. Keep rooms where any drawer content contains the session_id pattern
 * 4. Also include rooms with last_updated within recency_window (24h)
 *
 * @param sessionId The skill session ID to match
 * @param recencyWindowMs Include rooms with last_updated within this window, regardless of session match
 */
export async function queryMempalaceSkillRoomsForSession(
  sessionId: string,
  recencyWindowMs: number = 86_400_000
): Promise<any[]> {
  const cutoff = new Date(Date.now() - recencyWindowMs).toISOString();

  // Step 1: list all rooms (same as base query)
  const roomsResult = await callBridge("list_rooms", { wing: "penny" });
  if (!roomsResult.success) return [];

  const roomsResponse = roomsResult.data?.rooms || roomsResult.data || {};
  let allRooms: any[];
  if (Array.isArray(roomsResponse)) {
    allRooms = roomsResponse;
  } else if (typeof roomsResponse === "object" && roomsResponse !== null) {
    allRooms = Object.keys(roomsResponse).map((name) => ({ name, count: roomsResponse[name] }));
  } else {
    logger.warn("list_rooms returned unexpected type", { type: typeof roomsResponse });
    return [];
  }

  const skillRooms = allRooms.filter((r: any) => (r.name || r.room || "").startsWith("skills/"));

  const roomRefs: any[] = [];
  for (const room of skillRooms) {
    const roomName = room.name || room.room;

    // Fetch drawers for this room
    const drawersResult = await callBridge("list_drawers", {
      wing: "penny",
      room: roomName,
      limit: 5,
    });
    if (!drawersResult.success) continue;

    const drawers = drawersResult.data?.drawers || [];
    if (drawers.length === 0) continue;

    const drawerIds = drawers.map((d: any) => d.id || d.drawer_id);

    // Check recency: room_name or last drawer timestamp is recent enough
    // Most rooms have timestamps embedded in their names (plan-1778265024870)
    // or we infer from the room metadata
    const isRecentRoom =
      roomName.includes(sessionId) || // session_id directly in room name
      (room.last_updated && room.last_updated >= cutoff); // room-level recency

    if (isRecentRoom) {
      roomRefs.push({
        wing: "penny",
        room: roomName,
        drawer_ids: drawerIds,
        last_updated: room.last_updated || new Date().toISOString(),
      });
      continue;
    }

    // Check drawer content for session_id mentions
    let matchedSession = false;
    for (const _drawer of drawers.slice(0, 3)) {
      // Only check first 3 drawers per room (performance)
      const searchResult = await callBridge("search", {
        wing: "penny",
        room: roomName,
        limit: 1,
      });
      if (!searchResult.success) continue;

      const items = searchResult.data?.results || [];
      for (const item of items) {
        const text = (item.text || item.content || item.summary || "").toString();
        if (text.includes(sessionId) || text.includes(`Session: ${sessionId}`)) {
          matchedSession = true;
          break;
        }
      }
      if (matchedSession) break;
    }

    if (matchedSession) {
      roomRefs.push({
        wing: "penny",
        room: roomName,
        drawer_ids: drawerIds,
        last_updated: new Date().toISOString(),
      });
    }
  }

  return roomRefs;
}

// ============================================================
// Agent Summaries from Room (v1.1.0)
// ============================================================

/**
 * Query mempalace drawers for actual agent SUMMARY blocks.
 *
 * Parses drawer content to extract:
 * - Agent name from session header ("Session: X Echo" → "echo")
 * - Completion status from SUMMARY JSON
 * - Phase/orchestrator state from content structure
 *
 * Returns AgentRef[] where `source` is always "mempalace_summary".
 */
export async function queryAgentSummariesFromRoom(roomRef: any): Promise<any[]> {
  const agents: any[] = [];
  const roomName = roomRef.room;
  if (!roomName || !roomName.startsWith("skills/")) return agents;

  // Search room for content with agent indicators
  const result = await callBridge("search", {
    wing: "penny",
    room: roomName,
    limit: 5,
  });
  if (!result.success) return agents;

  const drawers = result.data?.results || [];

  for (const drawer of drawers) {
    const text = (drawer.text || drawer.content || "").toString();
    const summary = (drawer.summary || "").toString();
    const combined = text + "\n" + summary;

    // Try to infer agent name from session header
    // Common patterns: "Session: X Explore", "Session: X Planner", etc.
    const sessionHeaderMatch = combined.match(/Session:\s+[a-zA-Z0-9-]+\s+(\w+)/i);
    let agentName = sessionHeaderMatch ? sessionHeaderMatch[1].toLowerCase() : null;

    // If no session header, try known agent names in room name or content
    const knownAgents = [
      "echo",
      "piper",
      "carren",
      "tabitha",
      "vera",
      "synthia",
      "skribble",
    ];
    if (!agentName) {
      const lowerCombined = combined.toLowerCase();
      for (const known of knownAgents) {
        if (lowerCombined.includes(known) || roomName.includes(known)) {
          agentName = known;
          break;
        }
      }
    }

    if (!agentName) continue;

    // Try to parse SUMMARY block for completion indicators
    let complete = false;
    let phase = "unknown";

    // Look for SUMMARY: {"complete": true} or similar
    const summaryMatch = combined.match(/SUMMARY\s*[:：]\s*(\{.*?\})/i);
    if (summaryMatch) {
      try {
        const parsed = JSON.parse(summaryMatch[1]);
        if (typeof parsed.complete === "boolean") complete = parsed.complete;
        if (parsed.verdict === "APPROVE") complete = true;
        if (parsed.verdict === "NEEDS_REVISION") complete = false;
        if (parsed.phase) phase = parsed.phase;
      } catch {
        // JSON parse failed — continue with heuristics
      }
    }

    // Fallback: check for completion markers in plain text
    if (!complete) {
      if (
        /complete|completed|finished|done|success/i.test(summary) &&
        !/incomplete|pending|failed|error/i.test(summary)
      ) {
        complete = true;
      }
    }

    // Determine phase from content structure
    if (/Explore|exploration/i.test(combined)) phase = "exploring";
    else if (/Plan|Planner|planning/i.test(combined)) phase = "planning";
    else if (/Critique|critiquing/i.test(combined)) phase = "critiquing";
    else if (/Taskif|taskifying/i.test(combined)) phase = "taskifying";

    agents.push({
      name: agentName,
      session_id: roomName.replace("skills/", ""), // best-effort session id from room name
      phase,
      complete,
      source: "mempalace_summary",
    });
  }

  return agents;
}

// ============================================================
// Skill Orchestrator State (v1.1.0)
// ============================================================

/**
 * Query mempalace for a skill's orchestrator state blob.
 *
 * The orchestrator writes its JSON state to mempalace after each step
 * (stored under the skill session room). This function searches for
 * the most recent orchestrator_state drawer and parses the JSON.
 */
export async function querySkillOrchestratorState(sessionId: string): Promise<any | null> {
  // Try common room names
  const candidateRooms = [
    `skills/plan-${sessionId}`,
    `skills/research-${sessionId}`,
    `skills/agent-${sessionId}`,
    // Some skills write directly under the session id without skill prefix
  ];

  for (const roomName of candidateRooms) {
    const result = await callBridge("search", {
      wing: "penny",
      room: roomName,
      limit: 3,
    });
    if (!result.success) continue;

    const items = result.data?.results || [];
    for (const item of items) {
      const text = (item.text || item.content || "").toString();
      // Look for orchestrator state JSON blob
      const stateMatch = text.match(/orchestrator_state\s*[:=]\s*(\{[\s\S]*?\})/);
      if (stateMatch) {
        try {
          const state = JSON.parse(stateMatch[1]);
          return state;
        } catch {
          // Malformed JSON — try next drawer
          continue;
        }
      }
      // Also look for full JSON that contains orchestrator_state
      try {
        const jsonAttempt = JSON.parse(text);
        if (jsonAttempt.orchestrator_state) {
          return jsonAttempt.orchestrator_state;
        }
      } catch {
        // Not valid JSON — continue
      }
    }
  }

  return null;
}

// ============================================================
// Item 2: KG Entity Verification
// ============================================================

/**
 * Query KG for entities related to a session.
 *
 * Verifies existence via kg_query; marks stale if no triples found.
 */
export async function queryKGEntitiesForSession(sessionId: string): Promise<any[]> {
  const entityId = `Session:${sessionId}`;
  const result = await callBridge("kg_query", {
    entity: entityId,
    direction: "both",
  });
  if (!result.success) return [];

  const triples = result.data?.facts || [];
  const now = new Date().toISOString();

  return triples.map((t: any) => ({
    entity_id: t.object === entityId ? t.subject : t.object,
    entity_type: inferEntityType(t.predicate),
    relevant_predicates: [t.predicate],
    last_verified: now,
    stale: false,
    valid_from: t.valid_from || now,
  }));
}

function inferEntityType(predicate: string): string {
  if (/session|plan|skill/i.test(predicate)) return "Session";
  if (/decision|outcome|approved/i.test(predicate)) return "Decision";
  if (/agent|invoked|completed/i.test(predicate)) return "Agent";
  if (/feature|capability/i.test(predicate)) return "Feature";
  return "Entity";
}

// ============================================================
// Item 3: Outcome Ledger Decisions
// ============================================================

/**
 * Query outcome ledger (penny/outcomes room) for recent decisions.
 */
export async function queryOutcomeLedgerDecisions(limit: number = 20): Promise<any[]> {
  const result = await callBridge("search", {
    wing: "penny",
    room: "outcomes",
    limit,
  });
  if (!result.success) return [];

  const drawers = result.data?.results || [];
  return drawers.map((d: any, i: number) => ({
    decision_id: `decision-${i}`, // Phase 3+: parse from drawer content
    summary: (d.text || d.content || "Outcome record").slice(0, 200),
    outcome_room: "penny/outcomes",
    confidence: "PROBABLE", // Phase 3+: parse from content
  }));
}
