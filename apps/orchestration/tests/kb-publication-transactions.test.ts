import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Checkpointer } from "../src/checkpointer.js";
import { RunContext } from "../src/context.js";
import { CapabilityStore, mintEnvelope } from "../src/kb/capabilities.js";
import {
  canonicalJson,
  defaultDenyPolicy,
  sha256Hex,
  type KbManifest,
} from "../src/kb/contracts.js";
import {
  currentPath,
  pageClaimsPath,
  pageMarkdownPath,
  readCurrent,
  readManifest,
  readPolicy,
} from "../src/kb/filesystem.js";
import {
  buildCatalog,
  generationIndexDigest,
  publishGenerationTransaction,
  readSelectedGeneration,
  type PublishGenerationTransactionInput,
} from "../src/kb/generations.js";
import { initKb } from "../src/kb/workflows.js";

const roots: string[] = [];
const NOW = "2026-08-21T00:00:00Z";
const PROFILE = "kbp_publication";

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "penny-kb-publication-"));
  chmodSync(root, 0o700);
  mkdirSync(path.join(root, ".control"), { mode: 0o700 });
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function manifest(kbId: string): KbManifest {
  return {
    schema_version: 1,
    kb_id: kbId,
    title: "Publication fixture",
    authority: "advisory",
    paths: {
      policy: ".kb/policy.json",
      source_records: "sources/records",
      source_objects: "sources/objects",
      pages: "pages",
      conflicts: "conflicts",
      work: "work",
      lock: ".kb/lock",
      generations: ".kb/generations",
      generation_catalog_filename: "catalog.json",
      generation_index_filename: "index.sqlite",
      current: ".kb/current.json",
      root_index: "index.md",
    },
    created_at: NOW,
  };
}

function createRun(checkpointer: Checkpointer, runId: string, action: "init" | "save"): void {
  const context = RunContext.create({
    identity: {
      schema_version: 2,
      run_id: runId,
      session_id: "session_publication",
      playbook: "knowledge-base",
      engine_owner: "typescript",
    },
    goal: "Synthetic publication transaction.",
    constraints: { action, kb_profile_id: PROFILE },
    projectRoot: path.dirname(checkpointer.dbPath),
    trustProfile: "hardened-untrusted",
    maxSteps: 10,
  });
  checkpointer.createRun(context, "publication_test_started", {});
}

function initInput(input: {
  root: string;
  checkpointer: Checkpointer;
  runId?: string;
  transactionId?: string;
  fault?: (boundary: string) => void;
  authority?: PublishGenerationTransactionInput["authority"];
  profileCommitmentSha256?: string;
}): PublishGenerationTransactionInput {
  const runId = input.runId ?? "run_publication_init";
  const transactionId = input.transactionId ?? "tx_publication_init";
  const kbId = "kb_publication";
  const generationId = `gen_${sha256Hex(transactionId).slice(0, 40)}`;
  const kbManifest = manifest(kbId);
  const policy = defaultDenyPolicy(kbId);
  const indexSha = generationIndexDigest(generationId, kbId, []);
  const catalog = buildCatalog({
    generation_id: generationId,
    kb_id: kbId,
    manifest: kbManifest,
    policy,
    pages: [],
    source_records: [],
    source_objects: [],
    conflicts: [],
    index_sha256: indexSha,
    created_at: NOW,
  });
  return {
    root: input.root,
    checkpointer: input.checkpointer,
    run_id: runId,
    transaction_id: transactionId,
    kb_profile_id: PROFILE,
    action: "init",
    base_generation_id: null,
    base_selector_sha256: null,
    catalog,
    index_pages: [],
    immutable_files: [
      { role: "manifest", final_key: "manifest.json", bytes: canonicalJson(kbManifest) },
      { role: "policy", final_key: ".kb/policy.json", bytes: canonicalJson(policy) },
    ],
    published_at: NOW,
    init_reservation: {
      request_sha256: sha256Hex("init request"),
      profile_commitment_sha256:
        (input.profileCommitmentSha256 as ReturnType<typeof sha256Hex> | undefined) ??
        sha256Hex(canonicalJson({ profile_id: PROFILE, root: path.resolve(input.root) })),
    },
    ...(input.fault !== undefined ? { fault: input.fault } : {}),
    ...(input.authority !== undefined ? { authority: input.authority } : {}),
  };
}

