/** Fail immediately when a fixture value that an oracle depends on is absent. */
export function requireDefined<T>(
  value: T | null | undefined,
  message = "expected fixture value to be defined"
): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireRecord(
  value: unknown,
  message = "expected an object fixture"
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(message);
  return value;
}

export function requireString(value: unknown, message = "expected a string fixture"): string {
  if (typeof value !== "string") throw new Error(message);
  return value;
}

export function requireArray(value: unknown, message = "expected an array fixture"): unknown[] {
  if (!Array.isArray(value)) throw new Error(message);
  return value;
}

export function requireArrayElement<T>(
  values: readonly T[],
  index: number,
  message = `expected fixture element at index ${index}`
): T {
  return requireDefined(values[index], message);
}

export function parseJson(text: string): unknown {
  return JSON.parse(text);
}

export type UnknownFunction = (...args: unknown[]) => unknown;

export function isUnknownFunction(value: unknown): value is UnknownFunction {
  return typeof value === "function";
}

export function requireFunction(
  value: unknown,
  message = "expected a function fixture"
): UnknownFunction {
  if (!isUnknownFunction(value)) throw new Error(message);
  return value;
}
