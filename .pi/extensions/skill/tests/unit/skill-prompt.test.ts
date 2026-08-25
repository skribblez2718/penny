import { describe, expect, it } from "vitest";

import { alignNativeSkillInstruction, PENNY_SKILL_INSTRUCTION } from "../../skill-prompt.js";

const PI_NATIVE_SKILL_INSTRUCTION =
  "Use the read tool to load a skill's file when the task matches its description.";

describe("native skill prompt alignment", () => {
  it("replaces Pi's generic read-to-load instruction with the engine invocation contract", () => {
    const prompt = `Skills\n${PI_NATIVE_SKILL_INSTRUCTION}\n<available_skills />`;
    const aligned = alignNativeSkillInstruction(prompt);

    expect(aligned).toContain(PENNY_SKILL_INSTRUCTION);
    expect(aligned).not.toContain(PI_NATIVE_SKILL_INSTRUCTION);
  });

  it("leaves prompts without Pi's native skill sentence unchanged", () => {
    const prompt = "No native skill catalog is active.";
    expect(alignNativeSkillInstruction(prompt)).toBe(prompt);
  });
});
