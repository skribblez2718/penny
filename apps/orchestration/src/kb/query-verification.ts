import {
  DerivedQueryAnswerSchema,
  KbArtifactHandleSchema,
  QueryAnswerArtifactSchema,
  QueryVerificationReportSchema,
  canonicalJson,
  sha256Hex,
  validateKbContract,
  type DerivedCitation,
  type DerivedQueryAnswer,
  type KbArtifactHandle,
  type QueryVerificationReport,
} from "./contracts.js";

export interface QueryVerificationAssessment {
  readonly passed: boolean;
  readonly answer?: DerivedQueryAnswer;
  readonly report?: QueryVerificationReport;
  readonly reason?:
    | "answer_malformed"
    | "report_malformed"
    | "answer_handle_malformed"
    | "answer_artifact_id_mismatch"
    | "answer_digest_mismatch"
    | "answer_unsupported"
    | "citation_set_mismatch"
    | "citation_unsupported"
    | "report_failed";
}

function citationKey(citation: DerivedCitation): string {
  return canonicalJson(citation);
}

/**
 * Validate a query answer and Vera report as one closed pair.
 *
 * `passed: true` is not trusted on its own. A passing pair has exactly one
 * finding for every answer citation, no findings for anything else, and every
 * finding is `supported`. This function is shared by save-claim finalization and
 * parent delivery so those authority checks cannot drift.
 */
export function assessQueryVerification(
  answerArtifact: unknown,
  verificationReport: unknown,
  answerHandle: unknown
): QueryVerificationAssessment {
  let answer: DerivedQueryAnswer;
  let artifactJcs: string;
  try {
    const artifact = validateKbContract(
      QueryAnswerArtifactSchema,
      answerArtifact,
      "query answer artifact"
    );
    answer = validateKbContract(DerivedQueryAnswerSchema, artifact.answer, "derived answer");
    artifactJcs = canonicalJson(artifact);
  } catch {
    return { passed: false, reason: "answer_malformed" };
  }

  let handle: KbArtifactHandle;
  try {
    handle = validateKbContract(KbArtifactHandleSchema, answerHandle, "query answer handle");
    if (handle.artifact_kind !== "query_answer" || handle.sha256 !== sha256Hex(artifactJcs)) {
      return { passed: false, answer, reason: "answer_handle_malformed" };
    }
  } catch {
    return { passed: false, answer, reason: "answer_handle_malformed" };
  }

  let report: QueryVerificationReport;
  try {
    report = validateKbContract(
      QueryVerificationReportSchema,
      verificationReport,
      "query verification report"
    );
  } catch {
    return { passed: false, answer, reason: "report_malformed" };
  }

  if (report.answer_artifact_id !== handle.artifact_id) {
    return { passed: false, answer, report, reason: "answer_artifact_id_mismatch" };
  }
  if (report.answer_sha256 !== handle.sha256) {
    return { passed: false, answer, report, reason: "answer_digest_mismatch" };
  }
  if (report.answer_verdict !== "supported") {
    return { passed: false, answer, report, reason: "answer_unsupported" };
  }

  const answerKeys = answer.citations.map(citationKey);
  const findingKeys = report.citation_findings.map((finding) => citationKey(finding.citation));
  if (
    new Set(answerKeys).size !== answerKeys.length ||
    new Set(findingKeys).size !== findingKeys.length ||
    answerKeys.length !== findingKeys.length ||
    answerKeys.some((key) => !findingKeys.includes(key))
  ) {
    return { passed: false, answer, report, reason: "citation_set_mismatch" };
  }
  if (report.citation_findings.some((finding) => finding.verdict !== "supported")) {
    return { passed: false, answer, report, reason: "citation_unsupported" };
  }
  if (!report.passed) {
    return { passed: false, answer, report, reason: "report_failed" };
  }
  return { passed: true, answer, report };
}
