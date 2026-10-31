# SCA reference

## Public runtime boundary

`SCA_PLAYBOOK_REGISTRATION` and `SCA_FLOW` in `apps/orchestration/src/playbooks/sca.ts` define the public ordinary skill. The descriptor-backed `flow.html` mirrors its topology. [SKILL.md](../SKILL.md) carries the generated request/I/O schema; [README.md](../README.md) explains verification scope.

This is the implemented scanner/graph→focused selection→hypothesis→evidence→disposition→learning→report path, not the retired two-full-source-primary workflow or a plan for a future cutover. Qualification/activation helpers may remain for historical independent experiments. They do not route public invocations and are not ordinary prerequisites. Ordinary SCA analysis and its production-readiness assessment require no KVM access, VM image, guest assets, VM configuration or VM qualification. Docker is the current supported application-test containment path; optional legacy VM compatibility is not a prerequisite or a readiness gate.

## Admission and source custody

Supply one absolute source root, normalized repository-relative include/exclude paths, execution mode and `deepseek-flash`. An optional expected snapshot digest must match the captured bytes. Without it, the host computes the digest before analysis. No predecessor `input_artifacts` are accepted at caller ingress; intermediate dependencies are produced within this run.

The host captures regular files through no-follow descriptors and verifies stable identity/root containment. SHA-256 covers canonical `penny.sca-source-snapshot.v1`, schema version 1, normalized scope and lexically sorted `{path,byte_length,content_sha256}` records. The root is excluded so identical snapshots are portable. Binary/non-UTF-8 exclusions remain explicit gaps. Limits are 100,000 files, 2 MiB per file, 128 MiB captured source and 192 MiB framed corpus; exceeding a bound is not a silent clean scan.

Source/tool/model content is untrusted evidence. Source citations use complete repository-root paths, 1-based inclusive file lines and exact LF-joined quotes, never corpus framing offsets. Focused slices are bounded to at most 257 lines and 16 KiB per quote. The full corpus is a host operation input, not a mandatory dual-primary model input.

## Tools and configuration

`analysis_tools` optionally selects:

- `semgrep` and `gitleaks`: `{tool:{executable,sha256,version},rules_path,rules_sha256}`.
- `graph`: required `joern:{executable,sha256,version}`, optional `php_frontend`/`js_frontend` with the same tool shape, and 1–16 `{id,script_path,sha256}` queries.
- `advisory_results`: `{path,sha256}` for a current offline `penny.sca-osv-result.v1` document. Its own result hash, source snapshot, exact dependency-inventory digest, coordinate count, successful pagination and at-most-24-hour observation age are checked. This is caller-supplied offline advisory evidence, not a claim that this run queried OSV. Unresolved dependencies or absent/invalid/stale evidence remain material gaps.

Every path comes from the caller and must be absolute, NUL-free and outside the target tree, including canonical symlink resolution when the path exists. The process runner pins the executable digest and uses explicit argv/environment, no shell. Tools receive a disposable sealed source tree/scratch area, not permission to install dependencies, execute/build/boot the target, use credentials or perform network calls. Tool scripts/rules themselves must be trusted operator-selected analysis inputs; this is not an OS sandbox against a malicious installed analyzer.

The fixed sibling service-package build entry (`apps/sca-service/dist/ordinary-runtime.js`) connects the existing Semgrep/Gitleaks/process/dependency APIs from both orchestration source and build output; workspace-link hoisting is not required. Its ordinary-runtime bundle includes the existing PHP parser so Node does not need an undeclared service-local parser dependency. Build both packages; no daemon/bootstrap is required. Missing installation/configuration produces capability records with unavailable/unsupported/failed/partial status rather than empty successful scans. Dependency presence is an exposure lead, not an advisory or exploitability finding. No resolved external coordinates means no advisory match is needed; unresolved coordinates cannot use that exemption.

### Semantic CPG protocol

A frontend receives `[capturedSourceRoot,"--enable-file-content","--output",graphPath]`. A caller-selected Joern script receives `["--script",scriptPath,"--param","cpgFile=graphPath"]` and emits only this JSON to stdout:

