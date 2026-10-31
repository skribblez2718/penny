import { expect, it } from "vitest";
import { validateContract } from "../../orchestration/dist/contracts.js";
import { runScaP03BootstrapCliV1 } from "../src/p03-bootstrap-cli.js";
import { ScaP03CliFreezeResultSchema } from "../src/p03-bootstrap-cli-contracts.js";

it.skipIf(process.env.PENNY_SCA_P03_CLI_LIVE !== "1")(
  "operator-authorized P03 CLI freeze against an externally prepared host (not AC-P03)",
  async () => {
    const manifest = process.env.PENNY_SCA_P03_CLI_LIVE_MANIFEST;
    if (manifest === undefined) throw new Error("PENNY_SCA_P03_CLI_LIVE_MANIFEST required");
    const output: string[] = [];
    await runScaP03BootstrapCliV1(["freeze-record", "--manifest", manifest], {
      emit: (line) => output.push(line),
    });
    expect(output).toHaveLength(1);
    const line = output[0];
    if (line === undefined) throw new Error("P03 live freeze emitted no result");
    const parsed: unknown = JSON.parse(line);
    const result = validateContract(ScaP03CliFreezeResultSchema, parsed, "P03 live freeze handoff");
    expect(result.status).toBe("ready_for_review");
    expect(result.handoff_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.attempt_ref.artifact_id).toMatch(/^art_[a-f0-9]{64}$/u);
    if (
      result.cleanup_ref === null ||
      result.isolation_ref === null ||
      result.record_ref === null
    ) {
      throw new Error("P03 live freeze omitted required ready-for-review evidence");
    }
    expect(result.cleanup_ref.artifact_id).toMatch(/^art_[a-f0-9]{64}$/u);
    expect(result.isolation_ref.artifact_id).toMatch(/^art_[a-f0-9]{64}$/u);
    expect(result.record_ref.artifact_id).toMatch(/^art_[a-f0-9]{64}$/u);
  },
  300_000
);