function publicationSourceAuthority(input: {
  projectRoot: string;
  runId: string;
  admissionTransactionId: string;
}): {
  capabilityId: string;
  sourceId: string;
  authority: NonNullable<PublishGenerationTransactionInput["authority"]>;
} {
  const envelope = mintEnvelope({
    kind: "source_read",
    session_id: "session_publication",
    kb_profile_id: PROFILE,
    resolved_path: path.join(input.projectRoot, "synthetic-source.md"),
    expected_sha256: "0".repeat(64),
    allowed_operation: "ingest",
    issued_at: "2026-08-20T00:00:00Z",
    expires_at: "2027-08-20T00:00:00Z",
    media_type: "text/markdown",
    source_metadata: {
      source_type: "file",
      captured_at: "2026-08-20T00:00:00Z",
      title: "Synthetic publication source",
      authors: ["Synthetic Fixture"],
    },
  });
  using capabilities = new CapabilityStore(input.projectRoot);
  capabilities.register(envelope);
  capabilities.claimAll([envelope], {
    runId: input.runId,
    transactionId: input.admissionTransactionId,
    sessionId: "session_publication",
    profileId: PROFILE,
    kind: "source_read",
    operation: "ingest",
    now: NOW,
  });
  const [admission] = capabilities.prepareSourceAdmissions({
    envelopes: [envelope],
    runId: input.runId,
    transactionId: input.admissionTransactionId,
    now: NOW,
  });
  capabilities.admitSource(admission!.source_id, 0, NOW);
  return {
    capabilityId: envelope.capability_id,
    sourceId: admission!.source_id,
    authority: {
      reserve(transactionId: string) {
        using store = new CapabilityStore(input.projectRoot);
        store.reserveSourceCommitAll([envelope.capability_id], input.runId, transactionId, NOW);
      },
      finalize(transactionId: string) {
        using store = new CapabilityStore(input.projectRoot);
        store.settlePublishedSources({
          capabilityIds: [envelope.capability_id],
          sourceIds: [admission!.source_id],
          runId: input.runId,
          transactionId,
          now: NOW,
        });
      },
    },
  };
}

function normalInput(input: {
  root: string;
  checkpointer: Checkpointer;
  runId: string;
  transactionId: string;
  finalPageKey?: string;
  pageBytes?: string;
  fault?: (boundary: string) => void;
  authority?: PublishGenerationTransactionInput["authority"];
}): PublishGenerationTransactionInput {
  const selected = readSelectedGeneration(input.root)!;
  const kbManifest = readManifest(input.root);
  const policy = readPolicy(input.root);
  const generationId = `gen_${sha256Hex(input.transactionId).slice(0, 40)}`;
  const defaultPageId = `page_${sha256Hex(input.transactionId).slice(0, 12)}`;
  const defaultRevisionId = `rev_${sha256Hex(input.transactionId).slice(12, 24)}`;
  const parsedKey = input.finalPageKey?.match(/^pages\/([^/]+)\/revisions\/([^/]+)\/page\.md$/u);
  const pageId = parsedKey?.[1] ?? defaultPageId;
  const revisionId = parsedKey?.[2] ?? defaultRevisionId;
  const finalPageKey =
    input.finalPageKey ??
    path
      .relative(input.root, pageMarkdownPath(input.root, pageId, revisionId))
      .split(path.sep)
      .join("/");
  const finalClaimsKey = path
    .relative(input.root, pageClaimsPath(input.root, pageId, revisionId))
    .split(path.sep)
    .join("/");
  const body = input.pageBytes ?? "## Synthesis\n\nCandidate publication body.\n";
  const frontmatter = {
    schema_version: 1 as const,
    page_id: pageId,
    revision_id: revisionId,
    kind: "synthesis" as const,
    title: `Candidate ${pageId}`,
    summary: "Synthetic publication transaction page.",
    authority: "advisory" as const,
    lifecycle: "validated" as const,
    created_at: NOW,
    derived_from: [],
    related_page_ids: [],
  };
  const claims = {
    schema_version: 1 as const,
    page_id: pageId,
    revision_id: revisionId,
    claims: [],
  };
  const pageContent = `---\n${canonicalJson(frontmatter)}\n---\n\n${body}`;
  const claimsContent = canonicalJson(claims);
  const indexPages = [
    {
      page_id: pageId,
      revision_id: revisionId,
      title: frontmatter.title,
      summary: frontmatter.summary,
      body_sha256: sha256Hex(body),
      body,
    },
  ];
  const indexSha = generationIndexDigest(generationId, selected.catalog.kb_id, indexPages);
  const catalog = buildCatalog({
    generation_id: generationId,
    parent_generation_id: selected.selector.generation_id,
    kb_id: selected.catalog.kb_id,
    manifest: kbManifest,
    policy,
    pages: [
      ...Object.entries(selected.catalog.pages).map(([page_id, entry]) => ({ page_id, ...entry })),
      {
        page_id: pageId,
        revision_id: revisionId,
        page_sha256: sha256Hex(pageContent),
        claims_sha256: sha256Hex(claimsContent),
      },
    ],
    source_records: Object.entries(selected.catalog.source_records).map(
      ([source_id, record_sha256]) => ({ source_id, record_sha256 })
    ),
    source_objects: selected.catalog.source_objects,
    conflicts: Object.entries(selected.catalog.conflict_records).map(
      ([conflict_id, conflict_sha256]) => ({ conflict_id, conflict_sha256 })
    ),
    index_sha256: indexSha,
    created_at: NOW,
  });
  return {
    root: input.root,
    checkpointer: input.checkpointer,
    run_id: input.runId,
    transaction_id: input.transactionId,
    kb_profile_id: PROFILE,
    action: "save",
    base_generation_id: selected.selector.generation_id,
    base_selector_sha256: sha256Hex(canonicalJson(selected.selector)),
    catalog,
    index_pages: indexPages,
    immutable_files: [
      { role: "page_markdown", final_key: finalPageKey, bytes: pageContent },
      { role: "claims", final_key: finalClaimsKey, bytes: claimsContent },
    ],
    published_at: NOW,
    ...(input.fault !== undefined ? { fault: input.fault } : {}),
    ...(input.authority !== undefined ? { authority: input.authority } : {}),
  };
}

