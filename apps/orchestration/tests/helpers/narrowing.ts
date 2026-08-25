import type { Directive } from "../../src/contracts.js";

type TerminalDirective = Extract<Directive, { result: Record<string, unknown> }>;
type DirectiveForAction<Action extends Directive["action"]> =
  Action extends TerminalDirective["action"]
    ? TerminalDirective
    : Extract<Directive, { action: Action }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  return value;
}

export function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Missing required value: ${label}`);
  }
  return value;
}

export function requireArrayItem<T>(values: readonly T[], index: number, label: string): T {
  return requireValue(values[index], `${label}[${index}]`);
}

export function requireRecordValue<T>(
  record: Readonly<Partial<Record<string, T>>>,
  key: string,
  label: string
): T {
  return requireValue(record[key], `${label}.${key}`);
}

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Expected ${label} to be a record`);
  }
  return value;
}

export function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an array`);
  }
  return value;
}

export function requireRecordArray(value: unknown, label: string): Record<string, unknown>[] {
  return requireArray(value, label).map((entry, index) =>
    requireRecord(entry, `${label}[${index}]`)
  );
}

export function requireStringArray(value: unknown, label: string): string[] {
  return requireArray(value, label).map((entry, index) =>
    requireString(entry, `${label}[${index}]`)
  );
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected ${label} to be a string`);
  }
  return value;
}

export function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number") {
    throw new Error(`Expected ${label} to be a number`);
  }
  return value;
}

export function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Expected ${label} to be a boolean`);
  }
  return value;
}

export function requireError(value: unknown, label: string): Error {
  if (!(value instanceof Error)) {
    throw new Error(`Expected ${label} to be an Error`);
  }
  return value;
}

export function errorCode(value: unknown): unknown {
  return isRecord(value) ? value["code"] : undefined;
}

export function requireSqlite(
  sqlite: typeof import("node:sqlite") | undefined,
  label = "node:sqlite"
): typeof import("node:sqlite") {
  return requireValue(sqlite, label);
}

export function requireDirectiveAction<Action extends Directive["action"]>(
  directive: Directive | undefined,
  action: Action,
  label: string
): DirectiveForAction<Action>;
export function requireDirectiveAction(
  directive: Directive | undefined,
  action: Directive["action"],
  label: string
): Directive {
  const present = requireValue(directive, label);
  if (present.action !== action) {
    throw new Error(`Expected ${label}.action to be ${action}; received ${present.action}`);
  }
  return present;
}