```json
{
  "schema_version": 1,
  "complete": true,
  "files": [
    {
      "path": "src/handler.ts",
      "content_sha256": "<exact captured file SHA-256>",
      "status": "supported",
      "detail": "Actual frontend support result and limitations"
    }
  ],
  "rows": [
    {
      "title": "Observed semantic relation",
      "path": "src/handler.ts",
      "start_line": 1,
      "end_line": 3
    }
  ]
}
```

`status` is `supported`, `unsupported` or `failed`; `complete` is false for incomplete querying. Each query must account for exactly every source unit of that graph's language with matching hashes and no duplicates. Missing/unsupported/misbound files prevent completed capability coverage. A language absent from admitted scope needs no graph. Rows may legitimately be empty but cannot, by themselves, establish complete frontend support. Exact graph bytes/hash and bounded query observations are retained as immutable outputs. This protocol accounts for declared support and observed relationships—not independent proof that a frontend models every semantic edge correctly. Syntax parsing is never relabeled a semantic graph.

## Advanced operation admission

The optional `advanced` request is described in the generated caller schema and [README.md](../README.md). The private intake materializes run/project/snapshot-bound application plan/policy/input artifacts; cognition receives only selectors, supported source ranges and rule identities. Fixtures, independent truth, host paths, receipts and streams stay outside model inputs. At most 16 inputs per capability and 64 selected evidence actions are allowed; each native resource/input/output limit still applies.

`sca-ordinary-advanced-v1` implements four separate registered host declarations: `sca.application.v1`, `sca.validation.v1`, `sca.promotion.v1`, `sca.rescan.v1`. The shared HostOperationRuntimeOwner remains the only execution/custody owner. Native application and learning builds are fixed sibling package entries, not caller-selected module imports. Application uses the explicitly admitted Docker shared-kernel CONTAINER implementation or optional legacy VM backend; empirical execution uses the host-configured source-only runner above or a trusted independently confined embedding. A missing runner cannot fall back to ordinary host execution.

Public `sca-advanced-summary` binds operation/result/native hashes, validation and release hashes, revisions, execution/cleanup/quarantine and baseline preservation. Exact private validation/promotion records remain immutable artifacts. Its rescan finding count is not confirmation; nonzero counts create explicit new-investigation gaps. Both independent reviews must read and bind this summary. The cognitive `learning` block records proposal-time assessment, while `advanced` records subsequent host-observed operations; a quarantined proposal is not itself a promotion.

Recovery consumes exact cached bundles and rechecks native/result bindings. Uncached post-submission work is unknown/unproved and quarantined rather than replayed. Removing a cached result does not authorize a second mutation. Private retained workspaces require trusted operator cleanup; there is no model-exposed cleanup escape hatch.

## Normal host configuration

These files are host-private runtime settings, never skill constraints or model proposals. Every path and digest below comes from the host/caller; placeholders are not defaults. No setup, activation, credentials, permission changes, asset download or canonical-store change is implied.

### Empirical runner

Set `PENNY_SCA_ORDINARY_OFFLINE_CONFIG` to an absolute JSON file:

```json
{
  "kind": "trusted-analyzer-socket-denial-v1",
  "workRoot": "<canonical absolute owner-private existing directory>",
  "tracer": {
    "executable": "<absolute installed strace executable>",
    "sha256": "<exact executable SHA-256>",
    "version": "<host-observed version>"
  },
  "trusted_analyzers_only": true
}
```

The fixed installed `process.js` build entry supplies descriptor execution, bounded output, process-group cleanup, cancellation and renewable process inactivity. The ordinary composition separately seals the analyzer executable, then traces all descendants and injects `EPERM` for `socket` and `socketpair`. Trace diagnostics go to `/dev/null`; analyzer stdout/stderr and genuine exit status remain unchanged. Configuration and analysis-tool pins must identify trusted installed tools. Interpreter/library closure and filesystem access remain host-owned residual boundaries; do not use this profile for hostile analyzers or target/harness execution. If tracing is unavailable or its pin drifts, validation fails rather than running unconfined.

