/**
 * Typed Bridge Client for Penny Memory Bridge + Engine Checkpointer
 *
 * Two data sources feed the compact artifact:
 *   1. memory_bridge.py (mempalace / KG / outcome ledger) — JSON-RPC style
 *      { tool, params } → JSON response, via a spawned venv Python process.
 *   2. The orchestration engine's durable run_id checkpointer
 *      (.penny/orchestration.db) — the SOURCE OF TRUTH for in-flight run
 *      state. Compaction reads it directly (read-only SQLite); it never
 *      reconstructs run state from mempalace drawer text.
 */

import { spawn } from "child_process";
import { createLogger } from "../../lib/logger/logger.js";
import type { EngineRunRef, MempalaceRoomRef, KGEntityRef, DecisionRef } from "./schema.js";
import { asRecord, asString, asArray } from "./pi-messages.js";

/** A recent diary entry — only the text is consumed by escalation detection. */
export interface DiaryEntry {
  text?: string;
}

const logger = createLogger("compaction-bridge");

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
  data?: unknown;
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

/**
 * Indirection point so unit tests can substitute the bridge caller without
 * spawning Python or hitting the network. Production code always goes through
 * `_internals.call`.
 */
export const _internals: { call: typeof callBridge } = {
  call: callBridge,
};

// ============================================================
// Engine Checkpointer (source of truth for run state)
// ============================================================

// Read-only query against the engine's SQLite checkpointer. Runs in the
// venv Python (sqlite3 is stdlib; no engine import needed, so this works
// even if apps/orchestration isn't installed into the venv).
const ENGINE_RUNS_SCRIPT = `
import json, os, sqlite3, sys
root = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
path = os.environ.get("PENNY_ORCH_DB") or os.path.join(root, ".penny", "orchestration.db")
if not os.path.exists(path):
    print("[]"); sys.exit(0)
conn = sqlite3.connect("file:%s?mode=ro" % path, uri=True, timeout=5)
conn.row_factory = sqlite3.Row
rows = conn.execute(
    "SELECT run_id, session_id, playbook, current_state_id, status, updated_at, context_json "
    "FROM runs WHERE status IN ('running','awaiting_user') "
    "ORDER BY updated_at DESC LIMIT 5"
).fetchall()
out = []
for r in rows:
    try:
        ctx = json.loads(r["context_json"] or "{}")
    except Exception:
        ctx = {}
    out.append({
        "run_id": r["run_id"], "session_id": r["session_id"], "playbook": r["playbook"],
        "current_state_id": r["current_state_id"], "status": r["status"],
        "updated_at": r["updated_at"] or "",
        "goal": (ctx.get("goal") or "")[:500],
        "clarification_text": (ctx.get("clarification_text") or "")[:300],
    })
print(json.dumps(out))
`;

/**
 * Read pending (running / awaiting_user) orchestration runs from the
 * engine's durable checkpointer. Returns EngineRunRef[] ready for the
 * artifact. Resolves to [] on any failure — compaction must not block
 * on the engine DB.
 */
export async function queryEngineRuns(projectRoot?: string): Promise<EngineRunRef[]> {
  const root = projectRoot || process.env.PROJECT_ROOT || process.cwd();
  return new Promise((resolve) => {
    const proc = spawn(BRIDGE_CONFIG.venvPython, ["-c", ENGINE_RUNS_SCRIPT, root], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill("SIGKILL");
        logger.warn("Engine checkpointer query timed out");
        resolve([]);
      }
    }, 10000);

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        logger.warn("Engine checkpointer query failed", { code, stderr: stderr.slice(0, 200) });
        resolve([]);
        return;
      }
      try {
        const parsed: unknown = JSON.parse(stdout);
        if (!Array.isArray(parsed)) {
          resolve([]);
          return;
        }
        resolve(
          parsed.map((row: unknown): EngineRunRef => {
            const r = asRecord(row);
            return {
              run_id: String(r.run_id),
              session_id: String(r.session_id),
              playbook: String(r.playbook),
              current_state_id: String(r.current_state_id),
              // The SQL WHERE restricts status to running/awaiting_user.
              status: asString(r.status) as EngineRunRef["status"],
              updated_at: String(r.updated_at || ""),
              ...(r.goal ? { goal: String(r.goal) } : {}),
              ...(r.clarification_text ? { clarification_text: String(r.clarification_text) } : {}),
            };
          })
        );
      } catch {
        logger.warn("Engine checkpointer returned unparseable output", {
          stdout: stdout.slice(0, 200),
        });
        resolve([]);
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        logger.warn("Engine checkpointer spawn failed", { error: err.message });
        resolve([]);
      }
    });
  });
}

