# AVC import compatibility

`videogen/avc-normalization.ts` provides an explicit CPU import primitive for a bounded nonfragmented AVC source. It does **not** change strict media admission or automatically normalize API results.

The import parser inspects the container, sample coverage, sync table, composition offsets, unit-rate edit, colour fields, bounded UTF-8/duplicate-free JSON metadata and x264 informational SEI. Unknown boxes, unsupported colour/codec metadata, omitted/duplicated/retimed pictures and hidden media bytes refuse. The implemented additional input profile is 8-bit High AVC with the explicitly supported SDR colour description; it is not a general codec allowlist.

`normalizeImportedAvc()` fully decodes the source through the existing confined CPU runner, re-encodes to baseline AVC with no B frames, removes parsed informational metadata, applies strict admission, and fully decodes the canonical output. Every decoded frame must match the requested dimensions, format and zero-based CFR presentation clock. This is a **lossy re-encode**, not a byte-preserving or pixel-lossless transform.

The new fixed runner verb has one writable output file, not a writable directory. Existing decoder verbs remain read-only. Runtime pins, input/output bounds, memory/CPU/time limits, task/network denial and cleanup still apply. No installation, service changes, network endpoints or model jobs are introduced.

## Custody and recipes

Keep the original accepted-job artifact and receipt unchanged. Persist canonical bytes separately and connect the returned raw/canonical hashes, byte counts and `lossless: false` receipt to the same current owner operation. The primitive itself cannot establish accepted-job custody, rights, human approval or playback. A caller must not change an API receipt to claim that re-encoded bytes were downloaded from the API.

Strict source-decode recipes use the **measured source duration**, not the longer composition duration. WAV operands remain actual canonical PCM16 job output; rational span boundaries must be reduced and fall on the actual sample grid. Frame-aligned trims, explicit gaps, subtitle source/style/font and the saved native canvas remain separate edit decisions. Do not extend a measured source by changing its evidence or fill missing narration with constructed PCM.

Production integration must select the separately persisted canonical artifact before strict downstream decode/native use. This primitive supplies no automatic result substitution, new manifest adapter mode or route qualification.

## Tests

The existing opt-in CPU suite accepts an additional explicit private `VIDEOGEN_MEDIA_IMPORT_FIXTURE` JSON descriptor. It contains pinned `video` and `audio` files, expected video dimensions/count/rate/byte cap, `audio_samples`, `audio_rate`, and an optional private report destination. File paths and actual producer values stay outside public tests.

The private cohort checks raw parser dimensions/full count, complete CPU decode, lossy normalization provenance, strict canonical decoding through the real generic owner, metadata/timing adversaries, and complete actual WAV measurements. Without that descriptor, these additional private-input cases are not run. Existing CPU opt-in and binding requirements still apply. Component tests and native comparisons are not film approval, legal clearance or qualification of all production routes.
