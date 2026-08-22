import { canonicalJson } from "./contracts.js";

export type AnswerQualityFailureReason =
  | "missing_result"
  | "not_complete_met"
  | "unsupported_citation"
  | "verification_unsupported";

/**
 * One terminal observation supplied to the answer-quality scorer.
 *
 * The scorer is intentionally independent of a fixture, receipt, agent, or
 * runtime. Adapters execute the system under test and project its terminal
 * result, answer citations, and verification verdict into this closed shape.
 */
export interface AnswerQualityFinalResult {
  readonly status: string;
  readonly met: boolean;
  readonly citations: readonly unknown[];
  readonly verificationSupported: boolean;
}

export interface AnswerQualityCaseObservation {
  readonly caseId: string;
  readonly supportedCitations: readonly unknown[];
  readonly finalResult?: AnswerQualityFinalResult;
}

export interface AnswerQualityCaseScore {
  readonly caseId: string;
  readonly bad: boolean;
  readonly reasons: readonly AnswerQualityFailureReason[];
}

export interface AnswerQualityScore {
  readonly badAnswers: number;
  readonly caseCount: number;
  readonly badAnswerRate: number;
  readonly cases: readonly AnswerQualityCaseScore[];
}

/**
 * Compute the frozen G8 answer-quality metric: `bad_answers / N`.
 *
 * Every supplied case remains in N. Missing results, abstentions, refused,
 * error, and exhausted terminals cannot be filtered out by this function.
 */
export function scoreAnswerQuality(
  observations: readonly AnswerQualityCaseObservation[]
): AnswerQualityScore {
  if (observations.length === 0) {
    throw new Error("answer-quality scoring requires at least one fixture case");
  }

  const cases = observations.map((observation): AnswerQualityCaseScore => {
    const reasons: AnswerQualityFailureReason[] = [];
    const finalResult = observation.finalResult;
    if (finalResult === undefined) {
      reasons.push("missing_result");
    } else {
      if (finalResult.status !== "complete" || finalResult.met !== true) {
        reasons.push("not_complete_met");
      }

      const supported = new Set(observation.supportedCitations.map(canonicalJson));
      if (finalResult.citations.some((citation) => !supported.has(canonicalJson(citation)))) {
        reasons.push("unsupported_citation");
      }
      if (!finalResult.verificationSupported) {
        reasons.push("verification_unsupported");
      }
    }

    return {
      caseId: observation.caseId,
      bad: reasons.length > 0,
      reasons,
    };
  });
  const badAnswers = cases.filter((result) => result.bad).length;
  return {
    badAnswers,
    caseCount: observations.length,
    badAnswerRate: badAnswers / observations.length,
    cases,
  };
}
