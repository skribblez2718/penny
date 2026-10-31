import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { scoreScaCvssV4 } from "../dist/sca/cvss-v4.js";
import data from "../dist/sca/cvss-v4-data.json" with { type: "json" };
import cases from "./fixtures/sca-cvss-v4/official-cases.json" with { type: "json" };
import upstream from "./fixtures/sca-cvss-v4/upstream.json" with { type: "json" };

const FIXTURES = new URL("./fixtures/sca-cvss-v4/", import.meta.url);
const HIGH = "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H";
const NONE = "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:N/SC:N/SI:N/SA:N";

// Only exact hash-checked, reviewed upstream fixture code is evaluated. There is
// no network, process, require, or dynamic code generation in this oracle. Vector
// inputs cross as data, never as generated JavaScript. This is test-only.
function officialReference() {
  const context = createContext({}, { codeGeneration: { strings: false, wasm: false } });
  const sources = new Map<string, string>();
  for (const file of upstream.files) {
    const bytes = readFileSync(new URL(`${file.path}.txt`, FIXTURES));
    expect(bytes.byteLength).toBe(file.byte_length);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
    sources.set(file.path, bytes.toString("utf8"));
  }
  for (const name of [
    "metrics.js",
    "cvss_lookup.js",
    "max_composed.js",
    "max_severity.js",
    "cvss_score.js",
  ]) {
    const source = sources.get(name);
    if (source === undefined) throw new Error(`Missing official fixture: ${name}`);
    new Script(source, { filename: name }).runInContext(context, { timeout: 1000 });
  }
  const scoring = new Script(`inputVectors.map((inputVector) => {
    const selection = Object.fromEntries(Object.keys(expectedMetricOrder).map(key => [key, 'X']));
    for (const token of inputVector.split('/').slice(1)) {
      const [key, val] = token.split(':'); selection[key] = val;
    }
    return cvss_score(selection, cvssLookup_global, maxSeverity, macroVector(selection));
  })`);
  return {
    scores(vectors: readonly string[]): number[] {
      context.inputVectors = [...vectors];
      const result: unknown = scoring.runInContext(context, { timeout: 60_000 });
      if (!isScores(result)) {
        throw new Error("Invalid official reference output");
      }
      return result;
    },
    definitions(): [string, string[]][] {
      const result: unknown = new Script("Object.entries(expectedMetricOrder)").runInContext(
        context,
        { timeout: 1000 }
      );
      if (!isDefinitions(result)) throw new Error("Invalid official metric definitions");
      return result;
    },
    highestVectors(): string[] {
      // One highest-severity member of every official MacroVector, including
      // joint EQ3/EQ6 levels, all Threat levels and environmental Safety.
      const result: unknown = new Script(`Object.keys(cvssLookup_global).sort().map(key => {
        const combined = maxComposed.eq1[key[0]][0] + maxComposed.eq2[key[1]][0]
          + maxComposed.eq3[key[2]][key[5]][0] + maxComposed.eq4[key[3]][0] + maxComposed.eq5[key[4]][0];
        const selection = Object.fromEntries(Object.keys(expectedMetricOrder).map(k => [k, 'X']));
        for (const token of combined.split('/').filter(Boolean)) {
          const [k,v] = token.split(':');
          if ((k === 'SI' || k === 'SA') && v === 'S') { selection[k] = 'H'; selection['M'+k] = 'S'; }
          else selection[k] = v;
        }
        return 'CVSS:4.0/' + Object.entries(selection).filter(([k,v]) => v !== 'X').map(([k,v]) => k+':'+v).join('/');
      })`).runInContext(context, { timeout: 1000 });
      if (!isStrings(result)) throw new Error("Invalid official highest vectors");
      return result;
    },
    tables(): unknown {
      return new Script(`({lookup: cvssLookup_global, highest: {
        eq1: maxComposed.eq1, eq2: maxComposed.eq2,
        eq3eq6: Object.fromEntries(Object.entries(maxComposed.eq3).flatMap(([k,v]) => Object.entries(v).map(([s,a]) => [k+s,a]))),
        eq4: maxComposed.eq4
      }, depths: {eq1: maxSeverity.eq1, eq2: maxSeverity.eq2,
        eq3eq6: Object.fromEntries(Object.entries(maxSeverity.eq3eq6).flatMap(([k,v]) => Object.entries(v).map(([s,a]) => [k+s,a]))),
        eq4: maxSeverity.eq4}})`).runInContext(context, { timeout: 1000 });
    },
  };
}

