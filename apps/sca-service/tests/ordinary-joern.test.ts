import { describe, expect, it } from "vitest";
import { ordinaryJoernQueryScript } from "../src/ordinary-joern.js";

describe("ordinary native Joern query material", () => {
  it.each([0, 513, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid native row bound %s before creating script material",
    (limit) =>
      expect(() =>
        ordinaryJoernQueryScript({ kind: "call", sink: "sink", sourceMethod: ".*", limit })
      ).toThrow("row limit")
  );
  it.each([-1, 100_001, 0.5, Number.NaN])("rejects invalid offset %s", (offset) => {
    expect(() =>
      ordinaryJoernQueryScript({ kind: "call", sink: "sink", sourceMethod: ".*", offset })
    ).toThrow("offset");
  });
  it.each(["", "a".repeat(1025), "sink\nrun", "\0"])("rejects invalid traversal values", (sink) => {
    expect(() => ordinaryJoernQueryScript({ kind: "call", sink, sourceMethod: ".*" })).toThrow(
      "traversal"
    );
  });
  it("keeps caller regexes in string literals, not Scala statements", () => {
    const sink = '"); sys.error("unexpected"); //';
    const script = ordinaryJoernQueryScript({
      kind: "call",
      sink,
      sourceMethod: ".*",
      offset: 3,
      limit: 2,
    });
    expect(script).toContain(
      `java.util.Base64.getDecoder.decode("${Buffer.from(sink).toString("base64")}")`
    );
    expect(script).not.toContain(sink);
    expect(script).toContain("candidates.drop(3).take(3)");
    expect(script).toContain("val complete = 3 == 0 && !truncated");
    expect(script).toContain("page.take(2)");
    expect(script).not.toContain("\u0002");
  });
  it("queries explicit inputs rather than implicit JavaScript receiver flows", () => {
    const script = ordinaryJoernQueryScript({ kind: "dataflow", sink: "sink", sourceMethod: ".*" });
    expect(script).toContain(".argument.filter(_.argumentIndex > 0).reachableByFlows");
    expect(script).toContain(".parameter.filter(_.index > 0)");
    expect(script).toContain("Exact FILE content SHA-256 matched");
    expect(script).toContain("cpg.unknown.filter(_.method.filename == name).isEmpty");
    expect(script).toContain(".manifest.json");
    expect(script).toContain(".result.json");
  });
});
