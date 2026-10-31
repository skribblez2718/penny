import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { createVmBrokerProcessRunner } from "../src/vm-broker-adapter.js";
import type { OrdinaryApplicationVmConfig } from "../src/ordinary-application-tests.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const python = realpathSync("/usr/bin/python3");
const guestPath = fileURLToPath(
  new URL("../src/ordinary-application-tests-guest.py", import.meta.url)
);
function payload() {
  return {
    schema_version: 1,
    request_sha256: "a".repeat(64),
    source_snapshot_sha256: "b".repeat(64),
    source_corpus_sha256: "c".repeat(64),
    plan_sha256: "d".repeat(64),
    policy_sha256: "e".repeat(64),
    interpreter: "node",
    resources: {
      vm_timeout_seconds: 120,
      test_timeout_ms: 1000,
      cpu_seconds: 2,
      memory_bytes: 536_870_912,
      processes: 16,
      file_bytes: 4096,
      output_bytes: 1024,
    },
    files: [
      {
        path: "source/harmless.mjs",
        content_sha256: sha256("export const v = 1;"),
        content_base64: Buffer.from("export const v = 1;").toString("base64"),
      },
      {
        path: "tests/harness.mjs",
        content_sha256: sha256("not executed"),
        content_base64: Buffer.from("not executed").toString("base64"),
      },
    ],
    stdin_base64: "",
  };
}
describe("ordinary application-test Python boundary and real bridge plumbing (NO real VM or target execution)", () => {
  it("validates guest operands without calling the guest executor; host execution guard refuses", async () => {
    const raw = canonicalJson(payload());
    const program = `import importlib.util,json,sys\np='${guestPath}'\ns=importlib.util.spec_from_file_location('guest_models_fixture',p)\nm=importlib.util.module_from_spec(s);sys.modules[s.name]=m;s.loader.exec_module(m)\nv=json.loads(sys.argv[1]); parsed=m.parse_payload(v);assert parsed.interpreter=='node'\nfor key, value in [('interpreter','shell'),('resources',dict(v['resources'],processes=999)),('files',[dict(v['files'][0],path='source/../escape'),v['files'][1]])]:\n changed=dict(v);changed[key]=value\n try:m.parse_payload(changed)\n except ValueError:pass\n else:raise AssertionError('unsafe operand admitted')\ntry:m.guard()\nexcept ValueError:pass\nelse:raise AssertionError('host guest guard accepted')\nprint('pure-contract-checks-only')\n`;
    const result = await createVmBrokerProcessRunner(1000).run(
      python,
      ["-I", "-B", "-c", program, raw],
      new AbortController().signal,
      () => {}
    );
    expect(result).toEqual({
      exitCode: 0,
      stdout: "pure-contract-checks-only\n",
      terminated: true,
    });
  });
  it("runs the actual bridge through canonical imports, media, copy, raw receipt and cleanup using a SYNTHETIC guest delegate", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ordinary-app-python-"));
    roots.push(root);
    const work = path.join(root, "ordinary-app-fixture");
    mkdirSync(work, { mode: 0o700 });
    const pin = (file: string) => ({
      path: file,
      sha256: sha256(readFileSync(file)),
      size_bytes: readFileSync(file).length,
    });
    const copied = (name: string, source: string) => {
      const file = path.join(root, name);
      copyFileSync(source, file);
      chmodSync(file, 0o500);
      return pin(file);
    };
    const script = (name: string, body: string) => {
      const file = path.join(root, name);
      writeFileSync(file, `#!${python}\n${body}`, { mode: 0o500 });
      return pin(file);
    };
    // Installed tools may be owned by an unmapped UID in a private user namespace.
    // Pin owner-private copies of the actual binaries, not replacement executors.
    const ownedPython = copied("python3", python);
    const ownedCp = copied("cp", realpathSync("/usr/bin/cp"));
    const runJob = copied(
      "run_job.py",
      fileURLToPath(new URL("../../../scripts/sca-vm/run_job.py", import.meta.url))
    );
    const protocol = copied(
      "output_protocol.py",
      fileURLToPath(new URL("../../../scripts/sca-vm/output_protocol.py", import.meta.url))
    );
    const bridge = copied(
      "bridge.py",
      fileURLToPath(new URL("../src/ordinary-application-tests-bridge.py", import.meta.url))
    );
    const guest = copied("guest.py", guestPath);
    const iso = script(
      "fake-iso",
      "import pathlib,sys\np=pathlib.Path(sys.argv[sys.argv.index('-o')+1]);p.write_bytes(b'disposable-fake-iso-not-a-VM')\n"
    );
    const systemctl = script("fake-systemctl", "print('inactive')\n");
    const delegate = script(
      "synthetic-launcher.py",
      `import base64,hashlib,json,pathlib,sys\na=sys.argv\nroot=pathlib.Path(a[a.index('--disk')+1]);work=root.parent.parent\npayload=(work/'payload.json').read_bytes()\nunit=a[a.index('--unit')+1];evidence=pathlib.Path(a[a.index('--output-dir')+1])\nreceipt={'schema_version':1,'payload_sha256':hashlib.sha256(payload).hexdigest(),'status':'exited','execution':'RUN','exit_code':0,'stdout_base64':base64.b64encode(b'synthetic guest observation').decode(),'stderr_base64':''}\n(evidence/(unit+'.command.json')).write_text('{}');(evidence/(unit+'.command.json')).chmod(0o600)\n(evidence/(unit+'.serial.log')).write_text('PENNY_APP_TEST_RESULT='+json.dumps(receipt,sort_keys=True,separators=(',',':'))+'\\n');(evidence/(unit+'.serial.log')).chmod(0o600)\nprint(json.dumps({'success':True,'confirmed_inactive':True,'input_hashes_preserved':True,'execution_duration_ms':1}))\n`
    );
    const templateFile = path.join(root, "template.raw");
    writeFileSync(templateFile, Buffer.alloc(65_536, 1), { mode: 0o400 });
    chmodSync(templateFile, 0o400);
    const globalLock = path.join(root, "lock");
    writeFileSync(globalLock, "", { mode: 0o600 });
    const vm: OrdinaryApplicationVmConfig = {
      workspace_parent: root,
      global_lock: globalLock,
      run_job: runJob,
      run_guest: delegate,
      output_protocol: protocol,
      python: ownedPython,
      genisoimage: iso,
      cp: ownedCp,
      qemu: ownedPython,
      bwrap: ownedPython,
      systemctl,
      template: pin(templateFile),
      bridge,
      guest,
    };
    const raw = canonicalJson(payload());
    writeFileSync(path.join(work, "config.json"), canonicalJson(vm), { mode: 0o400 });
    writeFileSync(path.join(work, "payload.json"), raw, { mode: 0o400 });
    const result = await createVmBrokerProcessRunner(1000).run(
      python,
      [
        "-I",
        "-B",
        bridge.path,
        "--config",
        path.join(work, "config.json"),
        "--payload",
        path.join(work, "payload.json"),
        "--unit",
        `penny-guest-${"a".repeat(32)}.service`,
      ],
      new AbortController().signal,
      () => {}
    );
    expect(result.exitCode).toBe(0);
    expect(result.terminated).toBe(true);
    const receipt = readFileSync(path.join(work, "receipt.json"));
    expect(result.stdout).toBe(
      canonicalJson({
        schema_version: 1,
        receipt_sha256: sha256(receipt),
        receipt_bytes: receipt.length,
      }) + "\n"
    );
    expect(receipt.toString()).toContain('"containment_proved":true');
    expect(receipt.toString()).toContain('"media_removed":true');
    expect(receipt.toString()).toContain('"status":"completed"');
    expect(readFileSync(globalLock, "utf8")).toBe("");
    expect(readdirSync(work).sort()).toEqual(["config.json", "payload.json", "receipt.json"]);
  });
});
