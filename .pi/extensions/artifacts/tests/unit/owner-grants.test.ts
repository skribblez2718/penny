import { rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  artifactRefFromEnvelope,
  canonicalArtifactId,
  executeArtifactRead,
  loadArtifactRuntimeConfig,
} from "../../artifact-runtime.js";
import {
  MAX_OWNER_GRANTS,
  OWNER_CONSUMER_REF,
  ownerGrantBookPath,
  readOwnerGrantBook,
  registerOwnerArtifactGrants,
  resolveOwnerInvocation,
  withOwnerConsumer,
} from "../../owner-grants.js";
import type { ArtifactInvocation } from "../../types.js";
import {
  createArtifactFixture,
  createCanonicalRef,
  FIXED_NOW,
  parseToolPayload,
} from "../fixtures.js";

const SESSION = "01a01237-5d4b-7af6-8f5f-647d1d4245e2";
const OTHER_SESSION = "01a01111-0000-7000-8000-000000000000";

/**
 * Grants live in their own state root, never inside the artifact root: both
 * artifact stores refuse to claim a root containing unmanaged entries. Tests
 * pin it to a temp directory so they never touch real state.
 */
function testEnv(root: string): Record<string, string> {
  return {
    PENNY_ARTIFACT_ROOT: root,
    PENNY_ARTIFACT_GRANT_ROOT: join(root, "..", `grants-${basename(root)}`),
  };
}

/** The primary runtime as configured in practice: no invocation source in env. */
function primaryConfig(root: string) {
  return loadArtifactRuntimeConfig({ PENNY_ARTIFACT_ROOT: root });
}

function ownerResolver(root: string, sessionId: string) {
  return async (artifactId: string): Promise<ArtifactInvocation | undefined> =>
    resolveOwnerInvocation(
      readOwnerGrantBook(ownerGrantBookPath(sessionId, testEnv(root))),
      artifactId
    );
}

const grantRoots = new Set<string>();

afterAll(() => {
  for (const root of grantRoots) rmSync(root, { recursive: true, force: true });
});

/** Register the isolated grant root for cleanup and return the pinned env. */
function isolatedEnv(root: string): Record<string, string> {
  const env = testEnv(root);
  grantRoots.add(env.PENNY_ARTIFACT_GRANT_ROOT);
  return env;
}

