/**
 * Shared hard budget enforcement for model-visible tool results.
 *
 * The measured value is the final JSON serialization of the complete Pi tool
 * result, not only the text payload nested inside it.
 */

export const HARD_MAX_RESULT_BYTES = 32_768;
export const HARD_MAX_RESULT_CHARACTERS = 32_768;
export const HARD_MAX_ESTIMATED_TOKENS = 8_192;

/**
 * Release contexts must have at least two hard-result caps available before a
 * tool call. A conforming maximum-size result therefore leaves one full hard
 * cap reserved for the model's next action.
 */
export const RELEASE_MINIMUM_CONTEXT_HEADROOM_TOKENS = HARD_MAX_ESTIMATED_TOKENS * 2;
export const RELEASE_RESERVED_AFTER_RESULT_TOKENS = HARD_MAX_ESTIMATED_TOKENS;

const MIN_MAX_RESULT_BYTES = 512;
const MIN_MAX_RESULT_CHARACTERS = 512;
const MIN_MAX_ESTIMATED_TOKENS = 256;

export interface TextToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolResultBudget {
  maxBytes: number;
  maxCharacters: number;
  maxEstimatedTokens: number;
}

export interface ToolResultMeasurement {
  serialized: string;
  bytes: number;
  characters: number;
  estimatedTokens: number;
}

export interface ReleaseHeadroomAssessment {
  releaseMinimumContextHeadroomTokens: number;
  requiredReservedAfterResultTokens: number;
  estimatedReservedAfterResultTokens: number;
  invariantPreserved: boolean;
}

export interface FittedUtf8ToolResult {
  end: number;
  text: string;
  result: TextToolResult;
  measurement: ToolResultMeasurement;
  truncated: boolean;
}

export class ToolResultBudgetError extends Error {
  readonly code = "TOOL_RESULT_BUDGET_EXCEEDED";

  constructor(message: string) {
    super(message);
    this.name = "ToolResultBudgetError";
  }
}

export class ToolResultBudgetConfigError extends Error {
  readonly code = "TOOL_RESULT_BUDGET_CONFIG_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ToolResultBudgetConfigError";
  }
}

export const DEFAULT_TOOL_RESULT_BUDGET: ToolResultBudget = Object.freeze({
  maxBytes: HARD_MAX_RESULT_BYTES,
  maxCharacters: HARD_MAX_RESULT_CHARACTERS,
  maxEstimatedTokens: HARD_MAX_ESTIMATED_TOKENS,
});

function parseLowerCap(
  raw: string | undefined,
  name: string,
  minimum: number,
  hardMaximum: number
): number {
  if (raw === undefined || raw.trim() === "") return hardMaximum;
  if (!/^\d+$/.test(raw.trim())) {
    throw new ToolResultBudgetConfigError(`${name} must be an integer`);
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > hardMaximum) {
    throw new ToolResultBudgetConfigError(`${name} must be between ${minimum} and ${hardMaximum}`);
  }
  return value;
}

/** Resolve owner-supplied lower caps. Values that attempt to raise a hard cap fail closed. */
export function resolveToolResultBudget(
  env: Readonly<Record<string, string | undefined>>
): ToolResultBudget {
  return {
    maxBytes: parseLowerCap(
      env.PENNY_TOOL_RESULT_MAX_BYTES,
      "PENNY_TOOL_RESULT_MAX_BYTES",
      MIN_MAX_RESULT_BYTES,
      HARD_MAX_RESULT_BYTES
    ),
    maxCharacters: parseLowerCap(
      env.PENNY_TOOL_RESULT_MAX_CHARACTERS,
      "PENNY_TOOL_RESULT_MAX_CHARACTERS",
      MIN_MAX_RESULT_CHARACTERS,
      HARD_MAX_RESULT_CHARACTERS
    ),
    maxEstimatedTokens: parseLowerCap(
      env.PENNY_TOOL_RESULT_MAX_TOKENS,
      "PENNY_TOOL_RESULT_MAX_TOKENS",
      MIN_MAX_ESTIMATED_TOKENS,
      HARD_MAX_ESTIMATED_TOKENS
    ),
  };
}

