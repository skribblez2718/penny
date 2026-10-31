import { Type, type Static } from "typebox";
import { validateSkillSchema } from "../skill-contracts/common.js";

const safe = Type.Integer({ minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER });
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const RationalTimeSchema = Type.Object(
  { numerator: safe, denominator: positive },
  { additionalProperties: false }
);
export const RationalRateSchema = Type.Object(
  { numerator: positive, denominator: positive },
  { additionalProperties: false }
);
export type RationalTime = Static<typeof RationalTimeSchema>;
export type RationalRate = Static<typeof RationalRateSchema>;
const I128_MIN = -(1n << 127n);
const I128_MAX = (1n << 127n) - 1n;
const I63_MIN = -(1n << 62n);
const I63_MAX = (1n << 62n) - 1n;
const JSON_MAX = BigInt(Number.MAX_SAFE_INTEGER);
function checked128(v: bigint): bigint {
  if (v < I128_MIN || v > I128_MAX) throw new Error("128-bit intermediate overflow");
  return v;
}
function checked63(v: bigint): bigint {
  if (v < I63_MIN || v > I63_MAX) throw new Error("63-bit result overflow");
  return v;
}
function abs(v: bigint): bigint {
  return v < 0n ? -v : v;
}
function gcd(a: bigint, b: bigint): bigint {
  a = abs(a);
  while (b !== 0n) {
    const r = a % b;
    a = b;
    b = r;
  }
  return a;
}
function jsonInteger(v: bigint): number {
  checked63(v);
  if (abs(v) > JSON_MAX) throw new Error("unsafe JSON integer");
  return Number(v);
}
function reduced(n: bigint, d: bigint): RationalTime {
  checked128(n);
  checked128(d);
  if (d <= 0n) throw new Error("positive denominator required");
  const common = gcd(n, d);
  return { numerator: jsonInteger(n / common), denominator: jsonInteger(d / common) };
}
export function rationalTime(numerator: bigint, denominator: bigint): RationalTime {
  return reduced(numerator, denominator);
}
export function validateRationalTime(value: unknown): RationalTime {
  const t = validateSkillSchema(RationalTimeSchema, value, "RationalTime seconds");
  if (gcd(BigInt(t.numerator), BigInt(t.denominator)) !== 1n)
    throw new Error("unreduced rational time");
  return t;
}
export function validateRationalRate(value: unknown): RationalRate {
  const r = validateSkillSchema(RationalRateSchema, value, "RationalRate per second");
  if (gcd(BigInt(r.numerator), BigInt(r.denominator)) !== 1n)
    throw new Error("unreduced rational rate");
  return r;
}
export function addTime(a: RationalTime, b: RationalTime): RationalTime {
  validateRationalTime(a);
  validateRationalTime(b);
  return reduced(
    checked128(
      checked128(BigInt(a.numerator) * BigInt(b.denominator)) +
        checked128(BigInt(b.numerator) * BigInt(a.denominator))
    ),
    checked128(BigInt(a.denominator) * BigInt(b.denominator))
  );
}
export function subtractTime(a: RationalTime, b: RationalTime): RationalTime {
  return addTime(a, { numerator: -b.numerator, denominator: b.denominator });
}
export function compareTime(a: RationalTime, b: RationalTime): -1 | 0 | 1 {
  validateRationalTime(a);
  validateRationalTime(b);
  const delta = checked128(
    checked128(BigInt(a.numerator) * BigInt(b.denominator)) -
      checked128(BigInt(b.numerator) * BigInt(a.denominator))
  );
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
}
export interface QuantizedBoundary {
  readonly index: number;
  readonly residual: RationalTime;
}
/** Absolute seconds × per-second rate; nearest, ties to even, symmetric for negative time. */
export function quantizeBoundary(
  time: RationalTime,
  rate: RationalRate,
  maxIndex: number
): QuantizedBoundary {
  validateRationalTime(time);
  validateRationalRate(rate);
  if (!Number.isSafeInteger(maxIndex) || maxIndex < 1) throw new Error("finite index cap required");
  const n = checked128(BigInt(time.numerator) * BigInt(rate.numerator));
  const d = checked128(BigInt(time.denominator) * BigInt(rate.denominator));
  let q = abs(n) / d;
  const twice = checked128((abs(n) % d) * 2n);
  if (twice > d || (twice === d && q % 2n !== 0n)) q += 1n;
  if (n < 0n) q = -q;
  checked63(q);
  if (abs(q) > BigInt(maxIndex)) throw new Error("frame/sample project cap");
  const index = jsonInteger(q);
  const chosen = reduced(checked128(q * BigInt(rate.denominator)), BigInt(rate.numerator));
  return { index, residual: subtractTime(time, chosen) };
}
/** Measured PTS ticks, not edit duration or a reinterpretation at the output frame rate. */
export function measuredDuration(ticks: number, timebase: RationalTime): RationalTime {
  validateRationalTime(timebase);
  if (!Number.isSafeInteger(ticks) || ticks <= 0 || timebase.numerator <= 0)
    throw new Error("invalid decoded duration/timebase");
  return reduced(
    checked128(BigInt(ticks) * BigInt(timebase.numerator)),
    BigInt(timebase.denominator)
  );
}