Caller `advanced.learning[]` retains its separate CLI `tool` and `baseline` pins, fixtures, independent truth and limits. Optional full offline validation uses:

```ts
const offline_validation = {
  python: { executable: callerPython, sha256: pythonSha256, version: pythonVersion },
  core: { executable: callerCore, sha256: coreSha256, version: cliVersion },
  core_library_directory: callerLibraryDirectory, // optional, outside target
  metachecks: {
    rules_path: callerRetainedJsonBundle,
    rules_sha256: metacheckBundleSha256,
    rule_ids: exactApprovedMetacheckIds,
  },
};
```

Host admission compares these exact fields with the original caller bytes. The model cannot supply pins, grants or fixture truth. Full offline mode requires at least `2 + 2 * fixtures.length` process slots: **20 for nine cases**. Receipts preserve `validate_schema`, core `validate`, nine `test` and nine independent `scan` stages. Without offline pins the original CLI-only path remains fail-closed if remote validation would be needed. The inert single-rule JSON grammar permits optional closed `metadata: {category, technology}` and no plugin, validator or executable fields. Promotion and rescan remain separate caller grants, not process-slot side effects.

### Application runtime

Set `PENNY_SCA_ORDINARY_APPLICATION_CONFIG` to an absolute JSON file matching the exported `OrdinaryApplicationRuntimeConfigSchema`. For the current supported Docker path, use:

```json
{
  "schema_id": "penny.sca-ordinary-application-container-config.v1",
  "schema_version": 1,
  "kind": "docker",
  "isolation": "container",
  "profile": "docker-local-no-network-v1",
  "workspace_parent": "<canonical existing owner-private directory>",
  "docker": {
    "path": "<canonical installed Docker executable>",
    "sha256": "<exact executable SHA-256>",
    "size_bytes": 1
  },
  "daemon_socket": "<canonical local Unix socket>",
  "images": {
    "php": "sha256:<64 lowercase hex digits of an already local image>",
    "node": null
  }
}
```

Placeholders and the illustrative size are not usable pins. Each image is independently an exact immutable local ID or null (unsupported interpreter). The host must review image suitability/secret-freedom; pinning alone does not establish it. The workspace is canonical, owned by the non-root invoking user and mode 0700. Executable/socket identity and effective daemon policy are checked by the native module; no image acquisition or permission changes are implicit.

Optional legacy VM compatibility accepts `{kind: "qemu-kvm", vm: originalVmConfig}` instead; `PENNY_SCA_ORDINARY_APPLICATION_VM_CONFIG` still takes the original VM config. Its actual VM execution branch retains all VM pin, guest, lock and KVM preflights. The separate `penny-sca-service` VM broker executable still requires its own `PENNY_SCA_SERVICE_VM_CONFIG`; neither that executable nor its qualification is required by ordinary `sca`. Both environment aliases together, or both embedding `applicationRuntime` and `applicationVm`, are rejected. No backend is a default or fallback. Missing application runtime refuses only requested application execution, not ordinary analysis; absent application actions need no runtime. Explicit invalid/stale or ambiguous host configuration still rejects service construction. Model content cannot choose a socket, image, executable, host environment or backend.

Caller `advanced.application_tests[]` omitted/`vm` isolation preserves V1 resources with `vm_timeout_seconds`. Container consent requires `isolation: "container"`, exact `profile: "docker-local-no-network-v1"` and the closed native resource/maxima shape with `operation_timeout_seconds` instead. Intake emits plan/policy V2 bodies **and** matching V2 artifact metadata; the request stays V1. Test timeout must be strictly below operation timeout and all requested values must be within independently admitted maxima. Closure includes the exact source corpus, harness, test inputs and stdin. VM consent never authorizes Docker.

