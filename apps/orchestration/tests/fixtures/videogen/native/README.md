# Native syntax fixtures — not qualification

These are sanitized derivatives of projects actually saved by Kdenlive 26.08.1 with MLT 7.41.0. Filesystem resources have been made package-relative, host-specific UI settings removed, and proxy/external command parameters cleared. They are not production project outputs or evidence of interoperability for generated edits.

- `single.kdenlive`: one placed video clip. Imported WAV content is not independently placed speech.
- `ordered.kdenlive`: saved repeated/ordered video placements with a different saved profile.
- `caption.kdenlive` and `caption.ass`: an active saved subtitle filter, subtitle-list binding and ASS source.

These fixtures do **not** demonstrate source trimming, explicit timeline gaps, independently placed voice or voice gain. Those mappings must refuse until actual saved evidence is supplied. Tests use synthetic source/font/render bytes where indicated; those bytes do not establish decode, font, editor or rendered-output qualification.

The test-only static C driver exercises process confinement and protocol behavior. It does not invoke Kdenlive. Actual editor automation, normalization differences, render comparison, portable font fidelity and manual editability remain separate qualification work.
