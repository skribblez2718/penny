/** Installed process/learning modules with executable wire fixtures. No cloud or target execution. */
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { OrchestrationService } from "../dist/service.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { validateScaRequestV1 } from "../dist/skill-contracts/sca-request.js";
import { SCA_PLAYBOOK_REGISTRATION } from "../dist/playbooks/sca.js";
import { SCA_REQUIRED_MODEL } from "../dist/sca/ordinary-model-guard.js";
import { ScaCandidateRuleSchema } from "../dist/sca/ordinary-contracts.js";
import { ScaAdvancedPrivateSchema } from "../dist/sca/ordinary-advanced-host.js";
import { validateContract } from "../dist/contracts.js";
import { createScaOfflineRunner } from "../dist/sca/ordinary-offline-runner.js";
import { AdvancedScriptedClient } from "./helpers/sca-advanced-workflow.js";
import { configuredOfflineFixture } from "./helpers/sca-configured-offline.js";
import {
  environment,
  roots,
  PROJECT_ROOT,
  start,
  identity,
  fixtureAdapters,
  ScriptedScaClient,
} from "./helpers/sca-local-workflow.js";
import type { AgentInvocation } from "../dist/model-client.js";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("production ordinary SCA bindings", () => {
  it("binds every actual registered phase to the required model", () => {
    expect(SCA_PLAYBOOK_REGISTRATION.worker.phases.size).toBe(10);
    for (const phase of SCA_PLAYBOOK_REGISTRATION.worker.phases.values()) {
      if (!("required_model" in phase) || !("allowed_tools" in phase))
        throw new Error("Wrong production phase kind");
      expect(phase.required_model).toEqual(SCA_REQUIRED_MODEL);
      expect(phase.allowed_tools).toEqual(["artifact_read"]);
    }
  });
  it("keeps optional candidate metadata inert and closed", () => {
    const rule = {
      rules: [
        {
          id: "x",
          languages: ["typescript"],
          message: "x",
          severity: "WARNING",
          pattern: "exec($X)",
          metadata: { category: "security", technology: ["node"] },
        },
      ],
    };
    expect(validateContract(ScaCandidateRuleSchema, rule, "Candidate")).toEqual(rule);
    expect(() =>
      validateContract(ScaCandidateRuleSchema, { ...rule, grant: true }, "Candidate")
    ).toThrow();
  });
  it.each(["budget", "library_in_target"] as const)(
    "refuses caller offline %s before run creation",
    (mode) => {
      environment();
      const fixture = configuredOfflineFixture();
      const chosen = fixture.advanced.learning[0];
      if (chosen === undefined || chosen.offline_validation === undefined)
        throw new Error("Missing pins");
      if (mode === "budget") chosen.limits.max_processes = 19;
      else
        chosen.offline_validation.core_library_directory = start("probe").constraints.source_root;
      expect(() =>
        validateScaRequestV1({
          purpose: "probe",
          ...start("probe").constraints,
          execution_mode: "propose_stronger_evidence",
          advanced: fixture.advanced,
        })
      ).toThrow();
    }
  );
  it("runs the configured normal service path through installed modules: 20 learning processes then separate rescan", async () => {
    const env = environment(),
      fixture = configuredOfflineFixture(),
      client = new AdvancedScriptedClient(false);
    const configFile = path.join(fixture.root, "offline-host.json");
    writeFileSync(configFile, canonicalJson(fixture.runnerConfig), { mode: 0o600 });
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      playbookName: "sca",
      env: { ...env, PENNY_SCA_ORDINARY_OFFLINE_CONFIG: configFile },
      modelClient: client,
      hostOperationAdapters: fixtureAdapters("noalert"),
    });
    client.bindArtifactReader((id) => service.artifacts.readById(id).toString("utf8"));
    const runId = "production-offline-wire";
    const request = {
      ...start(runId),
      constraints: {
        ...start(runId).constraints,
        execution_mode: "propose_stronger_evidence",
        advanced: { ...fixture.advanced, application_tests: [] },
      },
    };
    const terminal = await service.execute(request);
    expect(terminal.action).toBe("incomplete"); // New rescan leads are not confirmed findings.
    const run = service.checkpointer.loadRunById(runId);
    if (run === undefined) throw new Error("Missing run");
    const records = service.checkpointer.hostOperationCallsForRun(runId);
    const validation = records.find((r) => r.operation_kind === "sca.validation.v1");
    const privateRef = validation?.operation_result_ref;
    if (privateRef === undefined || privateRef === null)
      throw new Error("Missing private validation record");
    const data = validateContract(
      ScaAdvancedPrivateSchema,
      JSON.parse(service.artifacts.readById(privateRef.artifact_id).toString("utf8")),
      "Saved validation"
    );
    expect(
      records.map((r) => r.operation_kind),
      canonicalJson(data)
    ).toEqual([
      "sca.preparation.v1",
      "sca.evidence.v1",
      "sca.validation.v1",
      "sca.promotion.v1",
      "sca.rescan.v1",
    ]);
    expect(data.validation?.result.status).toBe("validated");
    expect(data.validation?.receipts).toHaveLength(20);
    expect(data.validation?.receipts.slice(0, 2).map((r) => r.kind)).toEqual([
      "validate_schema",
      "validate",
    ]);
    expect(data.validation?.request.offline_validation).toEqual(
      fixture.advanced.learning[0]?.offline_validation
    );
    expect(records.every((r) => r.lifecycle === "consumed")).toBe(true);
    expect(readdirSync(fixture.namespace)).not.toHaveLength(0);
    expect(readFileSync(fixture.advanced.learning[0]?.baseline.rules_path ?? "", "utf8")).toBe(
      '{"rules":[]}'
    );
    expect(
      await service.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
    ).toEqual(terminal);
  }, 120000);
  it("actually denies socket creation in a trusted analyzer child and cleans its executable staging", async () => {
    environment();
    const fixture = configuredOfflineFixture();
    const executable = path.join(fixture.root, "network-probe.py");
    const source =
      "#!/usr/bin/python3\nimport socket\ntry:\n socket.socket()\nexcept PermissionError:\n print('SOCKET_DENIED')\nelse:\n raise RuntimeError('socket unexpectedly permitted')\n";
    writeFileSync(executable, source, { mode: 0o700 });
    const request = {
      schema_id: "penny.sca-process-request.v1" as const,
      schema_version: 1 as const,
      executable,
      executable_sha256: sha256(source),
      arguments: [],
      cwd: fixture.root,
      environment: [{ name: "PATH", value: "/usr/bin:/bin" }],
      timeout_ms: 10000,
      max_stdout_bytes: 4096,
      max_stderr_bytes: 4096,
    };
    let activity = 0;
    const result = await fixture.runner.runOffline(request, undefined, () => {
      activity++;
    });
    expect(result.status, canonicalJson(result)).toBe("succeeded");
    expect(result.stdout).toBe("SOCKET_DENIED\n");
    expect(activity).toBeGreaterThan(0);
    expect(result.request_sha256).toBe(sha256(canonicalJson(request)));
    expect(readdirSync(fixture.runnerConfig.workRoot)).toEqual([]);
    const drift = createScaOfflineRunner({
      ...fixture.runnerConfig,
      tracer: { ...fixture.runnerConfig.tracer, sha256: "0".repeat(64) },
    });
    await expect(drift.runOffline(request)).rejects.toThrow();
    expect(readdirSync(fixture.runnerConfig.workRoot)).toEqual([]);
  });
  it("permits only anonymous stream IPC for actual Python asyncio while independently denying network/control-plane syscalls in fork/exec/thread children", async () => {
    environment();
    const fixture = configuredOfflineFixture();
    const executable = path.join(fixture.root, "ipc-probe.py");
    const source = String.raw`#!/usr/bin/python3
import asyncio, ctypes, errno, os, platform, socket, subprocess, sys, threading
libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long

def denied(nr, *args):
    ctypes.set_errno(0)
    result = libc.syscall(nr, *args)
    assert result == -1 and ctypes.get_errno() == errno.EPERM, (nr, result, ctypes.get_errno())

x64 = platform.machine() == 'x86_64'
numbers = {'socket':41 if x64 else 198, 'pair':53 if x64 else 199, 'connect':42 if x64 else 203, 'sendto':44 if x64 else 206}

def controls():
    for family in (socket.AF_INET, socket.AF_INET6, socket.AF_UNIX):
        try:
            socket.socket(family, socket.SOCK_STREAM)
        except PermissionError:
            pass
        else:
            raise AssertionError('socket permitted')
        denied(numbers['socket'], family, socket.SOCK_STREAM, 0)
    a,b = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        a.send(b'ipc')
        assert b.recv(3) == b'ipc'
        # Independent connect denial on an already-existing descriptor, for IPv4/6 and
        # the actual caller-owned Unix control-plane listener. No destination is contacted.
        for address in (b'\x02\0\0\x50\x7f\0\0\x01'+b'\0'*8, b'\x0a\0'+b'\0'*26,
                        b'\x01\0'+sys.argv[1].encode()+b'\0'):
            buf = ctypes.create_string_buffer(address)
            denied(numbers['connect'], a.fileno(), buf, len(address))
            denied(numbers['sendto'], a.fileno(), ctypes.c_char_p(b'x'), 1, 0, buf, len(address))
        for family,typ,protocol in ((30,socket.SOCK_STREAM,0),(socket.AF_INET,socket.SOCK_STREAM,0),
                                    (socket.AF_INET6,socket.SOCK_STREAM,0),(socket.AF_UNIX,socket.SOCK_DGRAM,0),
                                    (socket.AF_UNIX,socket.SOCK_STREAM,1)):
            fds = (ctypes.c_int*2)()
            denied(numbers['pair'], family, typ, protocol, fds)
        try:
            a.sendmsg([b'x'])
        except PermissionError:
            pass
        else:
            raise AssertionError('sendmsg/FD passing permitted')
    finally:
        a.close(); b.close()
    for nr in (425,426,427,438):
        denied(nr,0,0,0,0,0,0)
    if x64:
        denied(0x40000000 | 41, socket.AF_INET, socket.SOCK_STREAM, 0)
    for name in os.listdir('/proc/self/fd'):
        fd = int(name)
        if fd > 2:
            try:
                s = socket.socket(fileno=os.dup(fd))
            except OSError:
                continue
            else:
                s.close()
                raise AssertionError('inherited socket fd')

if len(sys.argv) > 2:
    controls()
    print('EXEC_CHILD_DENIED')
    sys.exit(0)
controls()
failures = []
def child_thread():
    try:
        controls()
    except BaseException as e:
        failures.append(e)
t = threading.Thread(target=child_thread); t.start(); t.join()
assert not failures, failures
pid = os.fork()
if pid == 0:
    controls()
    os._exit(0)
assert os.waitpid(pid,0)[1] == 0
out = subprocess.run(['/usr/bin/python3', __file__, sys.argv[1], 'child'], capture_output=True, text=True)
assert out.returncode == 0 and out.stdout == 'EXEC_CHILD_DENIED\n', (out.returncode,out.stdout,out.stderr)
async def main():
    loop = asyncio.get_running_loop()
    ready = loop.create_future()
    t = threading.Thread(target=lambda: loop.call_soon_threadsafe(ready.set_result, 'awake'))
    t.start()
    assert await asyncio.wait_for(ready,1) == 'awake'
    t.join()
    await asyncio.sleep(0.001)
asyncio.run(main())
print('ANONYMOUS_IPC_ASYNC_OK; SOCKET_CONNECT_V4_V6_UNIX_DENIED; FORK_EXEC_THREAD_DENIED; NO_INHERITED_NETWORK_FD')
`;
    writeFileSync(executable, source, { mode: 0o700 });
    const socketPath = path.join(fixture.root, "control.sock");
    let contacts = 0;
    const control = createServer((connection) => {
      contacts++;
      connection.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      control.once("error", reject);
      control.listen(socketPath, resolve);
    });
    try {
      const request = {
        schema_id: "penny.sca-process-request.v1" as const,
        schema_version: 1 as const,
        executable,
        executable_sha256: sha256(source),
        arguments: [socketPath],
        cwd: fixture.root,
        environment: [{ name: "PATH", value: "/usr/bin:/bin" }],
        timeout_ms: 10000,
        max_stdout_bytes: 8192,
        max_stderr_bytes: 8192,
      };
      const result = await fixture.runner.runOffline(request);
      expect(result.status, canonicalJson(result)).toBe("succeeded");
      expect(result.stdout).toBe(
        "ANONYMOUS_IPC_ASYNC_OK; SOCKET_CONNECT_V4_V6_UNIX_DENIED; FORK_EXEC_THREAD_DENIED; NO_INHERITED_NETWORK_FD\n"
      );
      expect(result.stderr).toBe("");
      expect(result.stdout_sha256).toBe(sha256(result.stdout));
      expect(result.request_sha256).toBe(sha256(canonicalJson(request)));
      expect(contacts).toBe(0);
      expect(readdirSync(fixture.runnerConfig.workRoot)).toEqual([]);
      const python = fixture.runnerConfig.ipc_python;
      if (python === undefined) throw new Error("Missing exact launcher pin");
      const drift = createScaOfflineRunner({
        ...fixture.runnerConfig,
        ipc_python: { ...python, sha256: "0".repeat(64) },
      });
      await expect(drift.runOffline(request)).rejects.toThrow("identity drift");
      expect(readdirSync(fixture.runnerConfig.workRoot)).toEqual([]);
      const { ipc_python: _ipc, ...legacyConfig } = fixture.runnerConfig;
      const legacy = await createScaOfflineRunner(legacyConfig).runOffline(request);
      expect(legacy.status).toBe("nonzero_exit");
      expect(legacy.stdout).not.toContain("ASYNC_OK");
    } finally {
      await new Promise<void>((resolve, reject) =>
        control.close((error) => (error === undefined ? resolve() : reject(error)))
      );
    }
  });
  it("repairs routing only from the exact captured malformed artifact, without accepting appended text", async () => {
    class MalformedOnce extends ScriptedScaClient {
      private original = "";
      override async runAgent(invocation: AgentInvocation) {
        if (invocation.executionPurpose === "routing_repair") {
          this.invocations.push(invocation);
          invocation.admitResolvedModel?.({
            provider: SCA_REQUIRED_MODEL.provider,
            model: SCA_REQUIRED_MODEL.model,
          });
          invocation.guardModelDispatch?.("SCRIPTED routing-only repair");
          return { text: this.original.slice(this.original.indexOf("SUMMARY:")) };
        }
        const result = await super.runAgent(invocation);
        if (!this.original && invocation.stateId === "selecting_underdetected_no_alert_surfaces") {
          this.original = result.text;
          return { text: result.text + "\nForbidden appended confidence prose" };
        }
        return result;
      }
    }
    const env = environment(),
      client = new MalformedOnce("noalert");
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      playbookName: "sca",
      modelClient: client,
      hostOperationAdapters: fixtureAdapters("noalert"),
    });
    client.bindArtifactReader((id) => service.artifacts.readById(id).toString("utf8"));
    const terminal = await service.execute(start("routing-production"));
    expect(terminal.action).toBe("complete");
    const repair = client.invocations.find((i) => i.executionPurpose === "routing_repair");
    expect(repair?.inputArtifacts).toHaveLength(1);
    expect(repair?.inputArtifacts[0]?.producer).toBe("agent:echo");
    expect(repair?.registration?.required_model).toEqual(SCA_REQUIRED_MODEL);
    expect(client.invocations).toHaveLength(11);
  });
});
