// Produce review wire only. Author formats and other skills retain their own grammars.
// The closed review schema has depth < 8 and fewer than 1,024 values even at full arrays.
// Preflight ceilings leave schema headroom, but bound hostile input before schema walking.
const MAX_REVIEW_JSON_DEPTH = 16;
const MAX_REVIEW_JSON_VALUES = 4_096;

/** Parse exactly one JSON value at an offset, retaining its end for explicit wire framing.
 * Duplicate *decoded* keys are rejected at every level before JSON.parse can discard them.
 * Work is linear in the already byte-bounded input; recursion and value count are bounded.
 */
export function parseProduceReviewJson(
  text: string,
  start: number
): {
  readonly value: unknown;
  readonly end: number;
} {
  let offset = start;
  let values = 0;
  const invalid = (): never => {
    throw new Error("invalid or ambiguous Produce review JSON");
  };
  const whitespace = (): void => {
    while (offset < text.length && /[ \t\r\n]/u.test(text[offset] ?? "")) offset += 1;
  };
  const string = (): string => {
    const begin = offset;
    if (text[offset++] !== '"') return invalid();
    while (offset < text.length) {
      const character = text[offset++];
      if (character === '"') {
        const decoded: unknown = JSON.parse(text.slice(begin, offset));
        return typeof decoded === "string" && !decoded.includes("\0") && !decoded.includes("\ufeff")
          ? decoded
          : invalid();
      }
      if (character === "\\") {
        // JSON.parse below validates escape spelling and surrogate representation.
        if (offset >= text.length) return invalid();
        offset += 1;
      } else if (character === undefined || character.charCodeAt(0) < 0x20) return invalid();
    }
    return invalid();
  };
  const value = (depth: number): void => {
    if (depth > MAX_REVIEW_JSON_DEPTH || ++values > MAX_REVIEW_JSON_VALUES) invalid();
    whitespace();
    const character = text[offset];
    if (character === '"') {
      string();
      return;
    }
    if (character === "{" || character === "[") {
      const object = character === "{";
      const close = object ? "}" : "]";
      offset += 1;
      whitespace();
      if (text[offset] === close) {
        offset += 1;
        return;
      }
      const keys = new Set<string>();
      while (offset < text.length) {
        if (object) {
          const key = string();
          if (keys.has(key)) invalid();
          keys.add(key);
          whitespace();
          if (text[offset++] !== ":") invalid();
        }
        value(depth + 1);
        whitespace();
        if (text[offset] === close) {
          offset += 1;
          return;
        }
        if (text[offset++] !== ",") invalid();
        whitespace();
      }
      invalid();
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, offset)) {
        offset += literal.length;
        return;
      }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(text.slice(offset))?.[0];
    if (number === undefined) return invalid();
    const decoded = Number(number);
    // Every numeric field in this closed wire is an integer. Check its exact decimal
    // value before JSON.parse: rounding a fraction/unsafe integer into a valid binding
    // is not representation normalization. Exponent spellings such as 1.0e0 are valid.
    if (!Number.isSafeInteger(decoded)) invalid();
    const unsigned = number.startsWith("-") ? number.slice(1) : number;
    const [mantissa = "", exponent = "0"] = unsigned.split(/[eE]/u);
    const fractionLength = mantissa.split(".")[1]?.length ?? 0;
    const digits = mantissa.replace(".", "").replace(/^0+/u, "");
    if (digits.length > 0) {
      const significant = digits.replace(/0+$/u, "");
      const shift = Number(exponent) - fractionLength + digits.length - significant.length;
      // A safe integer has at most 16 decimal digits; bound expansion before repeat.
      if (!Number.isSafeInteger(shift) || shift < 0 || significant.length + shift > 16) invalid();
      const exact = `${number.startsWith("-") ? "-" : ""}${significant}${"0".repeat(shift)}`;
      if (String(decoded) !== exact) invalid();
    }
    offset += number.length;
  };
  whitespace();
  const begin = offset;
  value(0);
  const parsed: unknown = JSON.parse(text.slice(begin, offset));
  return { value: parsed, end: offset };
}
