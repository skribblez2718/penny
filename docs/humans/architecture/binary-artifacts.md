# Binary Image Artifacts

Binary image artifacts extend Penny's exact artifact handoff to a bounded PNG
format. The artifact ID remains the only locator: the binary path adds no list,
search, local-path, materialization, or write surface. Start with the
[architecture overview](overview.md) for the artifact/checkpoint/memory boundary
and the [Skill Tool guide](../capabilities/skill-tool/skill-tool.md) for exact-ID
workflow handoff.

## Canonicalization, defined

For Penny, **PNG canonicalization** means fully decoding an admitted static PNG
to pixels, re-encoding those same pixels into one metadata-free PNG shape, then
re-decoding the result and checking pixel equality. The canonical output—not the
untrusted source bytes—is stored as the `image/png` artifact and receives its
immutable digest and ID.

At the file-format level, that shape is an 8-bit RGBA image containing only the required PNG header (`IHDR`), one image-data chunk (`IDAT`), and the end marker (`IEND`), with filter-zero rows. Compression bytes need not be identical across compatible encoders; decoded pixels and the required chunk/filter shape are the stable contract.

Canonicalization happens before persistence. Reading a stored artifact never
silently repairs, replaces, or re-identifies it. A stored PNG that is not already
canonical is rejected so its exact artifact identity remains meaningful.

## Admission and codec checks

Penny accepts a deliberately small PNG subset: static, non-interlaced, 8-bit
grayscale, RGB, grayscale-alpha, or RGBA images. Before untrusted bytes may be
stored as `image/png`, the shared codec:

1. bounds source bytes, compressed data, decompressed scanlines, dimensions,
   pixels, individual ancillary chunks, and aggregate ancillary bytes;
2. validates the PNG signature, chunk names, order and cardinality, CRCs,
   required chunks, and absence of trailing data;
3. rejects animated PNG (`APNG`), palettes, unknown critical chunks, invalid filters, malformed or trailing PNG compression streams, and unsupported image-header modes;
4. fully inflates the image and reverses PNG filters into exact RGBA pixels; and
5. canonicalizes and re-decodes the output to prove pixel equality.

This strips ancillary metadata that could carry prompts, workflow data,
filenames, paths, or other hidden text. The byte, dimension, decompression, and
pixel bounds also prevent a small-looking input from expanding without limit.

## What happens on read

Text artifacts keep their existing behavior: callers may read a bounded UTF-8
byte range and continue with `next_range`.

A PNG must be delivered as a complete image. `artifact_read` therefore rejects a
byte range for `image/png`. It verifies the stored artifact ID, digest, and byte
length, validates the complete file against the canonical PNG contract, and
returns:

- a small text block containing the artifact ID, digest, media type, byte length,
  and dimensions; and
- one native Pi image block for the model.

Base64 transport data exists only inside that transient image block. It is not
copied into text, result details, checkpoints, telemetry, or persisted receipts.
Unsupported binary media fails closed.

## Model compatibility

Image-capable workflows use capability information from Pi's resolved provider
metadata. They do not infer support from provider or model names. Admission binds
the exact provider/model identity and positive image-input capability; worker
creation checks both again immediately before prompting. Missing or malformed
capability data, a text-only model, or an identity change stops the operation.

The generic artifact reader enforces media integrity only. The image-producing
workflow is responsible for selecting and binding an image-capable model.

## Limits and maintenance

Deployments may lower the built-in PNG limits but cannot raise the process safety
maxima. Invalid settings or attempted increases fail configuration admission.
The lowering controls are:

- `PENNY_PNG_MAX_SOURCE_BYTES`
- `PENNY_PNG_MAX_WIDTH`
- `PENNY_PNG_MAX_HEIGHT`
- `PENNY_PNG_MAX_PIXELS`
- `PENNY_PNG_MAX_COMPRESSED_BYTES`
- `PENNY_PNG_MAX_DECOMPRESSED_BYTES`
- `PENNY_PNG_MAX_ANCILLARY_CHUNK_BYTES`
- `PENNY_PNG_MAX_ANCILLARY_BYTES`

The implementation uses Node's built-in zlib support rather than adding another
image decoder package.

Focused verification covers supported color variants, pixel-preserving
canonicalization, metadata removal, malformed chunks and compression, configured
limits, unsupported media, range rejection for images, content-free telemetry,
model capability drift, terminal presentation, and exact-ID reads across a fresh
process.

For the exact maintainer contract, see
[Binary Artifacts — exact canonical PNG delivery](../../agents/architecture/binary-artifacts.md).
