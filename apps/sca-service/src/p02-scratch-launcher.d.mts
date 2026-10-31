import type { BigIntStatsFs } from "node:fs";
export const MIN_SCRATCH_BYTES: number;
export const MAX_SCRATCH_BYTES: number;
export function validateScratchBytes(value: unknown): number;
export function verifyNamespaceIdentity(
  status: string,
  uidMap: string,
  gidMap: string,
  uid: number,
  gid: number,
  pid: number,
  privileged: boolean
): void;
export function verifyPinnedFile(filename: string, digest: string): void;
export function verifyCurrentIdentity(privileged?: boolean): void;
export function scratchMountRecord(
  mountinfo: string,
  hardened?: boolean
): { id: string; device: string };
export function verifyScratchCapacity(
  limit: number,
  info: Pick<BigIntStatsFs, "type" | "bsize" | "blocks" | "bavail">
): number;
export function verifyBoundedScratch(limit: number): number;
