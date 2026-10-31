/** Synthetic values shaped from Voice Studio 2.x schemas/voices.py, narration.py,
 * system.py and tts.py. No operator identity, reference transcript or sample bytes. */
export const SOURCE_SHAPED_VOICE = {
  id: "012345abcdef",
  name: "Synthetic designed voice",
  source: "designed",
  is_builtin: false,
  meta: {
    language: "English",
    sample_rate: 24000,
    duration_sec: 20,
    instruct: "Synthetic instruction",
    ref_text: "Synthetic reference words.",
  },
  created_at: 1780000000.123456,
};
export const SOURCE_SHAPED_HEALTH = {
  status: "ok",
  version: "2.0.0",
  models_loaded: false,
  gpu_available: true,
  engine: "Qwen3TTSEngine",
};
export const SOURCE_SHAPED_NARRATION = {
  id: "abcdef012345",
  title: "Synthetic narration",
  source_text: "Synthetic words.",
  instruct: null,
  voice_profile_id: SOURCE_SHAPED_VOICE.id,
  status: "draft",
  created_at: 1780000001.654321,
  chunk_count: 1,
  char_count: 16,
};
export const SOURCE_SHAPED_JOB = {
  job_id: "123456abcdef",
  narration_item_id: SOURCE_SHAPED_NARRATION.id,
  status: "completed",
  total_chunks: 1,
  completed: 1,
  errored: 0,
  percent: 100,
};
