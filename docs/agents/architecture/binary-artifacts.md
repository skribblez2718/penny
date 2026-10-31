# Binary Artifacts — exact canonical PNG delivery

## Boundary

The immutable artifact plane supports two model-facing read classes:

- textual media use the existing UTF-8 byte ranges and `next_range` continuation;
- canonical `image/png` media use one whole-image result containing bounded identity metadata and one Pi image content block.

The exact artifact ID remains the only locator. Binary reads add no list, search, path, cursor, materialization, or write surface. `ArtifactStore.readById()` remains responsible for manifest identity, byte-length, and SHA-256 verification before media parsing.

Unsupported binary media fails closed. PNG reads reject `range`; text wire output remains unchanged.

## Canonical PNG contract

`apps/orchestration/src/png-media.ts` is the shared implementation for artifact delivery and current host-side [imagegen admission](image-generation.md#constrained-comfyui-adapter). It accepts only static, non-interlaced, 8-bit grayscale, RGB, grayscale-alpha, or RGBA PNGs. It:

1. bounds source, compressed IDAT, decompressed scanline, dimensions, pixels, individual ancillary chunks, and aggregate ancillary bytes;
2. validates signature, chunk names/order/cardinality, CRCs, required chunks, and absence of trailing data;
3. rejects APNG, palettes, unknown critical chunks, invalid filters, malformed/trailing DEFLATE streams, and unsupported IHDR modes;
4. fully inflates and reverses PNG filters into exact RGBA pixels;
5. canonicalizes untrusted input to metadata-free RGBA with one IDAT and filter-zero rows; and
6. re-decodes the canonical output and verifies pixel equality before returning it.

Canonical artifacts contain only `IHDR`, one `IDAT`, and `IEND`. Compression bytes are not compared for equality, so compatible zlib updates do not invalidate stored artifacts; decoded pixels and the canonical chunk/filter shape are the stable contract.

Raw backend bytes must pass `sanitizePng()` before persistence as `image/png`. Artifact delivery uses `validateCanonicalPng()`/`canonicalPngImageContent()` and never sanitizes a stored artifact during read.

## Dependency and advisory posture

No new decoder package dependency is introduced. DEFLATE decode/encode uses Node's maintained built-in `node:zlib`; PNG structure, filters, subset conversion, and canonical shape are repository-owned TypeScript. zlib's permissive license is compatible with Penny's AGPL-3.0-only repository. The active zlib version is supplied by the Node runtime constrained by the orchestration package's engine floor; remediation therefore requires a Node runtime update, and npm advisory scanning is not a separate signal for this built-in module. Runtime security updates and the adversarial PNG suite are the maintenance controls.

Advisory qualification on 2026-09-16 observed Node v24.21.0 with zlib `1.3.2.1-motley-8002e91`. The applicable Node bulletin for `node:zlib` sync API denial of service, [CVE-2026-58045](https://nodejs.org/en/blog/vulnerability/july-2026-security-releases/), was fixed in Node v24.18.1; Penny's `>=24.21.0` engine floor is above that fixed release. Future Node security bulletins remain part of release qualification.

This avoids adding a second decoder package whose unbounded decode would need the same pre-parser. Revisit the decision if the supported PNG subset expands.

## Limits

Defaults are hard-bounded in code and may only be lowered with:

- `PENNY_PNG_MAX_SOURCE_BYTES`
- `PENNY_PNG_MAX_WIDTH`
- `PENNY_PNG_MAX_HEIGHT`
- `PENNY_PNG_MAX_PIXELS`
- `PENNY_PNG_MAX_COMPRESSED_BYTES`
- `PENNY_PNG_MAX_DECOMPRESSED_BYTES`
- `PENNY_PNG_MAX_ANCILLARY_CHUNK_BYTES`
- `PENNY_PNG_MAX_ANCILLARY_BYTES`

Invalid values or attempts to exceed process maxima fail configuration admission.

## Model capability binding

Image capability is derived only from Pi's resolved model metadata: the exact provider/model identity plus an `input` modality containing `image`. There is no provider or model-name allowlist.

`admitImageInputModel()` produces deterministic, persistable positive evidence. `recheckImageInputModel()` requires the same identity and current image-input support. `PiAgentClient` accepts this evidence on an invocation, rejects a drifted or text-only explicit override before session creation, and checks the final session model again before its first prompt. Missing or malformed capability metadata fails closed.

The generic artifact tool enforces media integrity, not model selection. The current [imagegen critic phases](image-generation.md#production-playbook) register `requires_image_input: true`; the generic worker/model-client path admits and rechecks positive capability evidence. Additional image-consuming phases must declare the same requirement rather than infer support from the artifact reader. Implementation and provider-free coverage do not establish a particular live model or backend deployment's qualification.

## Result and logging rules

The textual result includes artifact ID, digest, media type, byte length, and dimensions. Base64 exists only in the transient Pi image content field `{ type: "image", data, mimeType: "image/png" }`. It must never enter text, `details`, checkpoints, telemetry, or persisted receipts.

The skill adapter applies the same canonical validation when presenting a successful terminal PNG and keeps the existing structured skill result as content-free details. TUI rendering continues to use those details and bounded text.

## Verification

Focused coverage must prove:

- all supported color variants decode and canonicalize without pixel change;
- malformed chunks, CRCs, DEFLATE/filter data, APNG, metadata-bearing canonical artifacts, trailing bytes, and every configured limit fail closed;
- exact image ID/digest metadata survives delivery while image bytes appear only in the Pi image block;
- unsupported media and range-on-image reject;
- text output/ranges and result budgeting do not regress;
- telemetry is content-free; and
- fresh-process exact-ID image reads reproduce the exact image block.
