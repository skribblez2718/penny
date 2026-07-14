import { describe, it, expect, afterEach } from "vitest";
import { LOANS, listLoans, loanEnabled } from "../../loans.js";

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

describe("loan registry hygiene (invariant 6)", () => {
  it("registers the deterministic-summary fallback loan", () => {
    expect(LOANS.compaction_deterministic_summary).toBeDefined();
    expect(listLoans().length).toBeGreaterThanOrEqual(1);
  });

  it("every loan carries rationale, dates, and a snake_case id", () => {
    for (const loan of listLoans()) {
      expect(loan.loanId).toBe(loan.loanId.toLowerCase());
      expect(loan.description.trim()).not.toBe("");
      expect(loan.rationale.trim()).not.toBe("");
      expect(loan.added).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(loan.reviewBy).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("loanEnabled (Ablate hook)", () => {
  it("is enabled by default and disabled by the toggle env", () => {
    delete process.env.PENNY_ABLATE_COMPACTION_DETERMINISTIC_SUMMARY;
    expect(loanEnabled("compaction_deterministic_summary")).toBe(true);
    process.env.PENNY_ABLATE_COMPACTION_DETERMINISTIC_SUMMARY = "1";
    expect(loanEnabled("compaction_deterministic_summary")).toBe(false);
  });

  it("fails loud on an unregistered id", () => {
    expect(() => loanEnabled("not_a_loan")).toThrow(/unknown loan id/);
  });
});
