import { expect, it } from "vitest";
import { Type } from "typebox";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { validateContract } from "../../orchestration/dist/contracts.js";
import {
  OrdinaryApplicationContainerConfigSchema,
  recoverOrdinaryApplicationTest,
  OrdinaryApplicationRuntimeConfigSchema,
  OrdinaryApplicationContainerPlanSchema,
  OrdinaryApplicationContainerPolicySchema,
  OrdinaryApplicationTestRequestSchema,
  OrdinaryApplicationTestAuthoritySchema,
  OrdinaryApplicationTestResultSchema,
} from "../src/ordinary-application-tests.js";
import {
  ordinaryApplicationDockerCommand,
  type OrdinaryApplicationDockerRunner,
} from "../src/ordinary-application-container.js";
import {
  containerFixture,
  privateContainerFixtureRoot,
  type ContainerFixtureOptions,
} from "./fixtures/ordinary-application-container.js";

// Caller opt-in only; no production config, image discovery, pull, build, install or canonical state.
const configPath = process.env.PENNY_ORDINARY_APPLICATION_CONTAINER_CONFIG;
it.runIf(configPath !== undefined)(
  "real CONTAINER PHP/JS/TS, exact closure, policy/canaries, resource bounds, cancellation, runner crash and no-rerun recovery",
  async () => {
    if (configPath === undefined) throw new Error("Explicit caller config required");
    const value: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    const supplied = validateContract(
      OrdinaryApplicationContainerConfigSchema,
      value,
      "caller native CONTAINER config"
    );
    const root = privateContainerFixtureRoot();
    const workspace = path.join(root, "containers");
    mkdirSync(workspace, { mode: 0o700 });
    const config = { ...supplied, workspace_parent: workspace };
    writeFileSync(path.join(root, "host-config.json"), canonicalJson(config), { mode: 0o600 });
    writeFileSync(
      path.join(root, "contract-schemas.json"),
      canonicalJson({
        host_config: OrdinaryApplicationRuntimeConfigSchema,
        container_plan: OrdinaryApplicationContainerPlanSchema,
        container_policy: OrdinaryApplicationContainerPolicySchema,
        request: OrdinaryApplicationTestRequestSchema,
        authority: OrdinaryApplicationTestAuthoritySchema,
        result: OrdinaryApplicationTestResultSchema,
      }),
      { mode: 0o600 }
    );
    console.info(`Native CONTAINER evidence retained at: ${root}`);
    const results: unknown[] = [];
    async function run(
      options: Omit<ContainerFixtureOptions, "root" | "config"> = {},
      runner?: OrdinaryApplicationDockerRunner
    ) {
      const f = containerFixture({ root, config, ...options });
      try {
        const result = await f.run(runner);
        results.push({ case_root: f.root, result });
        writeFileSync(path.join(root, "results.json"), canonicalJson(results), { mode: 0o600 });
        expect(
          recoverOrdinaryApplicationTest(f.request, Buffer.from(canonicalJson(result)))
        ).toEqual(result);
        return { f, result };
      } finally {
        f.close();
      }
    }
    for (const interpreter of ["php", "node", "node_typescript"] as const) {
      for (const vulnerable of [false, true]) {
        const source = !vulnerable
          ? undefined
          : interpreter === "php"
            ? "<?php function render($s) { return $s; }\n"
            : `export function render(s${interpreter === "node_typescript" ? ": string" : ""}) { return s; }\n`;
        const { result } = await run({ interpreter, source });
        expect(result).toMatchObject({
          status: "completed",
          execution: "RUN",
          passed: true,
          isolation: "CONTAINER",
          cleanup: "proved",
          quarantine_required: false,
        });
        expect(Buffer.from(result.stdout_base64, "base64").toString()).toBe(
          vulnerable ? "vulnerable" : "safe"
        );
      }
    }
    const sentinel = path.join(root, "host-only-canary");
    writeFileSync(sentinel, "harmless-host-only-canary", { mode: 0o600 });
    const key = "PENNY_DISPOSABLE_CONTAINER_CANARY";
    const previous = process.env[key];
    process.env[key] = "harmless-generated-not-forwarded";
    try {
      const harness = `import fs from 'node:fs'; import net from 'node:net';
const denyWrite=p=>{try{fs.writeFileSync(p,'no');return false}catch{return true}};
if(process.getuid()!==65534 || process.env.${key} || fs.existsSync(${JSON.stringify(sentinel)})) process.exit(2);
for(const p of ['/var/run/docker.sock','/run/docker.sock','/usr/bin/docker','/usr/local/bin/docker','/root/.ssh','/root/.aws','/root/.docker/config.json']) if(fs.existsSync(p)) process.exit(3);
if(!denyWrite('/input/source/target.mjs') || !denyWrite('/root-filesystem-canary')) process.exit(4);
if(fs.readFileSync('data/value.txt','utf8')!=='exact-input' || fs.readFileSync(0,'utf8')!=='exact-stdin') process.exit(5);
const status=fs.readFileSync('/proc/self/status','utf8'); if(!/^NoNewPrivs:\\s+1$/m.test(status) || !/^Seccomp:\\s+2$/m.test(status) || !/^CapEff:\\s+0+$/m.test(status)) process.exit(6);
for(const [f,v] of [['memory.max','536870912'],['memory.swap.max','0'],['pids.max','32'],['cpu.max','100000 100000']]) if(fs.readFileSync('/sys/fs/cgroup/'+f,'utf8').trim()!==v) process.exit(7);
async function denied(o){return await new Promise(resolve=>{const s=net.connect(o);s.on('connect',()=>{s.destroy();resolve(false)});s.on('error',()=>resolve(true));s.setTimeout(700,()=>{s.destroy();resolve(true)})})}
for(const host of ['192.0.2.1','169.254.169.254','127.0.0.1']) if(!await denied({host,port:9})) process.exit(8);
if(!await denied({path:'/var/run/docker.sock'})) process.exit(9);
fs.writeFileSync('/tmp/small','ok');process.stdout.write('confined-and-limits-observed');`;
      const { result } = await run({ harness });
      expect(result).toMatchObject({
        status: "completed",
        execution: "RUN",
        passed: true,
        cleanup: "proved",
      });
      expect(Buffer.from(result.stdout_base64, "base64").toString()).toBe(
        "confined-and-limits-observed"
      );
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    const denialCases = [
      {
        mutatePlan(plan) {
          plan.source_files[0] = { path: "target.mjs", content_sha256: "0".repeat(64) };
        },
      },
      {
        mutatePlan(plan) {
          plan.test_inputs.push({ path: "../escape", ref: plan.harness_ref });
        },
      },
      {
        mutatePolicy(policy) {
          return { ...policy, isolation: "vm" };
        },
      },
      {
        mutatePolicy(policy) {
          return { ...policy, network: "host" };
        },
      },
      {
        mutatePolicy(policy) {
          return { ...policy, command: "arbitrary" };
        },
      },
    ] satisfies Array<Omit<ContainerFixtureOptions, "root" | "config">>;
    for (const test of denialCases) {
      const { f, result } = await run(test);
      expect(result).toMatchObject({
        status: "denied",
        execution: "NOT RUN",
        acceptance: "not_submitted",
      });
      expect(f.events).toEqual([]);
    }
    for (const interpreter of ["php", "node", "node_typescript"] as const) {
      const { result } = await run({
        interpreter,
        harness:
          interpreter === "php" ? "<?php broken syntax ?%" : "this is not valid source === ?",
      });
      expect(result).toMatchObject({
        status: "completed",
        execution: "RUN",
        passed: false,
        cleanup: "proved",
      });
    }
    const snapshot = containerFixture({ root, config });
    try {
      // Mutating the original caller checkout after capture cannot change staged bytes.
      writeFileSync(
        path.join(snapshot.sourceRoot, "target.mjs"),
        "throw Error('must not execute changed host checkout')"
      );
      const result = await snapshot.run();
      expect(result).toMatchObject({ status: "completed", passed: true, cleanup: "proved" });
      expect(Buffer.from(result.stdout_base64, "base64").toString()).toBe("safe");
    } finally {
      snapshot.close();
    }
    const phpConfinement = await run({
      interpreter: "php",
      harness: `<?php
if (getenv('${key}') !== false || file_exists(${JSON.stringify(sentinel)})) exit(2);
foreach(['/var/run/docker.sock','/run/docker.sock','/usr/bin/docker','/usr/local/bin/docker','/root/.ssh','/root/.aws','/root/.docker/config.json'] as $p) if(file_exists($p)) exit(3);
if (@file_put_contents('/root-filesystem-canary','no') !== false || @file_put_contents('/input/source/target.php','no') !== false) exit(4);
foreach(['192.0.2.1','169.254.169.254','127.0.0.1'] as $host) if (@fsockopen($host,9,$n,$e,0.3)!==false) exit(5);
if (trim(file_get_contents('/sys/fs/cgroup/memory.max'))!=='536870912' || trim(file_get_contents('/sys/fs/cgroup/pids.max'))!=='32') exit(6);
if(file_get_contents('data/value.txt')!=='exact-input' || file_get_contents('php://stdin')!=='exact-stdin')exit(7);
echo 'php-confined';`,
    });
    expect(phpConfinement.result).toMatchObject({
      status: "completed",
      execution: "RUN",
      passed: true,
      cleanup: "proved",
    });
    expect(Buffer.from(phpConfinement.result.stdout_base64, "base64").toString()).toBe(
      "php-confined"
    );
    const resourceHarness = `import fs from 'node:fs'; import {spawn} from 'node:child_process';
const fd=fs.openSync('/tmp/file-size-canary','w');const written=fs.writeSync(fd,Buffer.alloc(2097152));if(written!==1048576 || fs.fstatSync(fd).size!==1048576)process.exit(5);fs.closeSync(fd);fs.unlinkSync('/tmp/file-size-canary');
let full=false;const block=Buffer.alloc(1048576);for(let i=0;i<24;i++){try{fs.writeFileSync('/tmp/block-'+i,block)}catch(e){if(e.code==='ENOSPC'){full=true;break}throw e}}
if(!full) process.exit(2);for(const name of fs.readdirSync('/tmp')) fs.unlinkSync('/tmp/'+name);
const fds=[];let fdDenied=false;try{for(let i=0;i<80;i++)fds.push(fs.openSync('/dev/null','r'))}catch(e){if(e.code==='EMFILE')fdDenied=true;else throw e}finally{for(const fd of fds)fs.closeSync(fd)}if(!fdDenied)process.exit(3);
const outcomes=await Promise.all(Array.from({length:64},()=>new Promise(resolve=>{const child=spawn('/bin/sleep',['0.3'],{stdio:'ignore'});child.on('error',e=>resolve(e.code));child.on('exit',()=>resolve('exit'))})));
if(!outcomes.includes('EAGAIN') || !/^max [1-9][0-9]*$/m.test(fs.readFileSync('/sys/fs/cgroup/pids.events','utf8')))process.exit(4);
process.stdout.write('tmpfs-fd-and-fork-bounds-denied');`;
    const resourceResult = await run({
      harness: resourceHarness,
      resources: { test_timeout_ms: 5000 },
    });
    expect(resourceResult.result).toMatchObject({
      status: "completed",
      execution: "RUN",
      passed: true,
      cleanup: "proved",
    });
    expect(Buffer.from(resourceResult.result.stdout_base64, "base64").toString()).toBe(
      "tmpfs-fd-and-fork-bounds-denied"
    );
    const memory = await run({
      harness: "const a=[];while(true)a.push(Buffer.alloc(32*1024*1024,1));",
      resources: { test_timeout_ms: 5000 },
    });
    expect(memory.result).toMatchObject({
      status: "failed",
      reason: "container_failed",
      execution: "RUN",
      cleanup: "proved",
    });
    const memoryReceipt: unknown = JSON.parse(
      Buffer.from(memory.result.raw_receipt_base64, "base64").toString()
    );
    const memoryParsed = validateContract(
      Type.Object(
        {
          events: Type.Array(
            Type.Object(
              { response: Type.Object({ stdout: Type.String() }, { additionalProperties: true }) },
              { additionalProperties: true }
            )
          ),
        },
        { additionalProperties: true }
      ),
      memoryReceipt,
      "native memory receipt"
    );
    expect(
      memoryParsed.events.some((event) =>
        Buffer.from(event.response.stdout, "base64").toString().includes('"OOMKilled":true')
      )
    ).toBe(true);
    const cpuStart = performance.now();
    const cpu = await run({
      harness: "while(true){}",
      resources: { cpu_seconds: 1, test_timeout_ms: 5000 },
    });
    expect(cpu.result).toMatchObject({
      status: "completed",
      execution: "RUN",
      passed: false,
      exit_code: 137,
      cleanup: "proved",
    });
    expect(performance.now() - cpuStart).toBeLessThan(5000);
    const missingInterpreter = containerFixture({
      root,
      config: { ...config, images: { ...config.images, php: config.images.node } },
      interpreter: "php",
    });
    try {
      const missing = await missingInterpreter.run();
      expect(missing).toMatchObject({
        status: "incomplete",
        execution: "UNKNOWN",
        cleanup: "proved",
        quarantine_required: false,
      });
    } finally {
      missingInterpreter.close();
    }
    const timed = await run({
      harness: "setInterval(()=>{},1000)",
      resources: { test_timeout_ms: 250 },
    });
    expect(timed.result).toMatchObject({
      status: "failed",
      reason: "timeout",
      execution: "RUN",
      cleanup: "proved",
    });
    const overflow = await run({
      harness: "while(true) process.stdout.write('x'.repeat(4096));",
      resources: { output_bytes: 1024 },
    });
    expect(overflow.result).toMatchObject({
      status: "failed",
      reason: "output_limit",
      execution: "RUN",
      cleanup: "proved",
    });
    expect(
      Buffer.from(overflow.result.stdout_base64, "base64").length +
        Buffer.from(overflow.result.stderr_base64, "base64").length
    ).toBeLessThanOrEqual(1024);
    let abort: (() => void) | undefined;
    const cancel: OrdinaryApplicationDockerRunner = async (command) => {
      if (command.argv.includes("start")) {
        const timer = setTimeout(() => abort?.(), 250);
        try {
          return await ordinaryApplicationDockerCommand(command);
        } finally {
          clearTimeout(timer);
        }
      }
      return ordinaryApplicationDockerCommand(command);
    };
    const cancelled = await run(
      {
        harness: "setInterval(()=>{},1000)",
        accepted(controller) {
          abort = () => controller.abort();
        },
      },
      cancel
    );
    expect(cancelled.result).toMatchObject({
      status: "failed",
      reason: "cancelled",
      execution: "RUN",
      cleanup: "proved",
      quarantine_required: false,
    });
    const crash: OrdinaryApplicationDockerRunner = async (command) => {
      if (command.argv.includes("start")) {
        await ordinaryApplicationDockerCommand({
          ...command,
          argv: command.argv.filter((arg) => arg !== "--attach" && arg !== "--interactive"),
        });
        throw new Error("controlled runner crash after real daemon start");
      }
      return ordinaryApplicationDockerCommand(command);
    };
    const crashed = await run({ harness: "setInterval(()=>{},1000)" }, crash);
    expect(crashed.result).toMatchObject({
      status: "incomplete",
      execution: "UNKNOWN",
      cleanup: "proved",
      quarantine_required: false,
    });
    const uncertainCreate: OrdinaryApplicationDockerRunner = async (command) => {
      const response = await ordinaryApplicationDockerCommand(command);
      if (command.argv.includes("create"))
        throw new Error("controlled lost daemon create acknowledgement");
      return response;
    };
    const uncertain = await run({}, uncertainCreate);
    expect(uncertain.result).toMatchObject({
      status: "incomplete",
      execution: "UNKNOWN",
      cleanup: "unproved",
      quarantine_required: true,
    });
    if (uncertain.result.retained_workspace === null)
      throw new Error("Missing quarantined private staging");
    expect(existsSync(uncertain.result.retained_workspace)).toBe(true);
    const lostController = containerFixture({
      root,
      config,
      harness: "setInterval(()=>{},1000)",
      resources: { test_timeout_ms: 500 },
    });
    try {
      let disconnected = false;
      const unavailable: OrdinaryApplicationDockerRunner = async (command) => {
        if (disconnected) throw new Error("controlled complete transport loss");
        if (command.argv.includes("start")) {
          const response = await ordinaryApplicationDockerCommand({
            ...command,
            argv: command.argv.filter((arg) => arg !== "--attach" && arg !== "--interactive"),
          });
          expect(response.exit_code).toBe(0);
          disconnected = true;
          throw new Error("controlled disappearance of workload controller");
        }
        return ordinaryApplicationDockerCommand(command);
      };
      const lost = await lostController.run(unavailable);
      expect(lost).toMatchObject({
        status: "incomplete",
        execution: "UNKNOWN",
        cleanup: "unproved",
        quarantine_required: true,
      });
      if (lost.retained_workspace === null) throw new Error("Missing orphan custody");
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const name = `penny-app-${sha256(canonicalJson(lostController.request))}`;
      const reconciliation: unknown[] = [];
      const control = async (args: string[]) => {
        const response = await ordinaryApplicationDockerCommand({
          executable: config.docker.path,
          argv: [
            "--config",
            path.join(lost.retained_workspace ?? "", "docker-config"),
            "--host",
            `unix://${config.daemon_socket}`,
            "container",
            ...args,
          ],
          signal: new AbortController().signal,
          timeout_ms: 5000,
          output_bytes: 1_048_576,
          input: Buffer.alloc(0),
        });
        reconciliation.push({
          args,
          ...response,
          stdout: response.stdout.toString("base64"),
          stderr: response.stderr.toString("base64"),
        });
        expect(response.exit_code).toBe(0);
        expect(response.failure).toBeNull();
        expect(response.terminated).toBe(true);
        return response;
      };
      const inspected = await control(["inspect", "--format", "{{json .}}", name]);
      const orphanValue: unknown = JSON.parse(inspected.stdout.toString());
      const orphan = validateContract(
        Type.Object(
          {
            Id: Type.String({ pattern: "^[a-f0-9]{64}$" }),
            Name: Type.String(),
            State: Type.Object(
              { Running: Type.Boolean(), Status: Type.String(), ExitCode: Type.Integer() },
              { additionalProperties: true }
            ),
            Config: Type.Object(
              { Labels: Type.Record(Type.String(), Type.String()) },
              { additionalProperties: true }
            ),
          },
          { additionalProperties: true }
        ),
        orphanValue,
        "native independently stopped orphan"
      );
      expect(orphan.Name).toBe(`/${name}`);
      expect(orphan.Config.Labels["penny.application.request"]).toBe(lost.request_sha256);
      // The daemon-side timeout—not this disconnected controller—must have ended execution.
      expect(orphan.State).toMatchObject({ Running: false, Status: "exited", ExitCode: 137 });
      await control(["rm", orphan.Id]);
      const absent = await control([
        "ls",
        "--all",
        "--filter",
        `name=^/${name}$`,
        "--format",
        "{{.ID}}",
      ]);
      expect(absent.stdout.length).toBe(0);
      writeFileSync(
        path.join(root, "orphan-reconciliation.json"),
        canonicalJson({ lost_request: lostController.request, lost_result: lost, reconciliation }),
        { mode: 0o600 }
      );
      // This is explicit test-owner reconciliation, NOT automatic production recovery/release.
      expect(recoverOrdinaryApplicationTest(lostController.request, null).quarantine_required).toBe(
        true
      );
    } finally {
      lostController.close();
    }
    const duplicate = containerFixture({ root, config });
    try {
      const first = await duplicate.run();
      expect(first.status).toBe("completed");
      const guards = duplicate.events.length;
      const second = await duplicate.run();
      expect(second).toMatchObject({
        status: "incomplete",
        execution: "UNKNOWN",
        quarantine_required: true,
        reason: "recovery_requires_exact_cache",
      });
      expect(duplicate.events.length).toBe(guards);
    } finally {
      duplicate.close();
    }
    expect(recoverOrdinaryApplicationTest(crashed.f.request, null)).toMatchObject({
      execution: "UNKNOWN",
      quarantine_required: true,
    });
    expect(existsSync(sentinel)).toBe(true);
  },
  240_000
);

it.runIf(configPath !== undefined)(
  "real unchanged Node/PHP images have exact minimal loader environment; synthetic effective-env injection is stopped before start",
  async () => {
    if (configPath === undefined) throw new Error("Explicit caller config required");
    const supplied = validateContract(
      OrdinaryApplicationContainerConfigSchema,
      JSON.parse(readFileSync(configPath, "utf8")),
      "caller native environment config"
    );
    const root = privateContainerFixtureRoot();
    const workspace = path.join(root, "containers");
    const cli = path.join(root, "independent-cli");
    mkdirSync(workspace, { mode: 0o700 });
    mkdirSync(cli, { mode: 0o700 });
    writeFileSync(path.join(cli, "config.json"), "{}", { mode: 0o400 });
    const config = { ...supplied, workspace_parent: workspace };
    writeFileSync(path.join(root, "host-config.json"), canonicalJson(config), { mode: 0o600 });
    console.info(`Native loader environment evidence retained at: ${root}`);
    const fixed = [
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "HOME=/tmp",
      "TMPDIR=/tmp",
      "LANG=C.UTF-8",
      "HOSTNAME=application-test",
    ].sort();
    const fixedJson = JSON.stringify(fixed);
    const proof: unknown[] = [];
    const control = async (args: string[]) => {
      const response = await ordinaryApplicationDockerCommand({
        executable: config.docker.path,
        argv: ["--config", cli, "--host", `unix://${config.daemon_socket}`, ...args],
        signal: new AbortController().signal,
        timeout_ms: 5000,
        output_bytes: 1_048_576,
        input: Buffer.alloc(0),
      });
      proof.push({
        args,
        ...response,
        stdout: response.stdout.toString("base64"),
        stderr: response.stderr.toString("base64"),
      });
      writeFileSync(path.join(root, "environment-proof.json"), canonicalJson(proof), {
        mode: 0o600,
      });
      expect(response).toMatchObject({ exit_code: 0, failure: null, terminated: true });
      return response;
    };
    const keys = ["LD_PRELOAD", "NODE_OPTIONS", "ARBITRARY_NEW_BENIGN_NAME"];
    const previous = keys.map((key) => process.env[key]);
    process.env.LD_PRELOAD = "/must-not-load.so";
    process.env.NODE_OPTIONS = "--import=/must-not-import.mjs";
    process.env.ARBITRARY_NEW_BENIGN_NAME = "must-not-forward";
    try {
      for (const interpreter of ["node", "php"] as const) {
        const harness =
          interpreter === "node"
            ? `import fs from 'node:fs';import {render} from '../source/target.mjs';
const loader=fs.readFileSync('/proc/1/environ','utf8').split('\\0').filter(Boolean).sort();
const env=Object.entries(process.env).map(([k,v])=>k+'='+v).sort();
if(JSON.stringify(loader)!==JSON.stringify(${fixedJson}) || JSON.stringify(env)!==JSON.stringify(${fixedJson}))process.exit(2);
const s=fs.readFileSync('/proc/self/status','utf8');if(process.getuid()!==65534 || !/^NoNewPrivs:\\s+1$/m.test(s) || !/^Seccomp:\\s+2$/m.test(s) || !/^CapEff:\\s+0+$/m.test(s))process.exit(3);
if(fs.existsSync('/var/run/docker.sock') || fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim()!=='536870912')process.exit(4);
const safe=render('<script>')!=='<script>';if(!safe)process.exit(5);
process.stdout.write(JSON.stringify({loader_env:loader,process_env:env,source_safe:safe}));`
            : `<?php require '../source/target.php';
$loader=array_values(array_filter(explode("\\0",file_get_contents('/proc/1/environ'))));sort($loader);
$env=[];foreach(getenv() as $k=>$v)$env[]=$k.'='.$v;sort($env);
$fixed=json_decode('${fixedJson}',true);if($loader!==$fixed || $env!==$fixed)exit(2);
$s=file_get_contents('/proc/self/status');if(!preg_match('/^Uid:\\s+65534\\s/m',$s) || !preg_match('/^NoNewPrivs:\\s+1$/m',$s) || !preg_match('/^Seccomp:\\s+2$/m',$s) || !preg_match('/^CapEff:\\s+0+$/m',$s))exit(3);
if(file_exists('/var/run/docker.sock') || trim(file_get_contents('/sys/fs/cgroup/memory.max'))!=='536870912')exit(4);
$safe=render('<script>')!=='<script>';if(!$safe)exit(5);
echo json_encode(['loader_env'=>$loader,'process_env'=>$env,'source_safe'=>$safe]);`;
        const f = containerFixture({ root, config, interpreter, harness });
        try {
          const result = await f.run();
          proof.push({ interpreter, case_root: f.root, request: f.request, result });
          writeFileSync(path.join(root, "environment-proof.json"), canonicalJson(proof), {
            mode: 0o600,
          });
          expect(result).toMatchObject({
            status: "completed",
            execution: "RUN",
            passed: true,
            cleanup: "proved",
            quarantine_required: false,
          });
          expect(result.stderr_base64).toBe("");
          const observed: unknown = JSON.parse(
            Buffer.from(result.stdout_base64, "base64").toString()
          );
          expect(observed).toEqual({ loader_env: fixed, process_env: fixed, source_safe: true });
          const receipt = validateContract(
            Type.Object(
              {
                events: Type.Array(
                  Type.Object(
                    {
                      argv: Type.Array(Type.String()),
                      response: Type.Object(
                        { stdout: Type.String() },
                        { additionalProperties: true }
                      ),
                    },
                    { additionalProperties: true }
                  )
                ),
              },
              { additionalProperties: true }
            ),
            JSON.parse(Buffer.from(result.raw_receipt_base64, "base64").toString()),
            "loader receipt"
          );
          const imageEvent = receipt.events.find((event) => event.argv[0] === "image");
          const createdEvent = receipt.events.find(
            (event) => event.argv[0] === "container" && event.argv[1] === "inspect"
          );
          const create = receipt.events.find((event) => event.argv[1] === "create");
          if (imageEvent === undefined || createdEvent === undefined || create === undefined)
            throw new Error("Missing pre-start evidence");
          const image = validateContract(
            Type.Object(
              {
                Id: Type.String(),
                Config: Type.Object(
                  { Env: Type.Array(Type.String()) },
                  { additionalProperties: true }
                ),
              },
              { additionalProperties: true }
            ),
            JSON.parse(Buffer.from(imageEvent.response.stdout, "base64").toString()),
            "unchanged local image"
          );
          const effective = validateContract(
            Type.Object(
              {
                Image: Type.String(),
                Config: Type.Object(
                  { Env: Type.Array(Type.String()) },
                  { additionalProperties: true }
                ),
                State: Type.Object({ Status: Type.String() }, { additionalProperties: true }),
              },
              { additionalProperties: true }
            ),
            JSON.parse(Buffer.from(createdEvent.response.stdout, "base64").toString()),
            "effective loader environment"
          );
          expect(image.Id).toBe(config.images[interpreter]);
          expect(effective.Image).toBe(image.Id);
          expect(effective.State.Status).toBe("created");
          const fixedNames = new Set(fixed.map((entry) => entry.split("=")[0]));
          const unsetNames = image.Config.Env.map((entry) => entry.split("=")[0]).filter(
            (name) => !fixedNames.has(name)
          );
          // Bare names are daemon unset markers, not NAME= or inherited image values.
          expect(effective.Config.Env.slice().sort()).toEqual([...unsetNames, ...fixed].sort());
          for (const entry of image.Config.Env)
            expect(create.argv).toContain(`--env=${entry.split("=")[0]}`);
          proof.push({
            interpreter,
            image_env: image.Config.Env,
            effective_env: effective.Config.Env,
            observation: observed,
          });
          const absent = await control([
            "container",
            "ls",
            "--all",
            "--no-trunc",
            "--filter",
            `name=^/penny-app-${result.request_sha256}$`,
            "--format",
            "{{.ID}}",
          ]);
          expect(absent.stdout.length).toBe(0);
        } finally {
          f.close();
        }
      }
      let started = false;
      const tamper: OrdinaryApplicationDockerRunner = async (command) => {
        if (command.argv.includes("start")) started = true;
        const response = await ordinaryApplicationDockerCommand(command);
        if (
          command.argv[4] === "container" &&
          command.argv[5] === "inspect" &&
          response.exit_code === 0
        ) {
          const object = validateContract(
            Type.Object(
              {
                Config: Type.Object(
                  { Env: Type.Array(Type.String()) },
                  { additionalProperties: true }
                ),
              },
              { additionalProperties: true }
            ),
            JSON.parse(response.stdout.toString()),
            "synthetic native daemon-object tamper"
          );
          proof.push({ genuine_inspect_stdout_base64: response.stdout.toString("base64") });
          object.Config.Env.push(
            "ARBITRARY_NEW_BENIGN_NAME=must-reject",
            "LD_PRELOAD=/must-not-load.so",
            "NODE_OPTIONS=--import=/must-not-import.mjs"
          );
          return { ...response, stdout: Buffer.from(canonicalJson(object)) };
        }
        return response;
      };
      const f = containerFixture({ root, config });
      try {
        const result = await f.run(tamper);
        proof.push({ synthetic_effective_env_tamper: true, case_root: f.root, result, started });
        expect(result).toMatchObject({
          status: "incomplete",
          execution: "UNKNOWN",
          cleanup: "proved",
          quarantine_required: false,
        });
        expect(started).toBe(false);
        expect(
          f.events.some(
            (event) => typeof event === "object" && event !== null && "accepted" in event
          )
        ).toBe(false);
        const absent = await control([
          "container",
          "ls",
          "--all",
          "--no-trunc",
          "--filter",
          `name=^/penny-app-${result.request_sha256}$`,
          "--format",
          "{{.ID}}",
        ]);
        expect(absent.stdout.length).toBe(0);
      } finally {
        f.close();
      }
    } finally {
      keys.forEach((key, i) => {
        const value = previous[i];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
      writeFileSync(path.join(root, "environment-proof.json"), canonicalJson(proof), {
        mode: 0o600,
      });
    }
  },
  60_000
);