describe("owner grant book", () => {
  it("authorizes the owner without altering artifact identity or content binding", () => {
    const ref = createCanonicalRef({
      run_id: "run:owner",
      phase: "researching",
      kind: "agent-output",
      operation_id: "op-1",
      version: 1,
      consumer_scope: ["state:synthesizing"],
    });
    const granted = withOwnerConsumer(ref);

    // consumer_scope is validated as canonically sorted, so the owner entry is merged in order.
    expect(granted.consumer_scope).toEqual([OWNER_CONSUMER_REF, "state:synthesizing"]);
    // Identity is hashed from (run_id, phase, branch_id, kind, operation_id, version) only.
    expect(granted.artifact_id).toBe(ref.artifact_id);
    expect(granted.artifact_id).toBe(canonicalArtifactId(ref));
    expect(granted.content_digest).toBe(ref.content_digest);
    expect(granted.byte_length).toBe(ref.byte_length);
    expect(granted.store_ref).toBe(ref.store_ref);
  });

  it("is idempotent and never duplicates the owner consumer", () => {
    const ref = createCanonicalRef({
      run_id: "run:owner",
      phase: "planning",
      kind: "agent-output",
      operation_id: "op-2",
      version: 1,
      consumer_scope: ["state:critiquing_plan"],
    });
    expect(withOwnerConsumer(withOwnerConsumer(ref)).consumer_scope).toEqual([
      OWNER_CONSUMER_REF,
      "state:critiquing_plan",
    ]);
  });

  it("lets the primary runtime read an artifact the owner granted it", async () => {
    const fixture = await createArtifactFixture("exact agent output bytes", {
      artifactRunId: "run:delegation",
      consumerScope: ["subagent-chain:caller"],
    });
    try {
      const env = isolatedEnv(fixture.root);
      registerOwnerArtifactGrants({
        sessionId: SESSION,
        refs: [artifactRefFromEnvelope(fixture.artifact)],
        env,
        now: FIXED_NOW,
      });

      const execution = await executeArtifactRead(
        primaryConfig(fixture.root),
        { artifact: fixture.artifact.artifact_id },
        { now: () => FIXED_NOW, invocationResolver: ownerResolver(fixture.root, SESSION) }
      );

      expect(execution.code).toBe("OK");
      const payload = parseToolPayload(execution.result);
      expect(payload.ok).toBe(true);
      expect(payload.type).toBe("artifact_read");
      expect(payload.content).toBe("exact agent output bytes");
      expect(payload.truncated).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("refuses an artifact the owner never granted", async () => {
    const fixture = await createArtifactFixture("ungranted bytes");
    try {
      const execution = await executeArtifactRead(
        primaryConfig(fixture.root),
        { artifact: fixture.artifact.artifact_id },
        { now: () => FIXED_NOW, invocationResolver: ownerResolver(fixture.root, SESSION) }
      );
      expect(execution.code).toBe("ARTIFACT_NOT_GRANTED");
    } finally {
      await fixture.cleanup();
    }
  });

  it("isolates grants across sessions", async () => {
    const fixture = await createArtifactFixture("session scoped bytes");
    try {
      const env = isolatedEnv(fixture.root);
      registerOwnerArtifactGrants({
        sessionId: SESSION,
        refs: [artifactRefFromEnvelope(fixture.artifact)],
        env,
        now: FIXED_NOW,
      });

      const execution = await executeArtifactRead(
        primaryConfig(fixture.root),
        { artifact: fixture.artifact.artifact_id },
        { now: () => FIXED_NOW, invocationResolver: ownerResolver(fixture.root, OTHER_SESSION) }
      );
      expect(execution.code).toBe("ARTIFACT_NOT_GRANTED");
    } finally {
      await fixture.cleanup();
    }
  });

  it("expires owner grants and refuses stale reads", async () => {
    const fixture = await createArtifactFixture("expiring bytes");
    try {
      const env = isolatedEnv(fixture.root);
      registerOwnerArtifactGrants({
        sessionId: SESSION,
        refs: [artifactRefFromEnvelope(fixture.artifact)],
        env,
        now: FIXED_NOW,
        ttlMs: 60_000,
      });

      const execution = await executeArtifactRead(
        primaryConfig(fixture.root),
        { artifact: fixture.artifact.artifact_id },
        {
          now: () => FIXED_NOW + 120_000,
          invocationResolver: ownerResolver(fixture.root, SESSION),
        }
      );
      expect(execution.code).toBe("ARTIFACT_STALE");
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps the book and its directory owner-only", async () => {
    const fixture = await createArtifactFixture("permission bytes");
    try {
      const env = isolatedEnv(fixture.root);
      registerOwnerArtifactGrants({
        sessionId: SESSION,
        refs: [artifactRefFromEnvelope(fixture.artifact)],
        env,
        now: FIXED_NOW,
      });
      const bookPath = ownerGrantBookPath(SESSION, env);
      expect(statSync(bookPath).mode & 0o077).toBe(0);
      expect(statSync(bookPath.replace(/\/[^/]+$/, "")).mode & 0o077).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("merges repeated registrations, drops expired entries, and stays bounded", async () => {
    const fixture = await createArtifactFixture("bound bytes");
    try {
      const env = isolatedEnv(fixture.root);
      const makeRefs = (count: number, offset: number) =>
        Array.from({ length: count }, (_unused, index) =>
          createCanonicalRef({
            run_id: "run:bulk",
            phase: "researching",
            kind: "agent-output",
            operation_id: `op-${offset + index}`,
            version: 1,
          })
        );

      registerOwnerArtifactGrants({
        sessionId: SESSION,
        refs: makeRefs(10, 0),
        env,
        now: FIXED_NOW,
        ttlMs: 60_000,
      });
      // Later registration: the first batch is expired by now and must be dropped.
      registerOwnerArtifactGrants({
        sessionId: SESSION,
        refs: makeRefs(MAX_OWNER_GRANTS + 25, 1_000),
        env,
        now: FIXED_NOW + 120_000,
      });

      const book = readOwnerGrantBook(ownerGrantBookPath(SESSION, env));
      expect(book?.grants.length).toBe(MAX_OWNER_GRANTS);
      expect(book?.grants.some((entry) => entry.artifact.operation_id === "op-0")).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not let an owner grant satisfy a different consumer's scope check", async () => {
    const fixture = await createArtifactFixture("scope bytes", {
      consumerScope: ["state:synthesizing"],
    });
    try {
      const env = isolatedEnv(fixture.root);
      registerOwnerArtifactGrants({
        sessionId: SESSION,
        refs: [artifactRefFromEnvelope(fixture.artifact)],
        env,
        now: FIXED_NOW,
      });
      const book = readOwnerGrantBook(ownerGrantBookPath(SESSION, env));
      const invocation = resolveOwnerInvocation(book, fixture.artifact.artifact_id);
      expect(invocation?.caller.consumer_ref).toBe(OWNER_CONSUMER_REF);
      expect(OWNER_CONSUMER_REF.startsWith("state:")).toBe(false);
      expect(OWNER_CONSUMER_REF.startsWith("subagent-chain:")).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a tampered ref supplied by the model", async () => {
    const fixture = await createArtifactFixture("tamper bytes");
    try {
      const env = isolatedEnv(fixture.root);
      const [granted] = registerOwnerArtifactGrants({
        sessionId: SESSION,
        refs: [artifactRefFromEnvelope(fixture.artifact)],
        env,
        now: FIXED_NOW,
      });

      const execution = await executeArtifactRead(
        primaryConfig(fixture.root),
        { artifact: { ...granted, producer: "agent:impostor" } },
        { now: () => FIXED_NOW, invocationResolver: ownerResolver(fixture.root, SESSION) }
      );
      expect(execution.code).toBe("ARTIFACT_STALE");
    } finally {
      await fixture.cleanup();
    }
  });

  it("accepts the exact granted ref the owner surfaces", async () => {
    const fixture = await createArtifactFixture("surfaced ref bytes");
    try {
      const env = isolatedEnv(fixture.root);
      const [granted] = registerOwnerArtifactGrants({
        sessionId: SESSION,
        refs: [artifactRefFromEnvelope(fixture.artifact)],
        env,
        now: FIXED_NOW,
      });

      const execution = await executeArtifactRead(
        primaryConfig(fixture.root),
        { artifact: granted },
        { now: () => FIXED_NOW, invocationResolver: ownerResolver(fixture.root, SESSION) }
      );
      expect(execution.code).toBe("OK");
    } finally {
      await fixture.cleanup();
    }
  });
});
