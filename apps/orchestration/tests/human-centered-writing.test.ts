import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const read = (relative: string): string => readFileSync(path.join(PROJECT_ROOT, relative), "utf8");

const STANDARD = "docs/agents/writing/standard.md";
const REVIEW = "docs/agents/writing/review.md";
const GENRES = [
  "correspondence",
  "documentation",
  "education",
  "policy",
  "public-writing",
  "research",
] as const;

describe("human-centered writing guidance", () => {
  it("routes one canonical normative standard and keeps human guidance advisory", () => {
    expect(read("docs/agents/AGENTS.md")).toContain("[Writing](writing/AGENTS.md)");
    expect(read("docs/agents/writing/AGENTS.md")).toContain("[Standard](standard.md)");
    expect(read("docs/agents/writing/AGENTS.md")).toContain("[Review](review.md)");
    expect(read("docs/agents/writing/AGENTS.md")).toContain("[Genres](genres/AGENTS.md)");
    expect(read("docs/humans/writing/overview.md")).toContain(
      "canonical agent guidance under `docs/agents/writing/`"
    );
    expect(read("docs/humans/writing/reference.md")).toContain(
      "normative requirements live in the canonical agent writing standard"
    );
  });

  it("protects truth, contracts, technical material, selection, and contextual voice", () => {
    const standard = read(STANDARD);
    expect(standard).toContain("Preserve source meaning");
    expect(standard).toContain("Select other supported details according to purpose");
    expect(standard).toContain("Never invent experience");
    expect(standard).toContain("samples as style evidence, not factual authority");
    expect(standard).toContain("are contextual watch items, not prohibitions");
    expect(standard).toContain("machine keys, enums, IDs, exact quotations or excerpts, commands");
    expect(standard).toContain("source-fidelity check");
    expect(standard).toContain("Independent verification");
    expect(standard).toContain("Do not try to imitate a statistical idea of human writing");
  });

  it("defines an evidence-linked audit without authorship detection or finding quotas", () => {
    const review = read(REVIEW);
    expect(review).toContain("every consequential supported weakness");
    expect(review).toContain("A clean draft may produce no findings");
    expect(review).toContain("do not overwrite the source");
    expect(review).toContain("not an authorship verdict");
    expect(review).toContain(
      "Do not use a blacklist, detector, phrase count, numerical style score"
    );
    expect(review).toContain("Integrity or contract failures cannot be offset");
  });

  it("keeps promised examples and optional personal-writing guidance in the advisory reference", () => {
    const reference = read("docs/humans/writing/reference.md");
    expect(reference).toContain("## Illustrative revisions");
    expect(reference).toContain("## Personal and application writing");
    expect(reference).toContain("## Optional author review");
    expect(reference).toContain("not proof that external claims were independently verified");
  });

  it("provides indexed genre additions for all six supported writing families", () => {
    const index = read("docs/agents/writing/genres/AGENTS.md");
    for (const genre of GENRES) {
      const file = `docs/agents/writing/genres/${genre}.md`;
      expect(existsSync(path.join(PROJECT_ROOT, file)), file).toBe(true);
      expect(index).toContain(`(${genre}.md)`);
      expect(read(file).trim().length).toBeGreaterThan(200);
    }
    expect(read("docs/agents/writing/genres/documentation.md")).toContain("verification commands");
    expect(read("docs/agents/writing/genres/policy.md")).toContain("MUST, SHALL, SHOULD, and MAY");
    expect(read("docs/agents/writing/genres/research.md")).toContain(
      "Any later semantic revision must return through the existing grounding and review gates"
    );
  });

  it("ships non-destructive drafting, revision, and audit prompt templates", () => {
    const draft = read(".pi/prompts/draft-document.md");
    const revise = read(".pi/prompts/revise-document.md");
    const audit = read(".pi/prompts/human-centered-audit.md");
    expect(draft).toContain("$ARGUMENTS");
    expect(draft).toContain("reader, relationship, purpose");
    expect(revise).toContain("Do not overwrite");
    expect(revise).toContain("light edit, voice-preserving revision, structural rewrite");
    expect(audit).toContain("read-only audit");
    expect(audit).toContain("do not edit or overwrite");
    expect(audit).toContain("do not pad or cap the findings");
    expect(audit).toContain("Do not issue an AI-authorship verdict");
  });

  it("keeps only a compact universal policy in the Cognitive Frame", () => {
    const frame = read(".pi/SYSTEM.md");
    expect(frame).toContain("For human-readable prose, match the reader, purpose, genre");
    expect(frame).toContain("apply the human-centered writing guidance");
    expect(frame).toContain("machine-readable contracts");
    expect(frame).not.toContain("Human-Centered Writing Standard");
  });

  it("adds task-specific author and reviewer clauses without changing typed contracts", () => {
    const authorPrompts = [
      ".pi/skills/assess/assets/prompts/carren-authoring_assessment.md",
      ".pi/skills/decide/assets/prompts/demetri-deciding.md",
      ".pi/skills/diagnose/assets/prompts/demetri-adjudicating_diagnosis.md",
      ".pi/skills/plan/assets/prompts/piper-strategizing.md",
      ".pi/skills/produce/assets/prompts/skribble-materializing_artifact.md",
      ".pi/skills/research/assets/prompts/synthia-synthesizing.md",
    ];
    const editorialPrompts = [
      ".pi/skills/decide/assets/prompts/carren-critiquing_decision.md",
      ".pi/skills/plan/assets/prompts/carren-critiquing_strategy.md",
      ".pi/skills/produce/assets/prompts/carren-critiquing_artifact.md",
      ".pi/skills/research/assets/prompts/carren-critiquing_report.md",
    ];
    const verificationPrompts = [
      ".pi/skills/assess/assets/prompts/vera-verifying_assessment.md",
      ".pi/skills/decide/assets/prompts/vera-verifying_decision.md",
      ".pi/skills/diagnose/assets/prompts/vera-verifying_diagnosis.md",
      ".pi/skills/plan/assets/prompts/vera-verifying_strategy.md",
      ".pi/skills/produce/assets/prompts/vera-verifying_artifact.md",
      ".pi/skills/research/assets/prompts/vera-validating.md",
    ];
    for (const file of authorPrompts) {
      expect(read(file), file).toContain("## Reader-facing writing");
      expect(read(file), file).toContain("Preserve this phase's exact schema");
    }
    for (const file of editorialPrompts) {
      expect(read(file), file).toContain("## Editorial review");
      expect(read(file), file).toContain("arbitrary finding count");
    }
    for (const file of verificationPrompts) {
      expect(read(file), file).toContain("## Writing integrity verification");
      expect(read(file), file).toContain("Do not perform style or quality critique");
      expect(read(file), file).toContain("Preserve this phase's exact schema");
    }
    const kbVerification = read(".pi/skills/knowledge-base/assets/prompts/vera-verify.md");
    expect(kbVerification).toContain("Context is not evidence");
    expect(kbVerification).toContain(
      "Do not perform subjective style, wording, or organization critique"
    );
    expect(kbVerification).not.toContain("judging wording and organization");
  });
});
