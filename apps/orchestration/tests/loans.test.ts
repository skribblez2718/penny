import { describe, expect, it } from "vitest";

import { COMPATIBILITY_LOANS, loanReviewState, loansNeedingReview } from "../src/loans.js";

describe("TypeScript orchestration compatibility loans", () => {
  it("registers the active TypeScript research compatibility loans", () => {
    expect(COMPATIBILITY_LOANS.map((loan) => loan.id)).toEqual([
      "research-mode-presets",
      "research-fixed-topology",
      "research-three-file-output",
      // The typed terminating result is primary; this records the bounded
      // compatibility fallback for custom or text-only model clients.
      "prose-summary-fallback",
      "research-verifier-model-default",
    ]);
  });

  it("makes current, changed, overdue, and unknown review states visible", () => {
    const loan = COMPATIBILITY_LOANS[0]!;
    expect(loanReviewState(loan, loan.assumptionDigest, new Date("2026-08-16T00:00:00Z"))).toBe(
      "current"
    );
    expect(loanReviewState(loan, "changed", new Date("2026-08-16T00:00:00Z"))).toBe("changed");
    expect(loanReviewState(loan, loan.assumptionDigest, new Date("2027-01-01T00:00:00Z"))).toBe(
      "overdue"
    );
    expect(loanReviewState(undefined, undefined)).toBe("unknown");
  });

  it("treats unknown and overdue loans as needing review", () => {
    const needingReview = loansNeedingReview({}, new Date("2027-01-01T00:00:00Z"));
    expect(needingReview).toHaveLength(COMPATIBILITY_LOANS.length);
    expect(needingReview.every(({ state }) => state === "unknown")).toBe(true);
  });
});
