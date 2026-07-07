const jwt = require("jsonwebtoken");
const { jwtVerify } = require("jose");

// ── VULNERABLE ── verify calls that do not enforce an algorithms allowlist / claims.

function v1(token, key) {
  // ruleid: jwt-claims
  return jwt.verify(token, key);
}

function v2(token, key) {
  // ruleid: jwt-claims
  return jwt.verify(token, key, { ignoreExpiration: true });
}

function v3(token, key, cb) {
  // ruleid: jwt-claims
  jwt.verify(token, key, { complete: true }, cb);
}

async function v4(token, key) {
  // ruleid: jwt-claims
  return await jwtVerify(token, key);
}

// Scope gap: algorithms allowlist IS present, but audience AND issuer are both
// absent, so tokens minted for a different audience/issuer are still accepted.
// The rule's documented intent covers audience/issuer, so this must fire.
function v5(token, key) {
  // ruleid: jwt-claims
  return jwt.verify(token, key, { algorithms: ["HS256"] });
}

// ── MITIGATED ── explicit algorithms allowlist plus audience/issuer.

function s1(token, key) {
  // ok: jwt-claims
  return jwt.verify(token, key, { algorithms: ["HS256"], audience: "api", issuer: "auth" });
}

async function s2(token, key) {
  // ok: jwt-claims
  return await jwtVerify(token, key, { algorithms: ["RS256"], audience: "api", issuer: "auth" });
}

// ── COMPLEMENTARY-BOUNDARY CASE ──
// This is the code the VENDORED jwt-none-alg rule catches (algorithms allowlist
// present, containing literal 'none'). To keep the two rules cleanly distinct,
// this example enforces audience AND issuer, so jwt-claims is satisfied on the
// claims dimension and stays silent — only jwt-none-alg fires (on 'none').
// (Under the expanded jwt-claims scope, a none-alg call that ALSO omitted
// audience+issuer would legitimately trip both rules; this fixture isolates the
// none-alg concern to test complementarity.) Annotated `ok` for jwt-claims.
function boundary(token, key) {
  // ok: jwt-claims
  return jwt.verify(token, key, { algorithms: ["none"], audience: "api", issuer: "auth" });
}
