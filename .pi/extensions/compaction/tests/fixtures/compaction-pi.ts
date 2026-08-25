import type compactionExtension from "../../index.js";
import { PennyCompactArtifactSchema, type PennyCompactArtifact } from "../../schema.js";
import { isRecord } from "../../../../lib/tests/test-narrowers.js";

type CompactionExtensionApi = Parameters<typeof compactionExtension>[0];
type CompactionHandler = Parameters<CompactionExtensionApi["on"]>[1];

export type CompactionEvent = Parameters<CompactionHandler>[0];
export type CompactionContext = Parameters<CompactionHandler>[1];

export interface CompactionHookResult {
  cancel?: boolean;
  compaction: {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    details: PennyCompactArtifact;
  };
}

function isCompactionHookResult(value: unknown): value is CompactionHookResult {
  if (!isRecord(value) || !isRecord(value.compaction)) return false;
  const { summary, firstKeptEntryId, tokensBefore, details } = value.compaction;
  return (
    typeof summary === "string" &&
    typeof firstKeptEntryId === "string" &&
    typeof tokensBefore === "number" &&
    PennyCompactArtifactSchema.safeParse(details).success
  );
}

export function createMockCompactionPi(defaultContext?: CompactionContext) {
  const handlers: CompactionHandler[] = [];
  const calls: Array<{ event: "session_before_compact"; handler: CompactionHandler }> = [];
  const api: CompactionExtensionApi = {
    on: (event, handler) => {
      calls.push({ event, handler });
      handlers.push(handler);
    },
  };

  const emit = async (
    event: CompactionEvent,
    context: CompactionContext = defaultContext
  ): Promise<CompactionHookResult | undefined> => {
    for (const handler of handlers) {
      const result = await handler(event, context);
      if (result != null) {
        if (!isCompactionHookResult(result)) {
          throw new Error("compaction hook emitted an invalid result fixture");
        }
        return result;
      }
    }
    return undefined;
  };

  const emitRequired = async (
    event: CompactionEvent,
    context: CompactionContext = defaultContext
  ): Promise<CompactionHookResult> => {
    const result = await emit(event, context);
    if (!result) throw new Error("compaction hook did not emit a result");
    return result;
  };

  return { api, calls, handlers, emit, emitRequired };
}