Docker is explicitly **CONTAINER**, not VM isolation: shared host kernel, local daemon trust, fixed no-network/read-only/non-root/cap-drop/no-new-privileges profile and native effective-policy inspection. No source checkout, credentials or control socket is mounted in the workload. Created-container acknowledgement journals acceptance, not proof the interpreter ran. The canonical owner retains exact receipts and ambiguous acceptance/cleanup quarantine; recovery consumes exact cached bytes only and never reruns uncertain work. Raw streams remain private, while sanitized summaries retain isolation and evidence scope. A passing test is not vulnerability or isolation attestation.

### Model disclosure and cost

Set `PENNY_SCA_ORDINARY_MODEL_CONFIG` to an absolute host-private JSON file conforming to exported `ScaModelDisclosureConfigSchema`. This is a normal host setting, not a skill constraint. When adding the setting or changing runtime code in an already-running Pi session, use `/reload` before invoking the skill; exporting a variable in a Bash child cannot configure the parent Pi process.

Invoke the actual registered tool with `session_id` equal to that configuration's exact `scope.run_id`. The source, captured snapshot and goal must also match the configured disclosure scope:

```ts
skill({
  skill_name: "sca",
  session_id: exactRunId,
  goal: exactCallerGoal,
  constraints: {
    schema_version: 1,
    source_root: callerSourceRoot,
    scope: callerScope,
    execution_mode: "static_only",
    model: "deepseek-flash",
  },
});
```

The production engine dispatches registered workers through isolated Pi SDK sessions and forwards phase/worker progress as tool updates. Direct `subagent` calls, an embedded test harness and manually constructed services are not substitutes for verifying this invocation path. Missing native-tool configuration must remain explicit capability gaps; do not fill them with fixture observations.

For trusted embeddings only, the equivalent host dependency is:

```ts
new OrchestrationService({
  projectRoot,
  playbookName: "sca",
  scaModel: {
    config: {
      schema_version: 1,
      scope: {
        project_root: projectRoot,
        run_id: exactRunId,
        source_root: callerSourceRoot,
        source_snapshot_sha256: capturedSnapshotSha256,
        purpose: exactCallerGoal,
      },
      destination: exactChatCompletionsUrl,
      disclose_full_transcript: true,
      limits: {
        calls: operatorPolicy.calls,
        callsPerSession: operatorPolicy.callsPerSession,
        routingRepairSessions: operatorPolicy.routingRepairSessions,
        inputBytesPerCall: operatorPolicy.inputBytesPerCall,
        outputTokensPerCall: operatorPolicy.outputTokensPerCall,
        totalOutputTokens: operatorPolicy.totalOutputTokens,
        totalOutputBytes: operatorPolicy.totalOutputBytes,
        inactivityMs: operatorPolicy.inactivityMs,
      },
    },
    admit(fullTranscriptOrSerializedRequest, invocation) {
      hostDisclosurePolicy(fullTranscriptOrSerializedRequest, invocation);
    },
  },
});
```

Derive values from actual operator policy, not test constants or model guesses. `operatorPolicy` above denotes the actual host-admitted settings, not a new runtime API or a source of defaults. Include optional fields only when that policy supplies them. The required `limits.inactivityMs` is a renewable lease, not a total-work deadline. The seven call/session/input/output allowances shown above are optional positive safe integers; omission imposes no corresponding allowance, and explicit null or malformed values reject. No test-cohort values become runtime defaults. This does not remove operator-supplied call, repair-session, disclosure or cost controls. Use the exported `ScaModelDisclosureConfigSchema` for the exact required fields. The guard records actual HTTP attempts (including summaries and repairs), enforces supplied allowances and reserves the actual serialized per-request output ceiling against any supplied aggregate token policy. If an aggregate token policy exists but the provider payload has no output ceiling, dispatch refuses rather than guessing a reservation. With no host per-request output limit, SDK/provider capability settings remain unchanged. Input bytes and conservative input-token upper bounds are observational receipts, not a cumulative usage ceiling. For deprecated legacy host input only, optional positive safe-integer `limits.totalInputTokens` is accepted and normalized away by the shared environment/embedding parser; it is ignored, never enforced. Existing private configuration files need no rewrite; other unknown or invalid fields still reject. It checks the complete transcript and serialized request before HTTP delegation, exact destination/method/model/output ceiling, concrete response identity and streamed output. Only trusted productive activity renews inactivity; there is no total productive-work deadline.

