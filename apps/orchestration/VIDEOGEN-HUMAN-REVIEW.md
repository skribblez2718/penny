# Review an exact final candidate

The local viewer plays the current master without changing its frames, PCM audio,
codecs, captions, rights checks or native-project admission. It cannot approve a
film. A separate parent-process driver records an actual user's answer through the
existing trusted interactive questionnaire.

**No production viewing or human approval is established by the tests.** Synthetic
MP4 bytes, native evidence and signed test events are protocol fixtures, not a
finished film or authenticated watch proof.

## Open playback

Build the orchestration package using its existing build command. With
`PROJECT_ROOT`, `OPERATOR_PROJECT_ROOT`, `PRIVATE_RUNTIME_MANIFEST` and
`PRIVATE_VIEWER_REQUEST` supplied by the caller:

```sh
export PENNY_VIDEOGEN_RUNTIME_MANIFEST_FILE="$PRIVATE_RUNTIME_MANIFEST"
node "$PROJECT_ROOT/apps/orchestration/dist/videogen-human-review-cli.js" \
  --request-schema
node "$PROJECT_ROOT/apps/orchestration/dist/videogen-human-review-cli.js" \
  --serve --project-root="$OPERATOR_PROJECT_ROOT" < "$PRIVATE_VIEWER_REQUEST"
```

The closed request supplies `run_id`, `master_file` (`path`, `sha256`, `max_bytes`),
`playback_device_profile_ref`, `expiry_ms`, `max_requests` and `max_served_bytes`,
plus schema identity `penny.videogen-human-review-viewer-request.v1`, version `1`.
The exact run must already be waiting for final playback or G5. The device profile
is an existing artifact describing the actual operator's playback setup, not a
model-invented default. The file must be caller-supplied, canonical, owner-only,
single-link and nonsymlink. Its digest and length must match the selected master.
The package manifest must bind that exact master and native project.

The command prints a private read-only URL at `127.0.0.1` on an OS-assigned port.
Open it yourself. Nothing opens a browser or starts playback automatically. Keep
the URL private: it permits reading the film but grants no review authority. Do not
publish, proxy, tunnel or share the listener. Ctrl-C closes it; expiry also closes
active HTTP connections. No new framework, asset fetcher or remote service is used.
Opening the existing service may materialize immutable runtime-manifest artifacts;
it does not install policy, render media or start workers.

Watch the entire film with sound and assess image, audio, captions, overall quality,
motion, speech, synchronization and identity consistency. The original burned-in
captions remain visible in the master. The page also displays the package's caption
source text as a transcript; a structured subtitle source may include its headers.
That text does not certify timing, accuracy or visual caption placement.

Every answer starts blank. Supply identity, role and free-text issues (write “none”
if none). **Prepare response — not approval** creates only a local draft to copy.
The page saves nothing and sends no POST. Do not treat clicking that button,
reaching the end, elapsed time or a JavaScript event as proof of human viewing.

## Record the actual user's answer in running Pi

Use the existing registered `skill` tool in a trusted interactive Pi session. The
host must already have the explicit private runtime manifest or constructor binding;
this route does not configure or activate it. Recover the caller's exact run:

```text
skill({skill_name: "videogen", session_id: "<exact run ID>", goal: "<original brief>"})
```

1. At the final-playback clarification, the native tool result supplies a one-time
   `trustedTransportCapability`. Invoke `questionnaire` with that exact capability,
   not model-written `questions`. No viewer opens until the actual user supplies
   the private master-file path and playback setup in that questionnaire.
2. Supply its closed JSON inputs: `master_file_path` plus either an existing exact
   `playback_device_profile_ref`, or `playback_device_profile` containing actual
   `display`, `audio_output` and `player` descriptions. Unknown details require
   cancellation, not invented phone, speaker or headphone defaults. The descriptor
   must still match the selected master's exact bytes and private-file checks.
3. The questionnaire's native completion returns a real read-only loopback URL and
   a **new** one-time review capability in its tool result. Open the URL yourself,
   watch the entire exact film with sound, and complete the local viewer draft.
   Invoke the existing `questionnaire` with the new capability and personally paste
   that complete response. A model must never prepare or answer the review for you.
4. Only after the real interactive UI returns does the questionnaire sign its
   event. Its registered in-process completion calls the retained closed
   `prepareVideogenHumanReview(...).submit` function automatically. There is no
   Bash/JavaScript subprocess, model-facing signing tool, extra key or manual
   maintainer function call in this route.
5. A negative, uncertain, incomplete, unheard or cancelled response leaves the run
   blocked with no captured positive playback ref. A fully positive response
   persists the audit and playback record, rechecks the current candidate and calls
   the existing `captureVideogenPlaybackForRun` synchronously in the retained owner.
   The result reports the exact refs. The viewer then closes.