// ============================================================
// Mempalace Queries (what agents wrote — pointers, not state)
// ============================================================

/**
 * Read recent diary entries to detect escalation state.
 */
export async function queryDiaryEscalation(
  agentName: string = "penny",
  lastN: number = 3
): Promise<DiaryEntry[]> {
  const result = await _internals.call("diary_read", {
    agent_name: agentName,
    last_n: lastN,
  });
  if (!result.success) return [];
  const entries = asArray(asRecord(result.data).entries);
  // Filter entries that mention escalation, UNKNOWN_STATE, or verification
  return entries
    .map((e): DiaryEntry => ({ text: asString(asRecord(e).text) }))
    .filter((e) => /UNKNOWN_STATE|escalation|verification|awaiting|pending/i.test(e.text ?? ""));
}

function normalizeRoomList(roomsResult: BridgeResponse): Record<string, unknown>[] {
  const data = asRecord(roomsResult.data);
  const roomsResponse: unknown = data.rooms || roomsResult.data || {};
  if (Array.isArray(roomsResponse)) return roomsResponse.map(asRecord);
  if (typeof roomsResponse === "object" && roomsResponse !== null) {
    // Bridge returns dict {roomName: count, ...}
    const rec = roomsResponse as Record<string, unknown>;
    return Object.keys(rec).map((name) => ({ name, count: rec[name] }));
  }
  logger.warn("list_rooms returned unexpected type", { type: typeof roomsResponse });
  return [];
}

/**
 * Query mempalace for skill session rooms (all skills/* rooms).
 * Used only when no session scoping is possible.
 */
export async function queryMempalaceSkillRooms(): Promise<MempalaceRoomRef[]> {
  const roomsResult = await _internals.call("list_rooms", { wing: "penny" });
  if (!roomsResult.success) return [];

  const allRooms = normalizeRoomList(roomsResult);
  const skillRooms = allRooms.filter((r) => asString(r.name || r.room).startsWith("skills/"));

  const roomRefs: MempalaceRoomRef[] = [];
  for (const room of skillRooms) {
    const roomName = asString(room.name || room.room);
    const drawersResult = await _internals.call("list_drawers", {
      wing: "penny",
      room: roomName,
      limit: 5,
    });
    const drawers = drawersResult.success
      ? asArray(asRecord(drawersResult.data).drawers).map((d) => {
          const dr = asRecord(d);
          return asString(dr.id || dr.drawer_id);
        })
      : [];

    roomRefs.push({
      wing: "penny",
      room: roomName,
      drawer_ids: drawers,
      last_updated: asString(room.last_updated) || new Date().toISOString(),
    });
  }

  return roomRefs;
}

/**
 * Query mempalace for skill session rooms that match specific session IDs.
 *
 * A room matches when its name contains one of the session IDs (rooms are
 * conventionally named skills/<skill>-<session_id>), or when its
 * last_updated falls within the recency window. Session IDs must be REAL
 * (from a skill tool result or the engine checkpointer) — callers must
 * never pass fabricated IDs, which silently match nothing.
 */
export async function queryMempalaceSkillRoomsForSession(
  sessionIds: string[],
  recencyWindowMs: number = 86_400_000
): Promise<MempalaceRoomRef[]> {
  const ids = sessionIds.filter((s) => s && s.length > 0);
  const cutoff = new Date(Date.now() - recencyWindowMs).toISOString();

  const roomsResult = await _internals.call("list_rooms", { wing: "penny" });
  if (!roomsResult.success) return [];

  const allRooms = normalizeRoomList(roomsResult);
  const skillRooms = allRooms.filter((r) => asString(r.name || r.room).startsWith("skills/"));

  const roomRefs: MempalaceRoomRef[] = [];
  for (const room of skillRooms) {
    const roomName = asString(room.name || room.room);

    const matchesSession = ids.some((id) => roomName.toLowerCase().includes(id.toLowerCase()));
    const lastUpdated = asString(room.last_updated);
    const isRecent = Boolean(lastUpdated && lastUpdated >= cutoff);
    if (!matchesSession && !isRecent) continue;

    const drawersResult = await _internals.call("list_drawers", {
      wing: "penny",
      room: roomName,
      limit: 5,
    });
    if (!drawersResult.success) continue;

    const drawers = asArray(asRecord(drawersResult.data).drawers);
    if (drawers.length === 0) continue;

    roomRefs.push({
      wing: "penny",
      room: roomName,
      drawer_ids: drawers.map((d) => {
        const dr = asRecord(d);
        return asString(dr.id || dr.drawer_id);
      }),
      last_updated: lastUpdated || new Date().toISOString(),
      dominant_for_session: matchesSession,
    });
  }

  return roomRefs;
}

