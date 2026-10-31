import { Type } from "typebox";
import { createInterface } from "node:readline";
import { Checkpointer } from "../../dist/checkpointer.js";
import { ArtifactStore } from "../../dist/artifact-store.js";
import {
  HostCapacityProjectAuthority,
  HostOperationCapacityAuthority,
} from "../../dist/host-operations/capacity-authority.js";
import {
  HostCapacityPolicyV1Schema,
  HostCapacityRequestV1Schema,
} from "../../dist/host-operations/capacity-contracts.js";
import { validateSkillSchema } from "../../dist/skill-contracts/common.js";

const WorkerInput = Type.Object(
  {
    stateRoot: Type.String({ minLength: 1, maxLength: 4_096 }),
    projectRoot: Type.String({ minLength: 1, maxLength: 4_096 }),
    policy: HostCapacityPolicyV1Schema,
    request: HostCapacityRequestV1Schema,
    now: Type.Integer({ minimum: 0, maximum: 8_640_000_000_000_000 }),
    mode: Type.Union([Type.Literal("reserve"), Type.Literal("inspect")]),
  },
  { additionalProperties: false }
);
const argument = process.argv[2];
if (argument === undefined) throw new Error("capacity competition input missing");
const raw: unknown = JSON.parse(argument);
const input = validateSkillSchema(WorkerInput, raw, "CapacityCompetitionInputV1");
using checkpointer = new Checkpointer(`${input.projectRoot}/orchestration.db`, undefined, {
  projectId: input.request.project_id,
});
using artifacts = new ArtifactStore(`${input.projectRoot}/artifacts`, {
  projectId: input.request.project_id,
});
const project = new HostCapacityProjectAuthority(
  input.request.project_id,
  checkpointer,
  artifacts,
  { read: () => undefined }
);
using core = new HostOperationCapacityAuthority({
  stateRoot: input.stateRoot,
  policy: input.policy,
  projects: [project],
  now: () => input.now,
});
process.stdout.write("ready\n");
const line = await new Promise<string>((resolve) => {
  const lines = createInterface({ input: process.stdin, terminal: false });
  lines.once("line", (value) => {
    lines.close();
    resolve(value);
  });
});
if (line !== "go") throw new Error("capacity competition barrier missing");
const record =
  input.mode === "reserve"
    ? core.reserve(input.request)
    : core.inspect(input.request.operation_record_id);
if (record === undefined) throw new Error("capacity competition exact record absent");
process.stdout.write(`${JSON.stringify(record)}\n`);