function isScores(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every((score: unknown) => typeof score === "number" && Number.isFinite(score))
  );
}
function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}
function isDefinitions(value: unknown): value is [string, string[]][] {
  return (
    Array.isArray(value) &&
    value.every(
      (item: unknown) =>
        Array.isArray(item) &&
        item.length === 2 &&
        typeof item[0] === "string" &&
        isStrings(item[1])
    )
  );
}

const reference = officialReference();
const definitions = reference.definitions();

function vectorWith(vector: string, name: string, value: string | undefined): string {
  const entries = new Map(
    vector
      .split("/")
      .slice(1)
      .map((token) => {
        const [key, val] = token.split(":");
        if (key === undefined || val === undefined) throw new Error("Invalid test vector");
        return [key, val];
      })
  );
  if (value === undefined) entries.delete(name);
  else entries.set(name, value);
  return (
    "CVSS:4.0" +
    definitions
      .flatMap(([key]) => (entries.has(key) ? [`/${key}:${entries.get(key)}`] : []))
      .join("")
  );
}

function compareOfficial(vectors: readonly string[]): void {
  const expected = reference.scores(vectors);
  expect(expected).toHaveLength(vectors.length);
  vectors.forEach((vector, index) => {
    const actual = scoreScaCvssV4(vector);
    expect(actual.score, vector).toBe(expected[index]);
    expect(scoreScaCvssV4(actual.vector)).toEqual(actual);
    expect(scoreScaCvssV4(actual.base_vector).score).toBe(actual.base_score);
  });
}

