// Source-level Express-style oracle; not an executable application.
const router = {
  get(_path, _callback) {
    void _path;
    void _callback;
  },
};
function persistRecord(value) {
  return value;
}
function persistDecoy(value) {
  return value;
}
function handleRecord(req) {
  const inputValue = req.query.record;
  const assignedValue = inputValue;
  if (assignedValue !== undefined) {
    const guardedAction = assignedValue;
    const sinkValue = guardedAction;
    persistRecord(sinkValue);
  } else {
    persistDecoy("unrelated");
  }
}
function decoyHandler(req) {
  return req.query.other;
}
router.get("/records", handleRecord);
router.get("/decoy", decoyHandler);