6. **The original engine clarification still needs its separate `GateDecisionV1`
   response over the original packet. G5 then requires a separate actual human
   approval of its exact current packet.** Neither setup nor playback completion
   answers either gate, dispatches work, publishes media or fabricates a master.

`playbook-ui.ts` supplies a fixed compiled provider mapping at the existing generic
`await_user` route. This is a machine interface, not keyword routing or another
workflow runtime. Other waits retain ordinary clarification behavior. The default
extension factory registers it; an additional extension/provider installation is
not needed. The service and prepared submission closure stay alive in the same Pi
realm until completion, cancellation, expiry or session shutdown. Concurrent skill
continuation of that run is refused while the questionnaire owns it. Restart/reload
revokes old capabilities; recover the unchanged durable wait to request a new one.
Noninteractive, RPC and untrusted-project invocations do not open this native route.

The submission verifies the existing execution-owner signature, original question
digest, transport ref, challenge, candidate digest, device ref, time, closed answers
and current selection. No signature is created before actual interactive input.
The standalone CLI above remains **viewer-only**: launching it through Bash cannot
submit a response to the parent Pi execution-owner realm.

Records distinguish trusted interactive transport from self-declared identity and
unauthenticated watch claims. A signature proves transport custody, not legal
identity, authorized operator role or actual viewing. The caller must enforce its
operator policy. This in-process route does not isolate hostile same-UID code or
already-trusted extensions; those require a separate trusted operator environment.

The closed submit function writes unselected audit artifacts and rechecks before
and after persistence. The registered callback then captures with no intervening
`await`. A stale candidate refuses rather than overwriting a selected revision.
The unchanged capture API is not a cross-process atomic compare-and-set protocol;
independent external checkpoint writers must remain excluded. G5 waits are never
intercepted for capture. Already recorded audit artifacts remain private and durable.

## Bounds and security

- Only exact viewer HTML, compiled CSS/JS and `master.mp4` routes exist. There is no
  file selector, listing, native-project download, URL proxy or arbitrary asset route.
- All POSTs, including same-origin JSON, are refused before body processing. Thus
  there is no browser mutation requiring CSRF authority. Foreign Origin/Fetch
  Metadata and unexpected Host values are refused; no CORS permission is granted.
- The MP4 is opened once with no-follow flags. Descriptor identity, private mode,
  size and SHA-256 are checked. Outgoing bytes come from the same bounded snapshot
  that was hashed, never a path reopened after hashing. Fresh descriptor/hash checks
  reject drift on each request. An in-place writer cannot alter an outgoing buffer.
- Single byte ranges, suffix ranges and HEAD are supported. Multi-range, malformed,
  encoded/traversing and query-bearing targets are refused. Exact current candidate
  checks apply on each read, including assets. An already-sent snapshot remains the
  old exact bytes; stale submission is refused independently.
- Hard ceilings: 512 MiB input file, 4 concurrent connections, 4,096 requests,
  16 GiB aggregate output budget and 24-hour viewer expiry. The caller selects
  tighter limits. Expiry must allow the film plus at least a minute. The existing
  trusted questionnaire has a 30-minute lifetime; longer reviews need a different
  trusted transport and are not supported by this driver.
- Browser policy denies framing, external assets, connections, workers, forms and
  caching. There are no cookies, browser persistence, analytics or network writes.
  HTTP errors expose neither filesystem paths nor signed human events.
- Playback diagnostics union consistent reported ranges and exclude seek, muted,
  hidden, paused, non-normal-speed and inconsistent intervals. They are bounded,
  local and untrusted. They cannot fill an answer, create a record or approve.
- Close the viewer immediately if its URL leaks or its source changes. Reopen only
  with the current exact bindings. Preserve private audit records for investigation;
  apply the caller's retention policy for identities, roles and reported issues.

## Verification and remaining checks

Focused suites cover HTTP bytes/ranges, hash and inode drift, headers/origin checks,
traversal, every rejected POST type, expiry, budgets, shutdown, unsigned/tampered
responses, missing answers, negative categories, replay, challenge expiry,
same-byte revision races and actual G1–G5 engine binding over synthetic products.
The registered-path E2E also drives actual questionnaire UI/editor input, the realm
signer, completion callback and existing capture. It reaches an unanswered G5 only
after a separate synthetic engine clarification. Another test uses the unmodified
default extension factory and explicit private JSON manifest with a seeded synthetic
playback wait. These are offline protocol tests, not production viewing. The CLI is
separate; `videogen-runtime-cli.ts` is unchanged by this work.

The layout uses native labeled controls, visible focus, a skip link, one H1, live
status messages, high-contrast light/dark styles, reflow and no autoplay or animation.
Automated DOM/keyboard checks are not a screen-reader audit. Before release, perform
an actual browser/media compatibility check with the production candidate, a WCAG
A/AA audit and an assistive-technology walkthrough. No real human watch, authenticated
operator identity, legal clearance or production approval is claimed here.
