import type {
  AgentSession,
  LoadExtensionsResult,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

export interface CompactionProgress {
  readonly activity_class: "assistant_text_delta" | "assistant_thinking_delta";
  readonly observed_units: number;
}

export function enforceNativeAutoCompaction(settings: SettingsManager): SettingsManager;
export interface CompactionProgressObserver {
  extensionsOverride(base: LoadExtensionsResult): LoadExtensionsResult;
  observe(session: AgentSession, signal?: AbortSignal): () => void;
}
export function createCompactionProgressObserver(
  report: (progress: CompactionProgress) => void
): CompactionProgressObserver;
export function compactionDeltaProgress(event: unknown): CompactionProgress | undefined;
export function isCompactionProgress(value: unknown): value is CompactionProgress;
export function observeNativeCompactionProgress(
  session: AgentSession,
  report: (progress: CompactionProgress) => void
): () => void;