Full-transcript consent is deliberately broader than source-only consent: it includes prompts, all prior messages and tool results. Do not set it for private inputs without that exact authority. Absent consent, wrong project/run/root/snapshot/purpose, altered destination or failed narrower admission denies cloud use. A pre-dispatch policy denial follows the existing durable negative/cancellation path and terminal recovery does not replay it. Host-supplied `modelClient` remains a trusted embedding dependency and must enforce equivalent boundaries if it contacts a provider.

The default SCA service registers the real exact artifact reader from its installed build helper with host-bound store/environment. It does not depend on ambient extension discovery, a target checkout extension, or a custom model client. Native SDK automatic compaction is enabled. Before SDK serialization truncates tool results or flattens them into user plaintext, the original session messages must pass exact artifact and host disclosure admission. Rejected/error tool output is not admitted to summarization, including host-observed reader feedback that ordinary turns may otherwise use to correct a call. The full normalized summary context and serialized HTTP payload remain independently guard-checked. Returned streams enforce response identity, output bytes/tokens and renewable inactivity for ordinary turns and `.result()`-consumed summaries without double charging. SDK summary cancellation and invocation/guard cancellation are combined. Custom summarization hooks and alternate summary models are not admitted. A prior approved summary can continue under the same scope, but cannot establish complete assigned-byte reads or evidence provenance.

Malformed routing remains rejected and uses the separate policy-controlled **routing-only** repair, binding the exact malformed artifact and signed receipt; it cannot rewrite semantic output. Separately, known stage schema/cross-field failures use a registered **same-stage semantic revision**. Fresh drafts permitted by actual operator policy receive all original exact input refs, the exact rejected attempt and a closed typed diagnostic. The shared run-wide repair counter charges semantic and report repair together; there is no hidden per-stage two-revision default. Diagnostic `revision_limit` is null when no count policy was supplied, otherwise the operator evaluator allowance minus its initial reserved attempt. Earlier two-revision diagnostics remain readable, not a default for new work. It identifies the failure location and only necessary already-admitted IDs, expected pointer or permitted ranges; private config and arbitrary rejected values are not copied into feedback. Each complete response is freshly captured and all validators rerun without quote normalization, candidate deletion or host-authored conclusions. Accepted predecessors/external operations are not rerun; custody and host failures do not trigger cognitive rerolls. Exhaustion is INCOMPLETE, with each rejected attempt preserved through private diagnostic lineage. A changed report input set starts a separate input-bound epoch; old diagnostics cannot authorize a stale draft.

## Ordinary states and owners

