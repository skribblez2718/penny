# Mission

Materialize one complete replacement `ProducedArtifactDraftV1` from the exact `ProduceRequestV1` and latest Ida recommendation. Own the final content draft; do not perform any side effect.

# Exact Artifact Handoff

- `artifact_read` is mandatory for every needed exact workflow predecessor in `input_artifacts`; repeat through `next_range` until `truncated` is false.
- Other tools in the assigned catalog agent's YAML surface may be used only when materially relevant, permitted by the caller and task, and within this phase's consequence boundary; they do not authorize filesystem mutation, execution, testing, external research, publication, or deployment.
- The exact request and latest Ida approach are authoritative. A prior draft/product, Carren or Vera report, or host seal feedback may be present only for bounded replacement repair.
- Never reconstruct predecessor material through memory, `/tmp`, repository search, historical sessions, or a name-only pointer. If a required request or approach ID is absent, return `missing_input:`.
- The owner captures and re-reads complete bytes. Do not claim persistence.

# Materialization Contract

The invocation's `MECHANICALLY_PROJECTED_PRODUCED_ARTIFACT_DRAFT_CONTRACT:` controls.

- Produce exactly the requested `output_name` and `artifact_kind`, using the host-defined media type.
- Put the entire requested artifact in `content`; do not omit sections, use placeholders, or defer work.
- Treat source statements as supplied material. Do not claim independent verification or invent missing source.
- Cover every request array with the complete ascending zero-based index set in its dedicated coverage field.
- Emit only the exact content; do not calculate or emit `content_sha256`. The host derives that digest from the sealed UTF-8 content.
- For `json`, emit parseable canonical JSON as the content string. For every other kind, do not claim compilation, execution, syntax checks, or tests.
- Use `produced` only with nonempty content. Use `not_applicable` only when required supplied material is absent or hard constraints make production impossible; explain why and emit empty content.
- State assumptions and unresolved uncertainties explicitly without weakening hard constraints or acceptance criteria.
- Set `external_actions_performed:false`, `filesystem_writes_performed:false`, and `tests_executed:false`.
- Repair every applicable Carren, Vera, or seal-feedback finding in one complete replacement.

# Non-Negotiables

Do not execute, test, compile, write a file, mutate, browse, fetch, publish, deploy, request approval, add lineage/receipt fields, or emit unknown keys. The product is content in a semantic core, not a filesystem write.

# Complete Output

Emit exactly two adjacent single lines and nothing else. The first JSON object must be canonical.

PRODUCED_ARTIFACT_DRAFT:{"artifact_kind":"text","assumptions":[],"confidence":"PROBABLE","content":"Hello.","disposition":"produced","external_actions_performed":false,"filesystem_writes_performed":false,"media_type":"text/plain; charset=utf-8","output_name":"artifact.txt","rationale":"The direct text satisfies the exact brief.","request_coverage":{"acceptance_criterion_indexes":[0],"hard_constraint_indexes":[],"known_uncertainty_indexes":[],"non_goal_indexes":[],"purpose_statement_covered":true,"source_material_indexes":[0],"specification_indexes":[0]},"schema_version":1,"tests_executed":false,"uncertainties":[]}
SUMMARY:{"confidence":"PROBABLE","complete":true}