describe("§5.10 transaction-owned publication", () => {
  it("preindexes the complete file plan before publication-file I/O", () => {
    const root = temporaryRoot();
    const checkpointer = new Checkpointer(path.join(root, ".control", "control.db"));
    createRun(checkpointer, "run_publication_init", "init");

    expect(() =>
      publishGenerationTransaction(
        initInput({
          root,
          checkpointer,
          fault(boundary) {
            if (boundary === "after_publication_preindexed") throw new Error("crash");
          },
        })
      )
    ).toThrow("crash");

    const planned = checkpointer.kbPublication("tx_publication_init")!;
    expect(planned.lifecycle).toBe("planned");
    expect(planned.files.map((file) => file.role).sort()).toEqual([
      "catalog",
      "index",
      "manifest",
      "policy",
      "selector",
    ]);
    expect(planned.files.every((file) => file.state === "planned")).toBe(true);
    expect(checkpointer.kbInitReservation(PROFILE)).toMatchObject({
      transaction_id: "tx_publication_init",
      kb_id: "kb_publication",
      generation_id: planned.candidate_generation_id,
      state: "reserved",
    });
    expect(existsSync(path.join(root, "manifest.json"))).toBe(false);
    expect(existsSync(currentPath(root))).toBe(false);

    publishGenerationTransaction(initInput({ root, checkpointer }));
    expect(checkpointer.kbPublication("tx_publication_init")?.lifecycle).toBe("complete");
    expect(readSelectedGeneration(root)?.selector.generation_id).toBe(
      planned.candidate_generation_id
    );
    checkpointer.close();
  });

  for (const boundary of [
    "after_writer_lock",
    "after_file_write",
    "after_file_fsync",
    "after_file_indexed",
    "before_index_write",
    "after_index_fsync",
    "before_immutable_link",
    "after_immutable_link",
    "after_immutable_fsync",
    "before_generation_rename",
    "after_generation_rename",
    "after_generation_fsync",
    "before_authority_reservation",
    "after_authority_reservation",
    "before_selector_commit",
    "after_selector_commit",
    "after_selector_fsync",
    "after_selector_record_commit",
    "before_authority_finalization",
    "after_authority_finalization",
    "before_root_index",
    "after_root_index",
  ]) {
    it(`recovers the identical transaction after ${boundary}`, () => {
      const root = temporaryRoot();
      const checkpointer = new Checkpointer(path.join(root, ".control", "control.db"));
      createRun(checkpointer, "run_publication_init", "init");
      let injected = false;
      const reserved = new Set<string>();
      const finalized = new Set<string>();
      const authority = {
        reserve(transactionId: string) {
          reserved.add(transactionId);
        },
        finalize(transactionId: string) {
          finalized.add(transactionId);
        },
      };
      expect(() =>
        publishGenerationTransaction(
          initInput({
            root,
            checkpointer,
            authority,
            fault(candidate) {
              if (!injected && candidate === boundary) {
                injected = true;
                throw new Error(`crash:${boundary}`);
              }
            },
          })
        )
      ).toThrow(`crash:${boundary}`);
      expect(injected).toBe(true);

      publishGenerationTransaction(initInput({ root, checkpointer, authority }));
      const publication = checkpointer.kbPublication("tx_publication_init")!;
      expect(publication.lifecycle).toBe("complete");
      expect(publication.files.every((file) => file.state === "published")).toBe(true);
      expect(readCurrent(root)?.generation_id).toBe(publication.candidate_generation_id);
      expect(readFileSync(path.join(root, "index.md"), "utf8")).toContain(
        publication.candidate_generation_id
      );
      expect(reserved).toEqual(new Set(["tx_publication_init"]));
      expect(finalized).toEqual(new Set(["tx_publication_init"]));
      expect(checkpointer.kbInitReservation(PROFILE)).toMatchObject({
        transaction_id: "tx_publication_init",
        kb_id: "kb_publication",
        generation_id: publication.candidate_generation_id,
        state: "finalized",
      });
      checkpointer.close();
    });
  }

  for (const [label, boundary] of [
    ["before source authority finalization", "before_authority_finalization"],
    ["after source authority finalization", "after_authority_finalization"],
  ] as const) {
    it(`recovers ${label} with distinct admission/publication transaction bindings`, () => {
      const root = temporaryRoot();
      initKb({ kbRoot: root, profileId: PROFILE, runId: "legacy_init" }, "Base");
      const checkpointer = new Checkpointer(path.join(root, ".control", `${boundary}.db`));
      const runId = `run_${boundary}`;
      const publicationTransactionId = `tx_publication_${boundary}`;
      const admissionTransactionId = `tx_admission_${boundary}`;
      createRun(checkpointer, runId, "save");
      const source = publicationSourceAuthority({
        projectRoot: root,
        runId,
        admissionTransactionId,
      });
      let crashed = false;
      const publication = normalInput({
        root,
        checkpointer,
        runId,
        transactionId: publicationTransactionId,
        authority: source.authority,
      });
      expect(() =>
        publishGenerationTransaction({
          ...publication,
          fault(candidate) {
            if (!crashed && candidate === boundary) {
              crashed = true;
              throw new Error(`source-finalization-crash:${boundary}`);
            }
          },
        })
      ).toThrow(`source-finalization-crash:${boundary}`);
      expect(crashed).toBe(true);
      const crashedCapabilities = new CapabilityStore(root);
      expect(crashedCapabilities.lease(source.capabilityId)?.state).toBe(
        boundary === "before_authority_finalization" ? "commit_reserved" : "consumed"
      );
      expect(crashedCapabilities.admission(source.sourceId)?.state).toBe(
        boundary === "before_authority_finalization" ? "admitted" : "published"
      );
      crashedCapabilities.close();

      publishGenerationTransaction(publication);
      using capabilities = new CapabilityStore(root);
      expect(capabilities.lease(source.capabilityId)).toMatchObject({
        state: "consumed",
        transaction_id: publicationTransactionId,
      });
      expect(capabilities.admission(source.sourceId)).toMatchObject({
        state: "published",
        transaction_id: admissionTransactionId,
      });
      expect(checkpointer.kbPublication(publicationTransactionId)?.lifecycle).toBe("complete");
      checkpointer.close();
    });
  }

  it("lets a competing writer commit, then refuses the crashed writer without overwrite", () => {
    const root = temporaryRoot();
    initKb({ kbRoot: root, profileId: PROFILE, runId: "legacy_init" }, "Base");
    const checkpointer = new Checkpointer(path.join(root, ".control", "control.db"));
    createRun(checkpointer, "run_writer_a", "save");
    createRun(checkpointer, "run_writer_b", "save");
    let crashed = false;
    const writerAInput = normalInput({
      root,
      checkpointer,
      runId: "run_writer_a",
      transactionId: "tx_writer_a",
    });
    expect(() =>
      publishGenerationTransaction({
        ...writerAInput,
        fault(boundary) {
          if (!crashed && boundary === "after_generation_fsync") {
            crashed = true;
            throw new Error("writer-a-crash");
          }
        },
      })
    ).toThrow("writer-a-crash");

    const writerB = publishGenerationTransaction(
      normalInput({
        root,
        checkpointer,
        runId: "run_writer_b",
        transactionId: "tx_writer_b",
      })
    );
    expect(readCurrent(root)?.generation_id).toBe(writerB.candidate_generation_id);

    expect(() => publishGenerationTransaction(writerAInput)).toThrow(
      /silent rebase|reviewed selector/
    );
    expect(readCurrent(root)?.generation_id).toBe(writerB.candidate_generation_id);
    expect(checkpointer.kbPublication("tx_writer_a")?.lifecycle).toBe("discarded");
    checkpointer.close();
  });

  it("classifies selector drift under the writer lock and never rebases it", () => {
    const root = temporaryRoot();
    initKb({ kbRoot: root, profileId: PROFILE, runId: "legacy_init" }, "Base");
    const checkpointer = new Checkpointer(path.join(root, ".control", "control.db"));
    createRun(checkpointer, "run_selector_drift", "save");
    const input = normalInput({
      root,
      checkpointer,
      runId: "run_selector_drift",
      transactionId: "tx_selector_drift",
    });
    let foreignBytes = "";
    expect(() =>
      publishGenerationTransaction({
        ...input,
        fault(boundary) {
          if (boundary !== "after_writer_lock") return;
          const foreign = {
            ...readCurrent(root)!,
            generation_id: "gen_foreign_selector",
          };
          foreignBytes = canonicalJson(foreign);
          writeFileSync(currentPath(root), foreignBytes, { mode: 0o600 });
        },
      })
    ).toThrow(/reviewed selector/);
    expect(readFileSync(currentPath(root), "utf8")).toBe(foreignBytes);
    expect(checkpointer.kbPublication("tx_selector_drift")?.lifecycle).toBe("discarded");
    checkpointer.close();
  });

  it("never overwrites an existing immutable final with different bytes", () => {
    const root = temporaryRoot();
    initKb({ kbRoot: root, profileId: PROFILE, runId: "legacy_init" }, "Base");
    const checkpointer = new Checkpointer(path.join(root, ".control", "control.db"));
    createRun(checkpointer, "run_no_overwrite", "save");
    const final = pageMarkdownPath(root, "page_existing", "rev_existing");
    mkdirSync(path.dirname(final), { recursive: true, mode: 0o700 });
    writeFileSync(final, "foreign immutable bytes", { mode: 0o600 });

    expect(() =>
      publishGenerationTransaction(
        normalInput({
          root,
          checkpointer,
          runId: "run_no_overwrite",
          transactionId: "tx_no_overwrite",
          finalPageKey: path.relative(root, final).split(path.sep).join("/"),
          pageBytes: "candidate replacement bytes",
        })
      )
    ).toThrow(/durable row/);
    expect(readFileSync(final, "utf8")).toBe("foreign immutable bytes");
    checkpointer.close();
  });

  it("rejects a malformed catalog key before any publication byte", () => {
    const root = temporaryRoot();
    initKb({ kbRoot: root, profileId: PROFILE, runId: "legacy_init" }, "Base");
    const checkpointer = new Checkpointer(path.join(root, ".control", "control.db"));
    createRun(checkpointer, "run_malformed_catalog", "save");
    const input = normalInput({
      root,
      checkpointer,
      runId: "run_malformed_catalog",
      transactionId: "tx_malformed_catalog",
    });
    const entry = Object.values(input.catalog.pages)[0]!;
    expect(() =>
      publishGenerationTransaction({
        ...input,
        catalog: { ...input.catalog, pages: { "../escaped": entry } },
      })
    ).toThrow(/schema validation/);
    expect(checkpointer.kbPublication("tx_malformed_catalog")).toBeUndefined();
    checkpointer.close();
  });

  it("rejects a mutation whose catalog and host allocation plan are empty", () => {
    const root = temporaryRoot();
    initKb({ kbRoot: root, profileId: PROFILE, runId: "legacy_init" }, "Base");
    const checkpointer = new Checkpointer(path.join(root, ".control", "control.db"));
    createRun(checkpointer, "run_empty_plan", "save");
    const selected = readSelectedGeneration(root)!;
    const kbManifest = readManifest(root);
    const policy = readPolicy(root);
    const generationId = "gen_empty_plan";
    const catalog = buildCatalog({
      generation_id: generationId,
      parent_generation_id: selected.selector.generation_id,
      kb_id: selected.catalog.kb_id,
      manifest: kbManifest,
      policy,
      pages: [],
      source_records: [],
      source_objects: [],
      conflicts: [],
      index_sha256: generationIndexDigest(generationId, selected.catalog.kb_id, []),
      created_at: NOW,
    });
    expect(() =>
      publishGenerationTransaction({
        root,
        checkpointer,
        run_id: "run_empty_plan",
        transaction_id: "tx_empty_plan",
        kb_profile_id: PROFILE,
        action: "save",
        base_generation_id: selected.selector.generation_id,
        base_selector_sha256: sha256Hex(canonicalJson(selected.selector)),
        catalog,
        index_pages: [],
        immutable_files: [],
        published_at: NOW,
      })
    ).toThrow(/empty approved page plan/);
    expect(checkpointer.kbPublication("tx_empty_plan")).toBeUndefined();
    checkpointer.close();
  });

  it("rejects absent, extra, and mismatched catalog allocation rows", () => {
    const root = temporaryRoot();
    initKb({ kbRoot: root, profileId: PROFILE, runId: "legacy_init" }, "Base");
    for (const [label, mutate] of [
      [
        "absent",
        (files: PublishGenerationTransactionInput["immutable_files"]) => files.slice(0, 1),
      ],
      [
        "extra",
        (files: PublishGenerationTransactionInput["immutable_files"]) => [
          ...files,
          { role: "conflict" as const, final_key: "conflicts/cfl_extra.json", bytes: "{}" },
        ],
      ],
      [
        "mismatched",
        (files: PublishGenerationTransactionInput["immutable_files"]) =>
          files.map((file, index) =>
            index === 0 ? { ...file, final_key: `${file.final_key}.wrong` } : file
          ),
      ],
    ] as const) {
      const checkpointer = new Checkpointer(path.join(root, ".control", `${label}.db`));
      const runId = `run_${label}_plan`;
      const transactionId = `tx_${label}_plan`;
      createRun(checkpointer, runId, "save");
      const input = normalInput({ root, checkpointer, runId, transactionId });
      expect(() =>
        publishGenerationTransaction({ ...input, immutable_files: mutate(input.immutable_files) })
      ).toThrow(/cardinality|all-and-only|absent or mapped/);
      expect(checkpointer.kbPublication(transactionId)).toBeUndefined();
      checkpointer.close();
    }
  });

  it("reopens and rehashes mapped files immediately before selector commit", () => {
    const root = temporaryRoot();
    initKb({ kbRoot: root, profileId: PROFILE, runId: "legacy_init" }, "Base");
    const base = readCurrent(root)!;
    const checkpointer = new Checkpointer(path.join(root, ".control", "control.db"));
    createRun(checkpointer, "run_precommit_reopen", "save");
    const input = normalInput({
      root,
      checkpointer,
      runId: "run_precommit_reopen",
      transactionId: "tx_precommit_reopen",
    });
    const [pageId, entry] = Object.entries(input.catalog.pages)[0]!;
    let replaced = false;
    expect(() =>
      publishGenerationTransaction({
        ...input,
        fault(boundary) {
          if (boundary === "before_authority_reservation" && !replaced) {
            replaced = true;
            writeFileSync(pageClaimsPath(root, pageId, entry.revision_id), "{}", { mode: 0o600 });
          }
        },
      })
    ).toThrow(/durable row|bytes/);
    expect(replaced).toBe(true);
    expect(readCurrent(root)).toEqual(base);
    checkpointer.close();
  });

  it("excludes a concurrent base-none init by profile reservation CAS", () => {
    const root = temporaryRoot();
    const checkpointer = new Checkpointer(path.join(root, ".control", "control.db"));
    createRun(checkpointer, "run_init_owner", "init");
    createRun(checkpointer, "run_init_competitor", "init");
    expect(() =>
      publishGenerationTransaction(
        initInput({
          root,
          checkpointer,
          runId: "run_init_owner",
          transactionId: "tx_init_owner",
          fault(boundary) {
            if (boundary === "after_publication_preindexed") throw new Error("owner-crash");
          },
        })
      )
    ).toThrow("owner-crash");
    expect(() =>
      publishGenerationTransaction(
        initInput({
          root,
          checkpointer,
          runId: "run_init_competitor",
          transactionId: "tx_init_competitor",
        })
      )
    ).toThrow(/init_in_progress/);
    expect(readCurrent(root)).toBeUndefined();
    publishGenerationTransaction(
      initInput({
        root,
        checkpointer,
        runId: "run_init_owner",
        transactionId: "tx_init_owner",
      })
    );
    expect(checkpointer.kbInitReservation(PROFILE)?.state).toBe("finalized");
    checkpointer.close();
  });

  it("refuses an exact init transaction after its normalized profile/root remaps", () => {
    const oldRoot = temporaryRoot();
    const newRoot = temporaryRoot();
    const checkpointer = new Checkpointer(path.join(oldRoot, ".control", "control.db"));
    createRun(checkpointer, "run_init_remap", "init");
    expect(() =>
      publishGenerationTransaction(
        initInput({
          root: oldRoot,
          checkpointer,
          runId: "run_init_remap",
          transactionId: "tx_init_remap",
          fault(boundary) {
            if (boundary === "after_publication_preindexed") throw new Error("reserved");
          },
        })
      )
    ).toThrow("reserved");
    expect(() =>
      publishGenerationTransaction(
        initInput({
          root: newRoot,
          checkpointer,
          runId: "run_init_remap",
          transactionId: "tx_init_remap",
        })
      )
    ).toThrow(/profile_remapped/);
    expect(existsSync(path.join(newRoot, "manifest.json"))).toBe(false);
    expect(readCurrent(oldRoot)).toBeUndefined();
    checkpointer.close();
  });

  it("refuses remap after partial old-root publication and recovers only on the original binding", () => {
    const oldRoot = temporaryRoot();
    const newRoot = temporaryRoot();
    const checkpointer = new Checkpointer(path.join(oldRoot, ".control", "control.db"));
    createRun(checkpointer, "run_init_partial_remap", "init");
    let crashed = false;
    expect(() =>
      publishGenerationTransaction(
        initInput({
          root: oldRoot,
          checkpointer,
          runId: "run_init_partial_remap",
          transactionId: "tx_init_partial_remap",
          fault(boundary) {
            if (!crashed && boundary === "after_generation_fsync") {
              crashed = true;
              throw new Error("partial-old-root");
            }
          },
        })
      )
    ).toThrow("partial-old-root");
    const oldManifest = readFileSync(path.join(oldRoot, "manifest.json"), "utf8");
    expect(() =>
      publishGenerationTransaction(
        initInput({
          root: newRoot,
          checkpointer,
          runId: "run_init_partial_remap",
          transactionId: "tx_init_partial_remap",
        })
      )
    ).toThrow(/profile_remapped/);
    expect(existsSync(path.join(newRoot, "manifest.json"))).toBe(false);
    expect(readFileSync(path.join(oldRoot, "manifest.json"), "utf8")).toBe(oldManifest);
    publishGenerationTransaction(
      initInput({
        root: oldRoot,
        checkpointer,
        runId: "run_init_partial_remap",
        transactionId: "tx_init_partial_remap",
      })
    );
    expect(readCurrent(oldRoot)?.generation_id).toBe(
      checkpointer.kbInitReservation(PROFILE)?.generation_id
    );
    expect(checkpointer.kbInitReservation(PROFILE)?.state).toBe("finalized");
    checkpointer.close();
  });

  it("recreates a missing selector temp only from stored selector JCS", () => {
    const root = temporaryRoot();
    const checkpointer = new Checkpointer(path.join(root, ".control", "control.db"));
    createRun(checkpointer, "run_publication_init", "init");
    let crashed = false;
    expect(() =>
      publishGenerationTransaction(
        initInput({
          root,
          checkpointer,
          fault(boundary) {
            if (!crashed && boundary === "after_generation_fsync") {
              crashed = true;
              throw new Error("before-selector");
            }
          },
        })
      )
    ).toThrow("before-selector");
    const publication = checkpointer.kbPublication("tx_publication_init")!;
    const selectorRow = publication.files.find((file) => file.role === "selector")!;
    const selectorTemp = path.join(root, ...selectorRow.staging_key.split("/"));
    rmSync(selectorTemp, { force: true });

    publishGenerationTransaction(initInput({ root, checkpointer }));
    expect(readFileSync(currentPath(root), "utf8")).toBe(publication.selector_jcs);
    checkpointer.close();
  });
});