1. `intake`: host admission, source capture and exact request/corpus artifacts.
2. `preparing_analysis`: registered host operation; scanners, dependencies, optional offline advisories, semantic graphs and bounded queries.
3. `selecting_scanner_dependency_leads`: Annie partitions every deterministic lead into focused selection or explicit deferral.
4. `selecting_underdetected_no_alert_surfaces`: Echo independently accounts for indexed no-alert surfaces. Host materializes exact focused source slices.
5. `forming_hypotheses`: Ida supplies claims, violated invariants, ALL-CAPS `{THREAT-ID}` references, exact support, falsification tests, expected supporting/refuting observations and unknowns. Every selection is accounted for.
6. `challenging_hypotheses`: Annie supplies alternatives, concrete counterevidence and missing links for every hypothesis.
7. `selecting_evidence_actions`: Demetri selects bounded source/graph/application-test/defer actions for every hypothesis, each with a discriminating observation.
8. `gathering_evidence` then `running_application_tests`: exact source/graph observations, then separately registered isolated application operations selected from the admitted plan catalog. Without exact plan/policy: NOT RUN. Failed/unavailable/deferred/UNKNOWN actions remain unresolved.
9. `adjudicating_evidence`: Vera assigns exactly one `confirmed_code`, `refuted`, `probable`, `theoretical`, `duplicate`, `out_of_scope` or `inconclusive` disposition per hypothesis. Concrete refutations, valid acyclic duplicate relations and completed discriminating evidence are checked.
10. `reconciling_dispositions`: host candidate/hypothesis/evidence reconciliation; AI-only findings and non-findings are retained.
11. `assessing_learning` then `validating_learning`, `promoting_learning`, `rescanning_learning`: account for every confirmed-code issue, including no-rule/no-eligible/deferred outcomes. Independently admitted fixtures—not model expectations—control empirical validation. Promotion and rescan each require separate caller operands and exact saved predecessor records. The original baseline is never changed; rescan findings are new unconfirmed investigation revisions.
12. `materializing_report`: Skribble drafts every reportable issue, with full narrative, evidence, remediation, metric rationale and explicit missing material.
13. `rendering_report`: host exact-citation/structural/scoring checks and one accepted set→canonical JSON/Markdown/SARIF/validation artifacts.
14. `reviewing_report`: Carren reviews meaning, evidence and quality against separately captured sources/evidence, not headings alone.
15. `verifying_final_product`: Vera independently verifies the latest report and representations, execution truth, counterevidence, CVSS semantics, reconciliation, learning and limits.
16. `complete`, `incomplete` or `cancelled`: terminal with exact output manifest. Actionable review GAPs return to report drafting under the actual operator repair policy, with no invented finite allowance; both reviews run fresh after rendering. Exhaustion is non-positive and retains the best report.

All cognitive phases use exactly `ollama/deepseek-v4.1-flash:cloud` and only registered `artifact_read`. Host operations own analyzer execution; agents cannot bypass their policy with tool calls or commands in prose. Operation requests bind run ID, source snapshot and every exact input digest. The host result cache/journal/leases own custody and recovery. Productive process output or observed kernel progress renews inactivity; there is no fixed total elapsed-work cutoff. Output/resource limits and cancellation remain real.

## Selection draft representation

Both selection workers accept the existing per-ID draft unchanged, plus an optional closed `defer_remainder: {preparation_artifact_id, preparation_sha256, scope, reason}`. Copy the identity and **content_digest** of the exact current `sca-preparation-result` ref; the source snapshot digest is not a preparation digest. Scope is `leads` for scanner/dependency selection and `files` for no-alert selection. The declaration explicitly defers every preparation lead ID or file path not covered by that draft's selected claims or explicit deferrals. Earlier scanner selections do not account for no-alert file selection. Different deferral reasons remain explicit per-ID entries.

The host checks the binding, scope, foreign IDs, duplicate claims and selected/deferred disjointness before appending the complement in preparation order, with the model's shared reason unchanged. Multiple ranges in one selected file remain valid. Without the declaration, omission still fails exact per-ID accounting. Unknown fields, null/incomplete declarations and stale/foreign bindings reject; the host never silently defers or supplies a reason. Expansion must fit the unchanged canonical `ScaSelection` limits (including at most 512 deferred records), otherwise it rejects without truncating the index. The preparation still supports 512 leads and up to 100,000 indexed files; compact drafts do not enlarge canonical capacity.

Only worker draft admission changes. Accepted selections, downstream reconciliation and report verification remain exhaustive canonical products. Exact raw worker bytes and upstream preparation refs remain retained separately. The full immutable preparation and admitted source bytes remain available through exact `artifact_read` continuation, never replaced by a lossy summary. Offline real-engine regression coverage lives in `apps/orchestration/tests/sca-selection-remainder.test.ts`; it is not live-provider qualification.

## Report and acceptance

`penny.sca-report.v3` has product schema version 1. Canonical JSON, Markdown and SARIF derive from the same accepted set; the manifest binds their exact refs/digests and reviews. Reports contain identity/snapshot/scope, executive summary, tools/rules/graphs/queries/model/runtime, actual coverage/exclusions/obligations, findings, full candidate/disposition reconciliation, learning outcomes, threat mapping/chains, and exact evidence/scoring/validation references. SARIF carries full finding properties plus reconciliation/coverage/learning run properties; its representation notes disclose where long narrative lives.

