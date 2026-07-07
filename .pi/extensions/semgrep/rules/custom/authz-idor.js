const express = require("express");
const app = express();

// ── VULNERABLE ── record fetched/mutated by a request-derived id, no ownership scoping.

app.get("/documents/:id", async (req, res) => {
  const id = req.params.id;
  // ruleid: authz-idor
  const doc = await Document.findById(id);
  res.json(doc);
});

app.post("/documents/:id/delete", async (req, res) => {
  const id = req.params.id;
  // ruleid: authz-idor
  await Document.destroy({ where: { id: id } });
  res.sendStatus(204);
});

app.put("/accounts/:id", async (req, res) => {
  // ruleid: authz-idor
  await Account.update(req.body, { where: { id: req.query.accountId } });
  res.sendStatus(200);
});

// Mass-assignment IDOR: the "ownership check" (ownerId) is itself attacker-
// controlled (req.body.ownerId), so scoping to it grants zero protection.
app.put("/documents/:id", async (req, res) => {
  const id = req.params.id;
  // ruleid: authz-idor
  await Document.update(req.body, { where: { id: id, ownerId: req.body.ownerId } });
  res.sendStatus(200);
});

// ── MITIGATED ── query scoped to the authenticated principal, or explicit check.

app.get("/safe/documents/:id", async (req, res) => {
  const id = req.params.id;
  // ok: authz-idor
  const doc = await Document.findOne({ where: { id: id, ownerId: req.user.id } });
  res.json(doc);
});

app.post("/safe/documents/:id/delete", async (req, res) => {
  // ok: authz-idor
  await Document.destroy({ where: { id: req.params.id, userId: req.user.id } });
  res.sendStatus(204);
});

app.put("/safe/accounts/:id", async (req, res) => {
  // ok: authz-idor
  await Account.update(req.body, { where: { id: req.params.id, user: req.user } });
  res.sendStatus(200);
});

// Mitigated counterpart to the mass-assignment case above: the ownership check
// value comes from a TRUSTED source (req.user.id), not from req.body, so an
// attacker cannot forge it.
app.put("/safe/documents/:id", async (req, res) => {
  const id = req.params.id;
  // ok: authz-idor
  await Document.update(req.body, { where: { id: id, ownerId: req.user.id } });
  res.sendStatus(200);
});