describe("general SCA CVSS v4.0 scorer", () => {
  it("pins the official scorer and all 270 protocol table entries without runtime oracle dependencies", () => {
    expect(upstream.commit).toBe("c5b0d409ae9f57c44264c6ce5f27d89298e1d32a");
    expect(cases.reference_commit).toBe(upstream.commit);
    expect(Object.keys(data.lookup)).toHaveLength(270);
    expect(data).toEqual(reference.tables());
    const source = readFileSync(new URL("../src/sca/cvss-v4.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/node:|p11-|fixtures\/|fetch\(|eval\(|new Function/);
  });

  it.each(cases.cases)("matches official case $id ($score)", (testCase) => {
    const actual = scoreScaCvssV4(testCase.vector);
    expect(actual).toEqual({
      score: testCase.score,
      vector: testCase.vector,
      nomenclature: testCase.nomenclature,
      rating: testCase.rating,
      base_score: testCase.base_score,
      base_vector: testCase.base_vector,
    });
    expect(reference.scores([testCase.vector, testCase.base_vector])).toEqual([
      testCase.score,
      testCase.base_score,
    ]);
  });

  it("covers both sides of every qualitative rating boundary with reference-derived vectors", () => {
    const boundaries = cases.cases.filter((testCase) => testCase.id.startsWith("boundary-"));
    expect(boundaries.map((testCase) => testCase.score).sort((a, b) => a - b)).toEqual([
      0.1, 3.9, 4, 6.9, 7, 8.9, 9, 10,
    ]);
    expect(scoreScaCvssV4(NONE).rating).toBe("None");
  });

  it("scores a highest-severity member of every official MacroVector", () => {
    const vectors = reference.highestVectors();
    expect(vectors).toHaveLength(270);
    compareOfficial(vectors);
    expect(vectors.map((vector) => scoreScaCvssV4(vector).score)).toEqual(
      Object.entries(data.lookup)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, score]) => score)
    );
  });

  it("matches general interpolation across deterministic Base/Threat/Environmental combinations", () => {
    // Fixed-seed sampling is independent of scorer output and fixture vectors.
    // It samples all metric values and all nomenclatures without a score lookup.
    let state = 0x43565353;
    const pick = (values: readonly string[]): string => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const selected = values[Math.floor((state / 0x100000000) * values.length)];
      if (selected === undefined) throw new Error("Empty metric values");
      return selected;
    };
    const vectors: string[] = [];
    for (let index = 0; index < 1024; index++) {
      const base =
        "CVSS:4.0/" +
        definitions
          .slice(0, 11)
          .map(([name, values]) => `${name}:${pick(values)}`)
          .join("/");
      const environmental = definitions
        .slice(12, 26)
        .map(([name, values]) => `/${name}:${pick(values)}`)
        .join("");
      const threat = `/E:${pick(["A", "P", "U"])}`;
      vectors.push(base, base + threat, base + environmental, base + threat + environmental);
    }
    compareOfficial(vectors);
  });

  it("accepts every official metric value and rejects missing or invalid values for each metric", () => {
    const vectors: string[] = [];
    definitions.forEach(([name, values], index) => {
      for (const value of values) vectors.push(vectorWith(HIGH, name, value));
      expect(() => scoreScaCvssV4(vectorWith(HIGH, name, "invalid"))).toThrow(/Invalid CVSS/);
      if (index < 11) {
        expect(() => scoreScaCvssV4(vectorWith(HIGH, name, undefined))).toThrow(/Missing CVSS/);
        expect(() => scoreScaCvssV4(vectorWith(HIGH, name, "X"))).toThrow(/Invalid CVSS/);
      }
      const valid = vectorWith(HIGH, name, values[0]);
      const token = valid.split("/").find((entry) => entry.startsWith(`${name}:`));
      expect(() => scoreScaCvssV4(`${valid}/${token}`)).toThrow(/Duplicate CVSS/);
    });
    compareOfficial(vectors);
  });

  it("omits optional X, applies official defaults and retains an intrinsic Base record", () => {
    const allX =
      HIGH +
      definitions
        .slice(11)
        .map(([name]) => `/${name}:X`)
        .join("");
    expect(scoreScaCvssV4(allX)).toEqual(scoreScaCvssV4(HIGH));
    const explicitDefaults = scoreScaCvssV4(HIGH + "/E:A/CR:H/IR:H/AR:H");
    expect(explicitDefaults.nomenclature).toBe("CVSS-BTE");
    expect(explicitDefaults.score).toBe(scoreScaCvssV4(HIGH).score);
    expect(scoreScaCvssV4(HIGH + "/E:A").nomenclature).toBe("CVSS-BT");
    expect(scoreScaCvssV4(HIGH + "/E:X/CR:H").nomenclature).toBe("CVSS-BE");
    expect(scoreScaCvssV4(HIGH + "/E:P/CR:X").nomenclature).toBe("CVSS-BT");
    const mitigated = scoreScaCvssV4(HIGH + "/E:U/MVC:N/MVI:N/MVA:N/MSC:N/MSI:N/MSA:N");
    expect(mitigated.score).toBe(0);
    expect(mitigated.base_score).toBe(reference.scores([HIGH])[0]);
    expect(mitigated.base_vector).toBe(HIGH);
  });

  it("never uses Supplemental metrics to change a number or nomenclature", () => {
    for (const [name, values] of definitions.slice(26)) {
      for (const value of values) {
        for (const base of [HIGH, NONE, HIGH + "/E:U/MAV:P"]) {
          const scored = scoreScaCvssV4(vectorWith(base, name, value));
          const original = scoreScaCvssV4(base);
          expect(scored.score).toBe(original.score);
          expect(scored.nomenclature).toBe(original.nomenclature);
          expect(scored.base_score).toBe(original.base_score);
        }
      }
    }
  });

  it("accepts the longest protocol-valid representation and normalizes it idempotently", () => {
    const longest =
      "CVSS:4.0/" +
      definitions
        .map(([name, values]) => {
          const value = [...values].sort((a, b) => b.length - a.length)[0];
          if (value === undefined) throw new Error("Missing official metric values");
          return `${name}:${value}`;
        })
        .join("/");
    compareOfficial([longest]);
  });

  it("rejects oversized input before parsing or scoring", () => {
    expect(() => scoreScaCvssV4(`${HIGH}/${"A".repeat(100_000)}`)).toThrow(/length/);
  });

  it.each([
    "",
    "CVSS:4.0",
    HIGH.replace("CVSS:4.0/", ""),
    HIGH.replace("4.0", "3.1"),
    ` ${HIGH}`,
    `${HIGH} `,
    `${HIGH}\n`,
    `${HIGH}/`,
    HIGH.replace("/AV:N", "//AV:N"),
    HIGH.replace("AV:N", "AV:n"),
    HIGH.replace("UI:N", "ui:N"),
    HIGH.replace("VC:H", "VC:"),
    HIGH.replace("AV:N", "AV:N:N"),
    HIGH.replace("AV:N", "AV:X"),
    HIGH.replace("/AV:N/AC:L", "/AC:L/AV:N"),
    `${HIGH}/CR:H/E:A`,
    `${HIGH}/AU:Y/S:P`,
    `${HIGH}/E:A/E:X`,
    `${HIGH}/E:A/E:A`,
    `${HIGH}/ZZ:N`,
    `${HIGH}/__proto__:N`,
    `${HIGH}/constructor:N`,
    `${HIGH}/U:RED`,
    `${HIGH}/MSI:P`,
    `${HIGH}/MSC:S`,
    `${HIGH}/VC:S`,
    `${HIGH}/E:P\u0000`,
    `${HIGH}/E:P?`,
    `${HIGH}/U:Green/RE:H`,
  ])("rejects malformed vectors without a default or partial score: %s", (vector) => {
    expect(() => scoreScaCvssV4(vector)).toThrow();
  });
});
