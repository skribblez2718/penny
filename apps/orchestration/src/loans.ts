export type LoanReviewState = "current" | "changed" | "overdue" | "unknown";

export interface CompatibilityLoan {
  readonly id: string;
  readonly description: string;
  readonly owner: string;
  readonly reviewBy: string;
  readonly assumptionDigest: string;
}

export const COMPATIBILITY_LOANS: readonly CompatibilityLoan[] = [
  {
    id: "research-mode-presets",
    description:
      "Quick, standard, and deep remain compatibility labels that expand into verification budgets.",
    owner: "orchestration",
    reviewBy: "2026-11-14",
    assumptionDigest: "f2c87cb48bbd2795687f53a81bd28aa01063fed6722a31bdd74c2d22addd96ab",
  },
  {
    id: "research-fixed-topology",
    description:
      "Research retains the corrected Python state topology while TypeScript parity and live outcomes are measured.",
    owner: "orchestration",
    reviewBy: "2026-11-14",
    assumptionDigest: "48f35d59307b00112247a9cf92fbbf51f5472c4ac3a432cd161720849b0ab0bd",
  },
  {
    id: "research-three-file-output",
    description:
      "Research continues producing report.md, sources.md, and README.md for compatibility.",
    owner: "orchestration",
    reviewBy: "2026-11-14",
    assumptionDigest: "d892d88ca02cbf52bded4ae11df453f4fc780e371f446f454652596c8fb00047",
  },
  {
    id: "research-verifier-model-default",
    description:
      "Synthia and Vera may share a model unless a caller or environment override selects an independent verifier.",
    owner: "orchestration",
    reviewBy: "2026-10-15",
    assumptionDigest: "4ac2c2ae28a4538e4fb8ed9efb70db0f08a66d9192f4e54aa8b86030441452e0",
  },
] as const;

export function loanReviewState(
  loan: CompatibilityLoan | undefined,
  currentAssumptionDigest: string | undefined,
  now = new Date()
): LoanReviewState {
  if (loan === undefined || currentAssumptionDigest === undefined) {
    return "unknown";
  }
  if (currentAssumptionDigest !== loan.assumptionDigest) {
    return "changed";
  }
  const reviewDeadline = Date.parse(`${loan.reviewBy}T23:59:59.999Z`);
  if (!Number.isFinite(reviewDeadline)) {
    return "unknown";
  }
  return now.getTime() > reviewDeadline ? "overdue" : "current";
}

export function loansNeedingReview(
  currentDigests: Readonly<Record<string, string | undefined>>,
  now = new Date()
): Array<{ loan: CompatibilityLoan; state: LoanReviewState }> {
  return COMPATIBILITY_LOANS.map((loan) => ({
    loan,
    state: loanReviewState(loan, currentDigests[loan.id], now),
  })).filter(({ state }) => state !== "current");
}
