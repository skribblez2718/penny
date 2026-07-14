/**
 * LOAN registry (TypeScript side) — tagged KNOWLEDGE-CONSTRAINT scaffolding
 * with Ablate hooks, mirroring the engine's `apps/orchestration/.../loans.py`.
 *
 * Doctrine (docs/agents/architecture/atomic-loop-components.md, assembly
 * invariant 6): any mechanism that exists because the CURRENT model is weak
 * (or unreachable) is a LOAN — tagged, toggleable, and scheduled for
 * re-measurement. The recurring Bitter-Lesson pass inventories BOTH the Python
 * registry and this one.
 *
 * Setting `PENNY_ABLATE_<LOAN_ID>=1` turns the mechanism OFF for a scaffold-ON
 * vs scaffold-OFF ablation run. Querying an unregistered id throws — a
 * mechanism cannot be toggled without being tagged here first.
 */

export interface Loan {
  /** snake_case id; toggle env is PENNY_ABLATE_<LOAN_ID uppercased>. */
  loanId: string;
  /** what the mechanism does and where it lives. */
  description: string;
  /** the model weakness this compensates for (why it was borrowed). */
  rationale: string;
  /** YYYY-MM-DD the loan was taken. */
  added: string;
  /** YYYY-MM-DD expiry review (re-ablate at/before this date). */
  reviewBy: string;
}

export const LOANS: Record<string, Loan> = {
  compaction_deterministic_summary: {
    loanId: "compaction_deterministic_summary",
    description:
      "The deterministic prose-assembly fallback (precedence ladder + " +
      "createProseSummary) used when no summarization model is reachable " +
      "(missing auth/model, timeout, abort, empty output).",
    rationale:
      "Keeps compaction alive with zero LLM availability. The model path " +
      "(model summarizes the real conversation) is the leverage mechanism; " +
      "this deterministic path substitutes hand-built extraction for model " +
      "judgment and must be re-measured as model reachability improves.",
    added: "2026-07-14",
    reviewBy: "2026-10-01",
  },
};

/** Ablate hook: true when the loan's mechanism should run. */
export function loanEnabled(loanId: string): boolean {
  const loan = LOANS[loanId];
  if (!loan) {
    throw new Error(`unknown loan id '${loanId}' — tag it in loans.ts first`);
  }
  const envName = `PENNY_ABLATE_${loan.loanId.toUpperCase()}`;
  return process.env[envName] !== "1";
}

/** The loan inventory, for the recurring Bitter-Lesson pass. */
export function listLoans(): Loan[] {
  return Object.values(LOANS);
}
