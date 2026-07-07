// eslint.config.security.mjs — bundled flat config for the eslint-security
// Pi extension.
//
// Authored for the sca skill's tool-extension layer (Phase 4a). Wires BOTH
// security plugins so a single scan covers them:
//   • eslint-plugin-security        (MIT, permissive)
//   • eslint-plugin-no-unsanitized  (MPL-2.0, file-level weak copyleft —
//                                     invoke-only; never vendor its source)
//
// This is a CONFIG file only. It imports the plugins at eslint-runtime from the
// target project's environment; it contains none of either plugin's source.
// Both plugins must be installed where eslint runs:
//   npm install -D eslint eslint-plugin-security eslint-plugin-no-unsanitized
//
// CONFIDENCE NOTE: not verified against a live eslint here (plugins not
// installed in this dev env). Flat-config shape is PROBABLE for ESLint v9.

import security from "eslint-plugin-security";
import noUnsanitized from "eslint-plugin-no-unsanitized";

export default [
  // eslint-plugin-security's recommended flat config (MIT).
  security.configs.recommended,
  // eslint-plugin-no-unsanitized (MPL-2.0) — DOM XSS sink detection.
  {
    files: ["**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs", "**/*.ts", "**/*.tsx"],
    plugins: {
      "no-unsanitized": noUnsanitized,
    },
    rules: {
      "no-unsanitized/method": "error",
      "no-unsanitized/property": "error",
    },
  },
];
