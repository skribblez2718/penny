import { describe, it, expect } from "vitest";
// Import the questionnaire extension's createQuestionnaireUI to test directly
import type { Question } from "../../index.js";

describe("answer debug", () => {
  it("verify answer value is set for multi", async () => {
    const mod = await import("../../index.js");
    const ui = mod.createQuestionnaireUI([
      { id: "q1", label: "Q1", prompt: "Pick", options: [
        { value: "a", label: "Option A" },
        { value: "b", label: "Option B" },
      ], type: "multi", allowOther: false }
    ], () => {});
    
    // Simulate selecting first option with Space, then Enter
    ui.handleInput(" ");  // toggle option 0
    ui.handleInput("\r"); // confirm
    
    const result = ui.getResult();
    console.log("Result:", JSON.stringify(result?.answers));
  });
});
