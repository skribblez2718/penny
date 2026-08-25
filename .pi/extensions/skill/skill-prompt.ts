const PI_NATIVE_SKILL_INSTRUCTION =
  "Use the read tool to load a skill's file when the task matches its description.";

export const PENNY_SKILL_INSTRUCTION =
  "When a listed skill matches the task, invoke its registered entrypoint rather than executing its documentation directly; use read only to inspect that documentation.";

/**
 * Align Pi's native progressive-disclosure sentence with Penny's engine-backed
 * execution path while retaining Pi's canonical <available_skills> catalog.
 */
export function alignNativeSkillInstruction(systemPrompt: string): string {
  return systemPrompt.includes(PI_NATIVE_SKILL_INSTRUCTION)
    ? systemPrompt.replace(PI_NATIVE_SKILL_INSTRUCTION, PENNY_SKILL_INSTRUCTION)
    : systemPrompt;
}