// ============================================================
// KG Entity Verification
// ============================================================

/**
 * Query KG for entities related to the run's SCOPED session ids.
 *
 * KG facts are keyed to skill/orchestration session ids (e.g. a plan run's
 * `session-…` or a `run_…` id), NOT the pi conversation UUID. Querying
 * `Session:<pi-uuid>` was a dead query that never resolved (RC-fix). We now
 * query each scoped id directly and merge, deduping by entity_id+predicate.
 * Empty scope → [] (nothing to ground).
 */
export async function queryKGEntitiesForScope(scopedIds: string[]): Promise<KGEntityRef[]> {
  const ids = scopedIds.filter((s) => s && s.length > 0);
  if (ids.length === 0) return [];
  const now = new Date().toISOString();
  const byKey = new Map<string, KGEntityRef>();

  for (const id of ids) {
    const result = await _internals.call("kg_query", { entity: id, direction: "both" });
    if (!result.success) continue;
    const triples = asArray(asRecord(result.data).facts);
    for (const t of triples) {
      const tr = asRecord(t);
      const subject = asString(tr.subject);
      const object = asString(tr.object);
      const predicate = asString(tr.predicate);
      // The queried id is one endpoint; the OTHER endpoint is the related entity.
      const entityId = object === id ? subject : object;
      if (!entityId) continue;
      const key = `${entityId}\u0000${predicate}`;
      if (byKey.has(key)) continue;
      byKey.set(key, {
        entity_id: entityId,
        entity_type: inferEntityType(predicate),
        relevant_predicates: [predicate],
        last_verified: now,
        valid_from: asString(tr.valid_from) || now,
      });
    }
  }
  return Array.from(byKey.values());
}

function inferEntityType(predicate: string): string {
  if (/session|plan|skill/i.test(predicate)) return "Session";
  if (/decision|outcome|approved/i.test(predicate)) return "Decision";
  if (/agent|invoked|completed/i.test(predicate)) return "Agent";
  if (/feature|capability/i.test(predicate)) return "Feature";
  return "Entity";
}

// ============================================================
// Outcome Ledger Decisions
// ============================================================

/**
 * Query outcome ledger (penny/outcomes room) for recent decisions SCOPED to
 * this run's sessions.
 *
 * Each outcome drawer's header carries `decision_id: <run_id> | ... |
 * session_id: <session_id> | ...` (written by outcome_writer.py), so a scoped
 * id appears verbatim in the drawer text. We fetch recent outcomes then keep
 * only those matching a scoped id — global decisions from OTHER sessions never
 * bleed into the summary (the reported staleness symptom). Empty scope → [].
 */
export async function queryOutcomeLedgerDecisions(
  scopedIds: string[],
  limit: number = 20
): Promise<DecisionRef[]> {
  const ids = scopedIds.filter((s) => s && s.length > 0);
  if (ids.length === 0) return [];
  const result = await _internals.call("search", {
    wing: "penny",
    room: "outcomes",
    limit,
  });
  if (!result.success) return [];

  const drawers = asArray(asRecord(result.data).results).filter((d) => {
    const text = asString(asRecord(d).text || asRecord(d).content);
    return ids.some((id) => text.includes(id));
  });
  return drawers.map((d, i): DecisionRef => {
    const dr = asRecord(d);
    const summary = asString(dr.text || dr.content) || "Outcome record";
    return {
      decision_id: asString(dr.id || dr.drawer_id) || `outcome-${i}`,
      summary: summary.slice(0, 200),
      outcome_room: "penny/outcomes",
      confidence: "PROBABLE",
    };
  });
}