Every finding has exactly five sections: severity-bearing Title, Description, Steps to Reproduce, Code Analysis and Remediation. Metadata under Title includes severity/score/nomenclature, vector, scoring rationale, CWE identifier and canonical name, supported status/evidence note, and threat mapping. Missing CWE, missing metrics or other retained incomplete material cannot pass COMPLETE. Partial findings remain visible with `⚠ INCOMPLETE — missing: …`.

CVSS v4 uses the pinned deterministic FIRST scorer, not model numbers or a keyword lookup. Metric rationale needs exact evidence. Discovery effort is not AC/AT; required configuration is scored present; deployment mitigations belong in Environmental; Base is retained separately from contextual scoring; final end-state impact is not speculative chain or delta impact. Severity and confidence are independent. Cross-finding chains require established composition, never invented chain scores. Semantic scoring correctness is independently reviewed, not proven merely by vector syntax or recomputation.

Confirmed-code findings require exact quotes and parser-supported initiation/propagation/effect witnesses. TypeScript and pinned `php-parser@3.7.0` (PHP 8.5 mode) perform source-only AST parsing; diagnostics and unsupported structural scopes do not become positive evidence. These checks are a structural floor, not attacker-control/reachability/impact proof. Refuted findings retain concrete mitigating source. No target/PoC execution or live impact is inferred. Without admitted isolated observations, runtime/reproduction is NOT RUN. An owner-validated container or legacy guest observation can establish RUN; ambiguous post-submission execution remains UNKNOWN, cleanup unproved and quarantine explicit. Neither a test pass nor exit=0 establishes exploitability.

Reproduction must use known safe interfaces, inputs and environment facts only. Unknown deployment/credential/role state remains explicit, not a fabricated endpoint or command. Sensitive values/operator paths are withheld; withholding that reduces proof/copy-paste reproducibility marks the public report INCOMPLETE. Findings, candidates and dispositions are not silently removed to make a report pass.

Terminal delivery keeps the shared directive's existing diagnostic count and string limits. Lists that fit remain inline unchanged. Oversized lists use one exact artifact ID/digest and JSON pointer: `/gaps` in the canonical report only when it equals the supplied diagnostic array exactly, otherwise `/unresolved` in the closed output manifest. The manifest retains the complete ordered diagnostics and exact output refs; no truncation, candidate deletion, new approval or change to COMPLETE eligibility is implied. Read the referenced artifact through `next_range` until complete.

Review binds the exact report ID/digest and supplied evidence IDs, including captured evidence-result, focused source and the advanced summary when supplied, not author approval or another model's agreement. PASS cannot contradict failed checks/issues or deterministic representation validation. A faithful INCOMPLETE representation may pass review while assessment remains INCOMPLETE. COMPLETE additionally requires no unresolved required material and the full registered state path. Neither means vulnerability absence or mechanical proof of natural-language correctness.

## Verification and maintenance

Keep inspected records separate from freshly rerun checks. Offline engine/SDK/scanner executable fixtures prove their stated local integration boundary, not live model quality or genuine Semgrep/Gitleaks/Joern semantic fidelity. VM absence is not a readiness blocker; removing that prerequisite is not production-readiness evidence. Fresh live DeepSeek completion through independent final review remains unverified here. Build/typecheck/format/lint/architecture and affected suites should be rerun; required failures/skips/unrun checks remain visible. Native tools, network lookups, deployment and live provider checks require explicit separate authorization.

Update runtime documentation and descriptor-backed diagram with actual public behavior. Keep caller-private paths, deployment details and work ledgers outside tracked Penny files. This maintenance guidance is not a claim that an automatic updater, installed qualification or CI pass exists.

Known cognitive-stage self-revision and exhaustion edges are included in the descriptor-backed diagram. Uniform per-state cancellation, infrastructure failure and liveness edges are omitted for legibility. The shared engine still owns those fail-closed seams.
