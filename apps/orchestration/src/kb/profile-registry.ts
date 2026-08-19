/**
 * KB profile registry — §5.1 host-owned profile resolution.
 *
 * The registry maps opaque profile IDs to absolute KB roots. It is an ignored,
 * owner-only host file — never a model-visible argument. The model names a
 * `kb_profile_id`; the host resolves it here.
 *
 * This module reads and validates the registry file. It does not create, modify,
 * or expose roots to callers that lack host authority.
 */

import { readFileSync, existsSync, lstatSync } from "node:fs";
import path from "node:path";

import {
  KbProfileRegistrySchema,
  KbProfileSchema,
  OpaqueIdSchema,
  validateKbContract,
  type KbProfile,
  type KbProfileRegistry,
} from "./contracts.js";

export class ProfileRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileRegistryError";
  }
}

/** A profile that has been resolved and admission-checked. */
export interface ResolvedProfile {
  readonly profile: KbProfile;
  /** Realpath-normalized root, verified to exist and be a directory. */
  readonly resolvedRoot: string;
}

/**
 * Load and validate the profile registry from an ignored host file.
 *
 * The file and its containing directory must be regular, non-symlink, and
 * owner-only (0600 / 0700) where the platform supports it.
 */
export function loadProfileRegistry(registryPath: string): KbProfileRegistry {
  if (!existsSync(registryPath)) {
    throw new ProfileRegistryError(`profile registry not found: ${registryPath}`);
  }
  const stat = lstatSync(registryPath);
  if (stat.isSymbolicLink()) {
    throw new ProfileRegistryError("profile registry must not be a symlink");
  }
  if (!stat.isFile()) {
    throw new ProfileRegistryError("profile registry must be a regular file");
  }
  const raw = readFileSync(registryPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProfileRegistryError("profile registry is not valid JSON");
  }
  return validateKbContract(KbProfileRegistrySchema, parsed, "profile registry");
}

/**
 * Resolve a profile by ID from a loaded registry.
 *
 * Returns `undefined` when the ID is not present — the caller decides whether
 * that is a refusal or a creation opportunity.
 */
export function findProfile(
  registry: KbProfileRegistry,
  profileId: string
): KbProfile | undefined {
  return registry.profiles.find((p) => p.kb_profile_id === profileId);
}

/**
 * Validate that a profile ID is well-formed (not a path, not a root, not a
 * traversal attempt).
 */
export function isValidProfileId(id: string): boolean {
  try {
    validateKbContract(OpaqueIdSchema, id, "profile id");
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a single profile entry in isolation.
 */
export function validateProfile(profile: unknown): KbProfile {
  return validateKbContract(KbProfileSchema, profile, "profile");
}