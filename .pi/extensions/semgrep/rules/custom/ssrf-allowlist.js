const express = require("express");
const http = require("http");
const axios = require("axios");
const app = express();

// ── VULNERABLE ── request target derived from user input, no allowlist guard.

app.get("/proxy", async (req, res) => {
  // ruleid: ssrf-allowlist
  const r = await fetch(req.query.url);
  res.send(await r.text());
});

app.get("/proxy2", async (req, res) => {
  const target = req.query.target;
  // ruleid: ssrf-allowlist
  const r = await axios.get(target);
  res.json(r.data);
});

app.post("/webhook", async (req, res) => {
  // ruleid: ssrf-allowlist
  http.get(req.body.callbackUrl, (upstream) => upstream.pipe(res));
});

// ── MITIGATED ── user input routed through an allowlist / validation guard.

app.get("/safe/proxy", async (req, res) => {
  const url = assertAllowedUrl(req.query.url);
  // ok: ssrf-allowlist
  const r = await fetch(url);
  res.send(await r.text());
});

app.get("/safe/proxy2", async (req, res) => {
  const target = validateUrl(req.query.target);
  // ok: ssrf-allowlist
  const r = await axios.get(target);
  res.json(r.data);
});

app.post("/safe/webhook", async (req, res) => {
  const safe = allowlistHost(req.body.callbackUrl);
  // ok: ssrf-allowlist
  http.get(safe, (upstream) => upstream.pipe(res));
});