export function createTextToolResult(
  payload: unknown,
  options: {
    details?: Record<string, unknown>;
    isError?: boolean;
  } = {}
): TextToolResult {
  const result: TextToolResult = {
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
  if (options.details !== undefined) result.details = options.details;
  if (options.isError !== undefined) result.isError = options.isError;
  return result;
}

/**
 * Tokenizer-independent upper bound used for budget enforcement.
 *
 * Every serialized UTF-8 byte is charged as one estimated token. The estimate
 * never divides or discounts bytes, so arbitrary ASCII, escapes, and multibyte
 * content receive the same provably conservative byte-level treatment. No
 * fixed estimator reserve is needed because the complete envelope is measured.
 */
export function estimateSerializedTokens(serializedUtf8Bytes: number): number {
  return serializedUtf8Bytes;
}

/** Assess the release reserve implied by one model-visible result. */
export function assessReleaseHeadroom(estimatedResultTokens: number): ReleaseHeadroomAssessment {
  const estimatedReservedAfterResultTokens =
    RELEASE_MINIMUM_CONTEXT_HEADROOM_TOKENS - estimatedResultTokens;
  return {
    releaseMinimumContextHeadroomTokens: RELEASE_MINIMUM_CONTEXT_HEADROOM_TOKENS,
    requiredReservedAfterResultTokens: RELEASE_RESERVED_AFTER_RESULT_TOKENS,
    estimatedReservedAfterResultTokens,
    invariantPreserved: estimatedReservedAfterResultTokens >= RELEASE_RESERVED_AFTER_RESULT_TOKENS,
  };
}

export function measureToolResult(result: TextToolResult): ToolResultMeasurement {
  const serialized = JSON.stringify(result);
  const bytes = Buffer.byteLength(serialized, "utf8");
  return {
    serialized,
    bytes,
    characters: serialized.length,
    estimatedTokens: estimateSerializedTokens(bytes),
  };
}

export function fitsToolResultBudget(
  measurement: ToolResultMeasurement,
  budget: ToolResultBudget
): boolean {
  return (
    measurement.bytes <= Math.min(budget.maxBytes, HARD_MAX_RESULT_BYTES) &&
    measurement.characters <= Math.min(budget.maxCharacters, HARD_MAX_RESULT_CHARACTERS) &&
    measurement.estimatedTokens <= Math.min(budget.maxEstimatedTokens, HARD_MAX_ESTIMATED_TOKENS) &&
    assessReleaseHeadroom(measurement.estimatedTokens).invariantPreserved
  );
}

export function enforceToolResultBudget(
  result: TextToolResult,
  budget: ToolResultBudget
): ToolResultMeasurement {
  const measurement = measureToolResult(result);
  if (!fitsToolResultBudget(measurement, budget)) {
    throw new ToolResultBudgetError(
      `Final tool-result envelope exceeds configured budget (${measurement.bytes} bytes, ` +
        `${measurement.characters} characters, ${measurement.estimatedTokens} estimated tokens)`
    );
  }
  return measurement;
}

export function isUtf8Boundary(source: Buffer, offset: number): boolean {
  if (!Number.isInteger(offset) || offset < 0 || offset > source.length) return false;
  if (offset === 0 || offset === source.length) return true;
  const byte = source[offset];
  return byte !== undefined && (byte & 0xc0) !== 0x80;
}

function previousUtf8Boundary(source: Buffer, offset: number, floor: number): number {
  let candidate = Math.min(offset, source.length);
  while (candidate > floor && !isUtf8Boundary(source, candidate)) candidate -= 1;
  return candidate;
}

/**
 * Fit an exact UTF-8 slice by measuring each candidate's complete tool-result
 * envelope. The returned end is always a code-point boundary, so consecutive
 * continuation pages reassemble byte-for-byte.
 */
export function fitUtf8ToolResult(options: {
  source: Buffer;
  start: number;
  end: number;
  budget: ToolResultBudget;
  build: (end: number, text: string, truncated: boolean) => TextToolResult;
}): FittedUtf8ToolResult {
  const { source, start, end, budget, build } = options;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    end > source.length ||
    !isUtf8Boundary(source, start) ||
    !isUtf8Boundary(source, end)
  ) {
    throw new ToolResultBudgetError("UTF-8 slice bounds are invalid");
  }

  const evaluate = (candidateEnd: number): FittedUtf8ToolResult => {
    const truncated = candidateEnd < end;
    const text = source.subarray(start, candidateEnd).toString("utf8");
    const result = build(candidateEnd, text, truncated);
    return {
      end: candidateEnd,
      text,
      result,
      measurement: measureToolResult(result),
      truncated,
    };
  };

  const complete = evaluate(end);
  if (fitsToolResultBudget(complete.measurement, budget)) return complete;

  const empty = evaluate(start);
  if (!fitsToolResultBudget(empty.measurement, budget)) {
    throw new ToolResultBudgetError("Tool-result metadata alone exceeds the configured budget");
  }

  let low = start;
  let high = end;
  let best = empty;
  while (low < high) {
    const midpoint = low + Math.ceil((high - low) / 2);
    const candidateEnd = previousUtf8Boundary(source, midpoint, start);
    if (candidateEnd <= low) {
      high = midpoint - 1;
      continue;
    }

    const candidate = evaluate(candidateEnd);
    if (fitsToolResultBudget(candidate.measurement, budget)) {
      best = candidate;
      low = candidateEnd;
    } else {
      high = candidateEnd - 1;
    }
  }

  if (best.end === start && start < end) {
    throw new ToolResultBudgetError("Configured budget cannot fit one UTF-8 code point");
  }
  return best;
}
