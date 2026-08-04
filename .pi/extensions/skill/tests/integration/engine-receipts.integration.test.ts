import { spawnSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { captureToolResultForExecutionOwner } from "../../../subagent/execution-owner-capture.js";
import {
  buildIsolatedAgentInvocation,
  isolatedAgentEnvironment,
} from "../../../subagent/process-isolation.js";
import {
  buildAgentExecutionReceipt,
  buildObservedCommandReceipts,
  parseTrustedHumanEventMarker,
  signTrustedHumanEvent,
  signTrustedInvocation,
  verifyOwnerReceiptForTest,
  withExecutionOwnerEnvironment,
} from "../../execution-receipts.js";

function findProjectRoot(start: string): string {
  let current = path.resolve(start);
  while (true) {
    if (existsSync(path.join(current, ".venv/bin/python"))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error("project root with .venv was not found");
    current = parent;
  }
}

describe("trusted execution-owner receipt seam", () => {
  it("signs a complete redacted receipt without exposing signer capability to agent env", () => {
    expect(process.env.PENNY_RECEIPT_HMAC_KEY).toBeUndefined();
    process.env.PENNY_TEST_API_TOKEN = "environment-secret-value";
    const receipt = buildAgentExecutionReceipt({
      receiptId: "run-1:receipt:1",
      runId: "run-1",
      stateId: "verifying",
      agent: "skribble",
      projectRoot: process.cwd(),
      startedAt: "2026-08-02T00:00:00+00:00",
      endedAt: "2026-08-02T00:00:01+00:00",
      exitStatus: 0,
      output: "12 passed API_TOKEN=secret-value --password hidden-value environment-secret-value",
      secretValues: ["secret-value", "hidden-value"],
    });
    delete process.env.PENNY_TEST_API_TOKEN;

    expect(receipt).toMatchObject({
      schema_version: 1,
      run_id: "run-1",
      state_id: "verifying",
      obligation_id: "state:verifying",
      argv: ["pi-agent", "--agent", "skribble"],
      executor_identity: "agent:skribble",
      execution_owner_identity: "skill-extension-execution-owner",
      exit_status: 0,
      integrity_state: "intact",
      redaction_state: "redacted",
      signature_algorithm: "hmac-sha256",
    });
    expect(String(receipt.output_excerpt)).not.toContain("secret-value");
    expect(String(receipt.output_excerpt)).not.toContain("hidden-value");
    expect(String(receipt.output_excerpt)).not.toContain("environment-secret-value");
    expect(verifyOwnerReceiptForTest(receipt)).toBe(true);

    const projectRoot = findProjectRoot(process.cwd());
    const crossLanguage = spawnSync(
      path.join(projectRoot, ".venv/bin/python"),
      [
        "-c",
        [
          "import json,sys",
          "from orchestration.execution_receipts import validate_execution_receipt",
          "value=json.load(sys.stdin)",
          "print(validate_execution_receipt(value, run_id='run-1', obligation_id='state:verifying', allowed_working_root=value['working_directory']))",
        ].join(";"),
      ],
      {
        input: JSON.stringify(receipt),
        encoding: "utf8",
        env: {
          ...withExecutionOwnerEnvironment(process.env),
          PYTHONPATH: path.join(projectRoot, "apps/orchestration/src"),
        },
      }
    );
    expect(crossLanguage.status).toBe(0);
    expect(crossLanguage.stdout.trim()).toBe("(True, '')");

    const tampered = { ...receipt, exit_status: 1 };
    expect(verifyOwnerReceiptForTest(tampered)).toBe(false);
  });

  it("signs invocation provenance that Python rejects after tampering", () => {
    const invocation = signTrustedInvocation({
      invocationId: "invocation-1",
      runId: "run-1",
      stateId: "learning",
      agentIdentity: "agent:carren",
      model: "openai-codex/terra",
      startedAt: "2026-08-02T00:00:00+00:00",
      endedAt: "2026-08-02T00:00:01+00:00",
    });
    expect(verifyOwnerReceiptForTest(invocation)).toBe(true);

    const projectRoot = findProjectRoot(process.cwd());
    const validate = (value: Record<string, unknown>) =>
      spawnSync(
        path.join(projectRoot, ".venv", "bin", "python"),
        [
          "-c",
          [
            "import json,sys",
            "from orchestration.engine import _validate_trusted_invocation",
            "value=json.load(sys.stdin)",
            "print(_validate_trusted_invocation(value, run_id='run-1', state_id='learning', agent='carren'))",
          ].join(";"),
        ],
        {
          input: JSON.stringify(value),
          encoding: "utf8",
          env: {
            ...withExecutionOwnerEnvironment(process.env),
            PYTHONPATH: path.join(projectRoot, "apps", "orchestration", "src"),
          },
        }
      );

    const accepted = validate(invocation);
    expect(accepted.status).toBe(0);
    expect(accepted.stdout).toContain("'invocation_id': 'invocation-1'");

    const tampered = { ...invocation, model: "openai-codex/sol" };
    const rejected = validate(tampered);
    expect(rejected.status).toBe(0);
    expect(rejected.stdout).toContain("signature is missing or invalid");
  });

  it("shadows the authoritative store from the model-controlled write namespace", () => {
    const targetRoot = mkdtempSync(path.join(os.tmpdir(), "penny-agent-isolation-"));
    const protectedDirectory = path.join(targetRoot, ".penny");
    const protectedStore = path.join(protectedDirectory, "orchestration.db");
    mkdirSync(protectedDirectory);
    writeFileSync(protectedStore, "owner-state", { mode: 0o600 });
    try {
      const invocation = buildIsolatedAgentInvocation(
        {
          command: "/bin/sh",
          args: [
            "-c",
            'test ! -e "$1/orchestration.db" && printf attacker > "$1/orchestration.db"',
            "sh",
            protectedDirectory,
          ],
        },
        targetRoot,
        { protectedPaths: [protectedDirectory], requireSandbox: true }
      );
      const result = spawnSync(invocation.command, invocation.args, {
        cwd: targetRoot,
        env: isolatedAgentEnvironment({
          ...process.env,
          PENNY_RECEIPT_HMAC_KEY: "forbidden",
          PENNY_APPROVAL_HMAC_KEY: "forbidden",
        }),
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(protectedStore, "utf8")).toBe("owner-state");
      expect(isolatedAgentEnvironment({ PENNY_RECEIPT_HMAC_KEY: "x" })).not.toHaveProperty(
        "PENNY_RECEIPT_HMAC_KEY"
      );
    } finally {
      rmSync(targetRoot, { recursive: true, force: true });
    }
  });

  it("keeps agent runtime state writable while still shadowing the authoritative store", () => {
    // Regression guard. `--ro-bind / /` made the agent's OWN state directory
    // read-only, so an OAuth provider could not persist a refreshed token and
    // every skill-driven agent died with "No API key found" right after its
    // session event. Both properties must hold AT ONCE: the agent can write its
    // runtime state, and the owner-protected store stays shadowed.
    const targetRoot = mkdtempSync(path.join(os.tmpdir(), "penny-agent-writable-"));
    const protectedDirectory = path.join(targetRoot, ".penny");
    const protectedStore = path.join(protectedDirectory, "orchestration.db");
    mkdirSync(protectedDirectory);
    writeFileSync(protectedStore, "owner-state", { mode: 0o600 });
    // Stand-in for the agent runtime state dir (e.g. ~/.pi), outside the target.
    const agentState = mkdtempSync(path.join(os.tmpdir(), "penny-agent-state-"));
    writeFileSync(path.join(agentState, "auth.json"), "original-token", { mode: 0o600 });
    try {
      const invocation = buildIsolatedAgentInvocation(
        {
          command: "/bin/sh",
          args: [
            "-c",
            // Refresh the credential (must succeed), then confirm the owner
            // store is NOT visible inside the namespace (tmpfs shadow). A write
            // into the shadow would succeed but never reach the real file, so
            // invisibility is the property that matters here.
            'printf refreshed > "$1/auth.json" || exit 3; ' +
              '[ -e "$2/orchestration.db" ] && exit 4; exit 0',
            "sh",
            agentState,
            protectedDirectory,
          ],
        },
        targetRoot,
        {
          protectedPaths: [protectedDirectory],
          writablePaths: [agentState],
          requireSandbox: true,
        }
      );
      const result = spawnSync(invocation.command, invocation.args, {
        cwd: targetRoot,
        env: isolatedAgentEnvironment({ ...process.env }),
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      // Agent state really persisted outside the sandbox.
      expect(readFileSync(path.join(agentState, "auth.json"), "utf8")).toBe("refreshed");
      // Authority boundary untouched.
      expect(readFileSync(protectedStore, "utf8")).toBe("owner-state");
    } finally {
      rmSync(targetRoot, { recursive: true, force: true });
      rmSync(agentState, { recursive: true, force: true });
    }
  });

  it("keeps agent memory writable while shadowing orchestration state under the SAME root", () => {
    // The real topology: <pennyRoot>/.mempalace (agent memory, must be WRITABLE) and
    // <pennyRoot>/.penny (orchestration authority, must stay SHADOWED) are siblings.
    // Under `--ro-bind / /` mempalace was read-only, so the memory bridge died with
    // sqlite3.OperationalError and every agent ran blind to durable context.
    const pennyRoot = mkdtempSync(path.join(os.tmpdir(), "penny-root-"));
    const targetRoot = mkdtempSync(path.join(os.tmpdir(), "penny-target-"));
    const mempalace = path.join(pennyRoot, ".mempalace");
    const orchestration = path.join(pennyRoot, ".penny");
    mkdirSync(mempalace);
    mkdirSync(orchestration);
    writeFileSync(path.join(orchestration, "orchestration.db"), "owner-state", { mode: 0o600 });
    try {
      const invocation = buildIsolatedAgentInvocation(
        {
          command: "/bin/sh",
          args: [
            "-c",
            // Write agent memory (must succeed), then confirm the owner store is
            // invisible inside the namespace (tmpfs shadow).
            'printf remembered > "$1/kg.db" || exit 3; ' +
              '[ -e "$2/orchestration.db" ] && exit 4; exit 0',
            "sh",
            mempalace,
            orchestration,
          ],
        },
        targetRoot,
        {
          protectedPaths: [orchestration],
          writablePaths: [mempalace],
          requireSandbox: true,
        }
      );
      const result = spawnSync(invocation.command, invocation.args, {
        cwd: targetRoot,
        env: isolatedAgentEnvironment({ ...process.env }),
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      // Agent memory really persisted ...
      expect(readFileSync(path.join(mempalace, "kg.db"), "utf8")).toBe("remembered");
      // ... and the authority boundary under the same root is untouched.
      expect(readFileSync(path.join(orchestration, "orchestration.db"), "utf8")).toBe(
        "owner-state"
      );
    } finally {
      rmSync(pennyRoot, { recursive: true, force: true });
      rmSync(targetRoot, { recursive: true, force: true });
    }
  });

  it("rejects a writable agent path that is a symlink", () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "penny-agent-symlink-"));
    const real = path.join(base, "real");
    const link = path.join(base, "link");
    mkdirSync(real);
    symlinkSync(real, link);
    try {
      expect(() =>
        buildIsolatedAgentInvocation({ command: "/bin/true", args: [] }, base, {
          protectedPaths: [],
          writablePaths: [link],
          requireSandbox: true,
        })
      ).toThrow(/unsafe writable agent path/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("signs obligation receipts only for exact observed successful bash commands", () => {
    const messages = [
      {
        role: "assistant",
        timestamp: Date.parse("2026-08-02T00:00:00+00:00"),
        content: [
          {
            type: "toolCall",
            id: "call-pass",
            name: "bash",
            arguments: { command: "pytest -q" },
          },
          {
            type: "toolCall",
            id: "call-fail",
            name: "bash",
            arguments: { command: "ruff check ." },
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "bash",
        toolCallId: "call-pass",
        isError: false,
        timestamp: Date.parse("2026-08-02T00:00:00.250+00:00"),
        content: [{ type: "text", text: "12 passed" }],
      },
      {
        role: "toolResult",
        toolName: "bash",
        toolCallId: "call-fail",
        isError: true,
        timestamp: Date.parse("2026-08-02T00:00:00.500+00:00"),
        content: [{ type: "text", text: "lint failed" }],
      },
    ];
    const receipts = buildObservedCommandReceipts({
      messages,
      claims: [
        { obligation_id: "criterion:1", command: "pytest -q" },
        { obligation_id: "quality:security", command: "ruff check ." },
        { obligation_id: "criterion:2", command: "pytest --not-observed" },
      ],
      runId: "run-1",
      stateId: "verifying",
      agent: "skribble",
      projectRoot: process.cwd(),
      startedAt: "2026-08-02T00:00:00+00:00",
      endedAt: "2026-08-02T00:00:01+00:00",
      secretValues: [],
    });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      obligation_id: "criterion:1",
      argv: ["bash", "-lc", "pytest -q"],
      exit_status: 0,
      started_at: "2026-08-02T00:00:00.000Z",
      ended_at: "2026-08-02T00:00:00.250Z",
      output_excerpt: "12 passed",
    });
    expect(verifyOwnerReceiptForTest(receipts[0])).toBe(true);

    const missingStart = structuredClone(messages) as Array<Record<string, unknown>>;
    delete missingStart[0].timestamp;
    expect(
      buildObservedCommandReceipts({
        messages: missingStart,
        claims: [{ obligation_id: "criterion:1", command: "pytest -q" }],
        runId: "run-1",
        stateId: "verifying",
        agent: "skribble",
        projectRoot: process.cwd(),
        startedAt: "2026-08-02T00:00:00+00:00",
        endedAt: "2026-08-02T00:00:01+00:00",
        secretValues: [],
      })
    ).toEqual([]);
  });

  it("uses complete persisted output for truncated tool events and fails closed when absent", () => {
    const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "penny-receipt-test-"));
    const fullOutputPath = path.join(temporaryDirectory, "full-output.txt");
    const fullOutput = `${"earlier output\n".repeat(5000)}final pass\n`;
    writeFileSync(fullOutputPath, fullOutput, "utf8");
    const baseMessages: Array<Record<string, unknown>> = [
      {
        role: "assistant",
        timestamp: Date.parse("2026-08-02T00:00:00+00:00"),
        content: [
          {
            type: "toolCall",
            id: "call-truncated",
            name: "bash",
            arguments: { command: "native-test --all" },
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "bash",
        toolCallId: "call-truncated",
        isError: false,
        timestamp: Date.parse("2026-08-02T00:00:01+00:00"),
        content: [{ type: "text", text: "tail only" }],
        details: {
          truncation: { truncated: true },
          fullOutputPath,
        },
      },
    ];
    baseMessages[1] = captureToolResultForExecutionOwner(baseMessages[1]);
    expect(JSON.stringify(baseMessages[1])).not.toContain("earlier output");
    writeFileSync(fullOutputPath, "tampered after owner event capture", "utf8");
    const input = {
      messages: baseMessages,
      claims: [{ obligation_id: "verification:unit", command: "native-test --all" }],
      runId: "run-1",
      stateId: "verifying",
      agent: "skribble",
      projectRoot: process.cwd(),
      startedAt: "2026-08-02T00:00:00+00:00",
      endedAt: "2026-08-02T00:00:02+00:00",
      secretValues: [] as string[],
    };

    try {
      const receipts = buildObservedCommandReceipts(input);
      expect(receipts).toHaveLength(1);
      expect(receipts[0].output_excerpt).toBe(fullOutput);
      expect(receipts[0].output_excerpt).not.toBe("tail only");

      const missingOutput = structuredClone(baseMessages);
      delete (missingOutput[1].details as Record<string, unknown>).executionOwnerCapture;
      expect(buildObservedCommandReceipts({ ...input, messages: missingOutput })).toEqual([]);
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("round-trips only a signed trusted-human marker bound to a gate artifact", () => {
    const event = signTrustedHumanEvent({
      runId: "run-1",
      gateId: "plan_gate",
      challenge: "one-time-challenge",
      artifactRef: {
        artifact_id: "plan-1",
        kind: "piper_plan",
        version: 2,
        digest: "a".repeat(64),
      },
      transportRef: {
        artifact_id: "transport-1",
        kind: "questionnaire_transport",
        version: 1,
        digest: "b".repeat(64),
      },
      renderedQuestionsDigest: "c".repeat(64),
      response: "approve",
    });
    const parsed = parseTrustedHumanEventMarker(
      `Plan: user selected Approve\nTRUSTED_HUMAN_EVENT:${JSON.stringify(event)}`
    );
    expect(parsed).toEqual(event);
    expect(verifyOwnerReceiptForTest(parsed as Record<string, unknown>)).toBe(true);
    expect(parseTrustedHumanEventMarker("approve")).toBeUndefined();
  });
});
