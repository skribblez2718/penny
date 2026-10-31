# Produce captured-output regression

These four exact UTF-8 payloads came from a synthetic-only live catalog-role run. No session, provider configuration, private inputs, filesystem paths, or credentials are included. Sanitization removes the surrounding run/session metadata, not the payload bytes. The `.txt` extension preserves canonical JSON and the absence of a trailing newline.

| Payload | Bytes | SHA-256 |
| --- | ---: | --- |
| request.txt | 1243 | 635a8af321d2c23c25e0da4f6f800d4e7138ca8bc0944df816b2f91b781f2308 |
| approach.txt | 566 | a6fe7622db655bfc279622d1fc12367374d62f3b6f0ffcb42076257a51fd3a73 |
| decision.txt | 840 | be354571b81c73afe86f307b51d4851104ab0010b49e99bc06d905d16f4b6b5e |
| draft.txt | 695 | cad0dec0d09c3ab6b8ee3b05962e2275671ff2cb0e016df34704454683d75c8a |

The exported refs' lengths/digests match these payloads and each final worker message. The run accepted Ida, Demetri, and Skribble, then recorded `produce_approach_invalid` before any Carren/Vera visit. Its failure digest was `06578c1321cd7a77a904d82e9186c243617a6a8750f012c78b36c2e95e01e2d8`: the digest of `FRAMING_INVALID: ArtifactApproachV1 core or SUMMARY framing is invalid`.

The Ida core is valid canonical JSON. Its SUMMARY orders `complete` before `confidence`, whereas the old Produce parser required literal `confidence`-then-`complete` serialization. The shared router accepted the same closed JSON object. The regression must accept property-order permutations without permitting unknown fields, duplicate keys, prose, or malformed semantic cores. Backticks inside JSON strings are valid content, not code-fence framing.

Routing-only correction has a separate boundary: only an engine-validated repair bound to the exact source artifact may supply replacement SUMMARY metadata. The source core stays byte-identical and must still validate. Approach/decision validation occurs before dependent worker dispatch, including unresolved negatives; draft defects retain host seal diagnostics and operator-led correction policy. Sealing, integrity, and completion independently recheck exact accepted execution groups.

## Version boundary

The active request, Ida approach, and Demetri decision are V1; the active draft, sealed product, quality/validity receipts, integrity, and envelope are V2. These are different contracts, not aliases. Active V1 effect-bearing checkpoints already refuse as `legacy_effect_evidence_unverified`; new materialization must not accept V1 draft flags or silently upgrade them.

The exported V1 product/evidence validators and compatibility readers remain historical readers, not active alternatives. Their removal requires a separately owned public-export, semantic-validator/composition, retained-artifact, and compatibility-test decision. This fix adds no V1/V2 aliases and does not remove those readers or rewrite unrelated schemas.

Provider-free replay of these bytes is regression evidence, not renewed live-provider qualification. Parent-owned shipping rebuild, fresh-process focused suites, and the authorized live Produce rerun remain necessary.
