export const PLATFORM_MEMORY_CONTRACT_VERSION = 1 as const;

export type PlatformMemoryMode = "none" | "isolated" | "shared-trust-domain";

export type PlatformMemoryCapability =
  | "recall-read"
  | "curated-write"
  | "kg-read"
  | "kg-write"
  | "primary-diary";

export type PlatformMemoryOperation =
  | "search"
  | "smart_search"
  | "get_drawer"
  | "list_drawers"
  | "get_taxonomy"
  | "check_duplicate"
  | "add_drawer"
  | "diary_read"
  | "diary_write"
  | "kg_query"
  | "kg_add"
  | "kg_invalidate"
  | "kg_supersede"
  | "kg_timeline"
  | "kg_stats";

export type PlatformMemoryErrorCode =
  | "MEMORY_DISABLED"
  | "MEMORY_OPERATION_FORBIDDEN"
  | "MEMORY_CONFIG_INVALID"
  | "MEMORY_INVALID_REQUEST"
  | "MEMORY_UNAVAILABLE"
  | "MEMORY_UNAUTHORIZED"
  | "MEMORY_TIMEOUT"
  | "MEMORY_CANCELLED"
  | "MEMORY_CONFLICT"
  | "MEMORY_INTEGRITY";

export class PlatformMemoryError extends Error {
  constructor(
    readonly code: PlatformMemoryErrorCode,
    message: string,
    readonly retryable = false,
    readonly requestId?: string
  ) {
    super(message);
    this.name = "PlatformMemoryError";
  }
}

export type MemoryCredentialReference =
  | { kind: "environment"; name: string }
  | { kind: "file"; path: string };

export interface PlatformMemoryTargetV1 {
  endpoint: string;
  palaceId: string;
  dataRootId: string;
}

export interface PlatformMemoryCustodyV1 {
  ownerId: string;
  backupPolicyRef: string;
  migrationPolicyRef: string;
  retentionPolicyRef: string;
  uninstallDisposition: "preserve";
}

export type PlatformMemoryTrustV1 =
  | { kind: "isolated"; isolationBoundaryId: string }
  | {
      kind: "shared-trust-domain";
      trustDomainId: string;
      wholePalaceAccessAcknowledged: true;
    };

export interface PlatformMemoryTransportV1 {
  requestTimeoutMs?: number;
  maxReadAttempts?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
}

export interface NoPlatformMemoryConfigV1 {
  contractVersion: 1;
  mode: "none";
  principalId: string;
}

interface EnabledPlatformMemoryConfigV1 {
  contractVersion: 1;
  principalId: string;
  target: PlatformMemoryTargetV1;
  credential: MemoryCredentialReference;
  custody: PlatformMemoryCustodyV1;
  capabilities: readonly PlatformMemoryCapability[];
  primaryDiaryId?: string;
  transport?: PlatformMemoryTransportV1;
}

export interface IsolatedPlatformMemoryConfigV1 extends EnabledPlatformMemoryConfigV1 {
  mode: "isolated";
  trust: { kind: "isolated"; isolationBoundaryId: string };
}

export interface SharedTrustDomainPlatformMemoryConfigV1 extends EnabledPlatformMemoryConfigV1 {
  mode: "shared-trust-domain";
  trust: {
    kind: "shared-trust-domain";
    trustDomainId: string;
    wholePalaceAccessAcknowledged: true;
  };
}

export type PlatformMemoryConfigV1 =
  | NoPlatformMemoryConfigV1
  | IsolatedPlatformMemoryConfigV1
  | SharedTrustDomainPlatformMemoryConfigV1;

export interface ResolvedPlatformMemoryTransportV1 {
  requestTimeoutMs: number;
  maxReadAttempts: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
}

export type ValidatedPlatformMemoryConfigV1 =
  | NoPlatformMemoryConfigV1
  | ((IsolatedPlatformMemoryConfigV1 | SharedTrustDomainPlatformMemoryConfigV1) & {
      transport: ResolvedPlatformMemoryTransportV1;
    });

export interface PlatformMemoryResultV1 {
  contractVersion: 1;
  operation: PlatformMemoryOperation;
  requestId: string;
  palaceId: string;
  data: Record<string, unknown>;
  attempts: number;
}

export type MemoryCredentialResolver = (
  reference: MemoryCredentialReference
) => string | Promise<string>;

export interface PlatformMemoryClientDependencies {
  fetch?: typeof fetch;
  randomId?: () => string;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  credentialResolver?: MemoryCredentialResolver;
  env?: Readonly<Record<string, string | undefined>>;
}
