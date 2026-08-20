/**
 * §5.6 save-query claims — the single-use right to publish one query's answer.
 *
 * The property under test is that a useful query does not authorize a save, and
 * that the right it does create can be spent exactly once. Everything here is
 * about the ratchet: which transitions are legal, which are refused, and which
 * direction a failure resolves in when the host cannot prove what happened.
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SaveClaimError, SaveQueryClaimStore, saveClaimStoreDir } from "../src/kb/save-claim.js";

const dirs: string[] = [];
function store(): SaveQueryClaimStore {
  const d = mkdtempSync(path.join(tmpdir(), "penny-kb-claims-"));
  dirs.push(d);
  return new SaveQueryClaimStore(d);
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ANSWER = "a".repeat(64);
const OTHER = "b".repeat(64);
const BASE = {
  query_run_id: "run_query_1",
  kb_profile_id: "kbp_test",
  kb_id: "kb_test",
  answer_artifact_id: "art_answer_1",
  answer_sha256: ANSWER,
};
const SAVE = { save_run_id: "run_save_1", save_transaction_id: "tx_1" };

function claimed(s: SaveQueryClaimStore) {
  s.create(BASE);
  return s.claimForSave({
    query_run_id: BASE.query_run_id,
    kb_profile_id: BASE.kb_profile_id,
    answer_sha256: ANSWER,
    ...SAVE,
  });
}

describe("claim creation", () => {
  it("creates exactly one available claim, owner-only on disk", () => {
    const s = store();
    const claim = s.create(BASE);
    expect(claim.state).toBe("available");
    expect(claim.answer_sha256).toBe(ANSWER);
    const mode = statSync(path.join(s.dir, "run_query_1.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("refuses to mint a second right to save the same query run", () => {
    const s = store();
    s.create(BASE);
    // Exclusive create: a second one cannot silently replace the first.
    expect(() => s.create(BASE)).toThrow();
    expect(s.load(BASE.query_run_id).state).toBe("available");
  });

  it("refuses a missing, unparseable, or contract-violating claim rather than defaulting", () => {
    const s = store();
    expect(() => s.load("run_absent")).toThrow(SaveClaimError);
    expect(s.find("run_absent")).toBeUndefined();

    s.create(BASE);
    const file = path.join(s.dir, "run_query_1.json");
    writeFileSync(file, "{not json", { mode: 0o600 });
    expect(() => s.load(BASE.query_run_id)).toThrow(/unparseable/);

    writeFileSync(file, JSON.stringify({ schema_version: 1, state: "available" }), { mode: 0o600 });
    expect(() => s.load(BASE.query_run_id)).toThrow(/closed validation/);
  });

  it("refuses a group/other-writable claim entry", () => {
    const s = store();
    s.create(BASE);
    const file = path.join(s.dir, "run_query_1.json");
    chmodSync(file, 0o666);
    expect(() => s.load(BASE.query_run_id)).toThrow(/writable/);
  });
});

describe("claiming for save (before any side effect)", () => {
  it("CASes available → claimed and records the owning save run", () => {
    const s = store();
    const c = claimed(s);
    expect(c.state).toBe("claimed");
    expect(c.save_run_id).toBe("run_save_1");
    expect(c.save_transaction_id).toBe("tx_1");
  });

  it("refuses a second concurrent save of the same answer", () => {
    const s = store();
    claimed(s);
    expect(() =>
      s.claimForSave({
        query_run_id: BASE.query_run_id,
        kb_profile_id: BASE.kb_profile_id,
        answer_sha256: ANSWER,
        save_run_id: "run_save_2",
        save_transaction_id: "tx_2",
      })
    ).toThrow(/not available/);
    expect(s.load(BASE.query_run_id).save_run_id).toBe("run_save_1");
  });

  it("refuses a cross-profile claim", () => {
    const s = store();
    s.create(BASE);
    expect(() =>
      s.claimForSave({
        query_run_id: BASE.query_run_id,
        kb_profile_id: "kbp_other",
        answer_sha256: ANSWER,
        ...SAVE,
      })
    ).toThrow(/different KB profile/);
  });

  it("invalidates rather than proceeds when the sealed answer drifted", () => {
    const s = store();
    s.create(BASE);
    expect(() =>
      s.claimForSave({
        query_run_id: BASE.query_run_id,
        kb_profile_id: BASE.kb_profile_id,
        answer_sha256: OTHER,
        ...SAVE,
      })
    ).toThrow(/changed since its claim/);
    // The answer under it is not the reviewed one, so the right is gone.
    expect(s.load(BASE.query_run_id).state).toBe("invalidated");
  });

  it("refuses to re-save a consumed answer", () => {
    const s = store();
    claimed(s);
    s.reserveCommit({ query_run_id: BASE.query_run_id, ...SAVE });
    s.consume({ query_run_id: BASE.query_run_id, ...SAVE });
    expect(() =>
      s.claimForSave({
        query_run_id: BASE.query_run_id,
        kb_profile_id: BASE.kb_profile_id,
        answer_sha256: ANSWER,
        save_run_id: "run_save_2",
        save_transaction_id: "tx_2",
      })
    ).toThrow(/already been saved/);
  });
});

describe("the commit ratchet", () => {
  it("reserve → consume is the only path to spent, and reserve is idempotent", () => {
    const s = store();
    claimed(s);
    expect(s.reserveCommit({ query_run_id: BASE.query_run_id, ...SAVE }).state).toBe(
      "commit_reserved"
    );
    expect(s.reserveCommit({ query_run_id: BASE.query_run_id, ...SAVE }).state).toBe(
      "commit_reserved"
    );
    expect(s.consume({ query_run_id: BASE.query_run_id, ...SAVE }).state).toBe("consumed");
    expect(s.consume({ query_run_id: BASE.query_run_id, ...SAVE }).state).toBe("consumed");
  });

  it("refuses to consume without a reservation", () => {
    const s = store();
    claimed(s);
    expect(() => s.consume({ query_run_id: BASE.query_run_id, ...SAVE })).toThrow(
      /commit_reserved/
    );
  });

  it("refuses reservation and consumption by a different save run", () => {
    const s = store();
    claimed(s);
    expect(() =>
      s.reserveCommit({ query_run_id: BASE.query_run_id, save_run_id: "run_save_2" })
    ).toThrow(/different save run/);
    s.reserveCommit({ query_run_id: BASE.query_run_id, ...SAVE });
    expect(() => s.consume({ query_run_id: BASE.query_run_id, save_run_id: "run_save_2" })).toThrow(
      /different save run/
    );
  });

  it("NEVER releases a commit_reserved claim back to available", () => {
    const s = store();
    claimed(s);
    s.reserveCommit({ query_run_id: BASE.query_run_id, ...SAVE });
    // The host cannot prove from outside whether the selector moved, so a
    // reserved claim can only be consumed or invalidated — re-saving a possibly
    // published answer is worse than refusing a legitimate retry.
    expect(() =>
      s.release({
        query_run_id: BASE.query_run_id,
        save_run_id: "run_save_1",
        answer_sha256: ANSWER,
      })
    ).toThrow(/cannot be released/);
    expect(s.invalidate(BASE.query_run_id).state).toBe("invalidated");
  });

  it("never un-spends a consumed claim", () => {
    const s = store();
    claimed(s);
    s.reserveCommit({ query_run_id: BASE.query_run_id, ...SAVE });
    s.consume({ query_run_id: BASE.query_run_id, ...SAVE });
    expect(s.invalidate(BASE.query_run_id).state).toBe("consumed");
  });
});

describe("release after deny, error, or cancellation", () => {
  it("returns to available while the sealed answer is still valid", () => {
    const s = store();
    claimed(s);
    const released = s.release({
      query_run_id: BASE.query_run_id,
      save_run_id: "run_save_1",
      answer_sha256: ANSWER,
    });
    expect(released.state).toBe("available");
    expect(released.save_run_id).toBeUndefined();
    expect(released.save_transaction_id).toBeUndefined();
    // A later save may legitimately claim it again.
    expect(
      s.claimForSave({
        query_run_id: BASE.query_run_id,
        kb_profile_id: BASE.kb_profile_id,
        answer_sha256: ANSWER,
        save_run_id: "run_save_2",
        save_transaction_id: "tx_2",
      }).state
    ).toBe("claimed");
  });

  it("invalidates instead when the answer drifted or can no longer be read", () => {
    const s1 = store();
    claimed(s1);
    expect(
      s1.release({
        query_run_id: BASE.query_run_id,
        save_run_id: "run_save_1",
        answer_sha256: OTHER,
      }).state
    ).toBe("invalidated");

    const s2 = store();
    claimed(s2);
    expect(
      s2.release({
        query_run_id: BASE.query_run_id,
        save_run_id: "run_save_1",
        answer_sha256: undefined,
      }).state
    ).toBe("invalidated");
  });
});

describe("store location", () => {
  it("keeps claims in the host control plane, never inside the KB root", () => {
    const dir = saveClaimStoreDir("/project", "kbp_demo");
    expect(dir).toBe(path.join("/project", ".penny", "kb-save-claims", "kbp_demo"));
    // §5.6's no-write rule for `query` permits control-plane writes but not KB
    // root ones; a claim under the KB root would breach the query contract.
    expect(dir.includes(path.join(".penny", "kb", "kbp_demo"))).toBe(false);
  });

  it("writes claims as JSON that round-trips exactly", () => {
    const s = store();
    const created = s.create(BASE);
    const onDisk = JSON.parse(readFileSync(path.join(s.dir, "run_query_1.json"), "utf8"));
    expect(onDisk).toEqual(created);
  });
});
