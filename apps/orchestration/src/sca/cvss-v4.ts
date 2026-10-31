// Copyright (c) 2023 FIRST.ORG, Inc., Red Hat, and contributors
// SPDX-License-Identifier: BSD-2-Clause
// TypeScript adaptation of FIRST's CVSS v4.0 MacroVector/interpolation algorithm.
// Pin, source hashes, attribution and license: cvss-v4.LICENSE.txt.
import referenceData from "./cvss-v4-data.json" with { type: "json" };

export interface ScaCvssV4Result {
  score: number;
  vector: string;
  nomenclature: "CVSS-B" | "CVSS-BT" | "CVSS-BE" | "CVSS-BTE";
  rating: "None" | "Low" | "Medium" | "High" | "Critical";
  base_score: number;
  base_vector: string;
}

// Specification §7 Table 23. These are protocol values, not scoring heuristics.
const METRIC_VALUES = {
  AV: ["N", "A", "L", "P"],
  AC: ["L", "H"],
  AT: ["N", "P"],
  PR: ["N", "L", "H"],
  UI: ["N", "P", "A"],
  VC: ["H", "L", "N"],
  VI: ["H", "L", "N"],
  VA: ["H", "L", "N"],
  SC: ["H", "L", "N"],
  SI: ["H", "L", "N"],
  SA: ["H", "L", "N"],
  E: ["X", "A", "P", "U"],
  CR: ["X", "H", "M", "L"],
  IR: ["X", "H", "M", "L"],
  AR: ["X", "H", "M", "L"],
  MAV: ["X", "N", "A", "L", "P"],
  MAC: ["X", "L", "H"],
  MAT: ["X", "N", "P"],
  MPR: ["X", "N", "L", "H"],
  MUI: ["X", "N", "P", "A"],
  MVC: ["X", "H", "L", "N"],
  MVI: ["X", "H", "L", "N"],
  MVA: ["X", "H", "L", "N"],
  MSC: ["X", "H", "L", "N"],
  MSI: ["X", "S", "H", "L", "N"],
  MSA: ["X", "S", "H", "L", "N"],
  S: ["X", "N", "P"],
  AU: ["X", "N", "Y"],
  R: ["X", "A", "U", "I"],
  V: ["X", "D", "C"],
  RE: ["X", "L", "M", "H"],
  U: ["X", "Clear", "Green", "Amber", "Red"],
};
type MetricName = keyof typeof METRIC_VALUES;
type Metrics = ReadonlyMap<MetricName, string>;
const PREFIX = "CVSS:4.0";
const BASE = ["AV", "AC", "AT", "PR", "UI", "VC", "VI", "VA", "SC", "SI", "SA"] as const;
const ENVIRONMENTAL = [
  "CR",
  "IR",
  "AR",
  "MAV",
  "MAC",
  "MAT",
  "MPR",
  "MUI",
  "MVC",
  "MVI",
  "MVA",
  "MSC",
  "MSI",
  "MSA",
] as const;
const ORDER = Object.keys(METRIC_VALUES).filter(isMetricName);
// The longest valid vector includes each metric exactly once, at its longest value.
const MAX_VECTOR_LENGTH =
  PREFIX.length +
  ORDER.reduce(
    (length, name) =>
      length + name.length + 2 + Math.max(...METRIC_VALUES[name].map((value) => value.length)),
    0
  );

function isMetricName(name: string): name is MetricName {
  return Object.hasOwn(METRIC_VALUES, name);
}

function parseVector(vector: string): Metrics {
  if (
    typeof vector !== "string" ||
    vector.length > MAX_VECTOR_LENGTH ||
    !vector.startsWith(`${PREFIX}/`)
  ) {
    throw new Error("Invalid CVSS v4.0 vector prefix or length");
  }
  const metrics = new Map<MetricName, string>();
  let previousIndex = -1;
  for (const token of vector.slice(PREFIX.length + 1).split("/")) {
    const [name, value, extra] = token.split(":");
    if (name === undefined || value === undefined || extra !== undefined || !isMetricName(name)) {
      throw new Error("Invalid CVSS v4.0 metric syntax or name");
    }
    if (metrics.has(name)) throw new Error(`Duplicate CVSS v4.0 metric: ${name}`);
    if (!METRIC_VALUES[name].includes(value))
      throw new Error(`Invalid CVSS v4.0 value for ${name}`);
    const index = ORDER.indexOf(name);
    if (index <= previousIndex) throw new Error("Invalid CVSS v4.0 metric order");
    previousIndex = index;
    metrics.set(name, value);
  }
  for (const name of BASE) {
    if (!metrics.has(name)) throw new Error(`Missing CVSS v4.0 Base metric: ${name}`);
  }
  return metrics;
}

function canonicalVector(metrics: Metrics, names: readonly MetricName[]): string {
  return (
    PREFIX +
    names
      .flatMap((name) => {
        const value = metrics.get(name);
        return value === undefined || value === "X" ? [] : [`/${name}:${value}`];
      })
      .join("")
  );
}

function metric(metrics: Metrics, name: MetricName): string {
  const selected = metrics.get(name) ?? "X";
  if (name === "E" && selected === "X") return "A";
  if ((name === "CR" || name === "IR" || name === "AR") && selected === "X") return "H";
  const modifiedName = `M${name}`;
  const modified = isMetricName(modifiedName) ? metrics.get(modifiedName) : undefined;
  return modified !== undefined && modified !== "X" ? modified : selected;
}

type MacroVector = readonly [number, number, number, number, number, number];
function macroVector(metrics: Metrics): MacroVector {
  const m = (name: MetricName): string => metric(metrics, name);
  const allUnrestricted = m("AV") === "N" && m("PR") === "N" && m("UI") === "N";
  const someUnrestricted = m("AV") === "N" || m("PR") === "N" || m("UI") === "N";
  const highVulnerableImpact = m("VC") === "H" || m("VI") === "H" || m("VA") === "H";
  return [
    allUnrestricted ? 0 : someUnrestricted && m("AV") !== "P" ? 1 : 2,
    m("AC") === "L" && m("AT") === "N" ? 0 : 1,
    m("VC") === "H" && m("VI") === "H" ? 0 : highVulnerableImpact ? 1 : 2,
    m("MSI") === "S" || m("MSA") === "S"
      ? 0
      : m("SC") === "H" || m("SI") === "H" || m("SA") === "H"
        ? 1
        : 2,
    m("E") === "A" ? 0 : m("E") === "P" ? 1 : 2,
    (m("CR") === "H" && m("VC") === "H") ||
    (m("IR") === "H" && m("VI") === "H") ||
    (m("AR") === "H" && m("VA") === "H")
      ? 0
      : 1,
  ];
}

// Keep the reference implementation's decimal arithmetic and metric addition order:
// changing to integer distances can change rounding at half-tenth boundaries.
const LEVELS: Readonly<Partial<Record<MetricName, NumberTable>>> = {
  AV: { N: 0, A: 0.1, L: 0.2, P: 0.3 },
  PR: { N: 0, L: 0.1, H: 0.2 },
  UI: { N: 0, P: 0.1, A: 0.2 },
  AC: { L: 0, H: 0.1 },
  AT: { N: 0, P: 0.1 },
  VC: { H: 0, L: 0.1, N: 0.2 },
  VI: { H: 0, L: 0.1, N: 0.2 },
  VA: { H: 0, L: 0.1, N: 0.2 },
  SC: { H: 0.1, L: 0.2, N: 0.3 },
  SI: { S: 0, H: 0.1, L: 0.2, N: 0.3 },
  SA: { S: 0, H: 0.1, L: 0.2, N: 0.3 },
  CR: { H: 0, M: 0.1, L: 0.2 },
  IR: { H: 0, M: 0.1, L: 0.2 },
  AR: { H: 0, M: 0.1, L: 0.2 },
};

type NumberTable = Readonly<Partial<Record<string, number>>>;
type HighestVectors = Readonly<Partial<Record<string, readonly Metrics[]>>>;
const LOOKUP: NumberTable = referenceData.lookup;
const DEPTHS: Readonly<Record<string, NumberTable>> = referenceData.depths;

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Incomplete CVSS v4.0 reference data");
  return value;
}

function highestVectors(table: Readonly<Record<string, readonly string[]>>): HighestVectors {
  return Object.fromEntries(
    Object.entries(table).map(([key, vectors]) => [
      key,
      vectors.map((vector): Metrics => {
        const values = new Map<MetricName, string>();
        for (const token of vector.split("/").filter(Boolean)) {
          const [name, value] = token.split(":");
          if (name === undefined || !isMetricName(name) || value === undefined)
            throw new Error("Invalid CVSS v4.0 reference data");
          values.set(name, value);
        }
        return values;
      }),
    ])
  );
}
const HIGHEST = {
  eq1: highestVectors(referenceData.highest.eq1),
  eq2: highestVectors(referenceData.highest.eq2),
  eq3eq6: highestVectors(referenceData.highest.eq3eq6),
  eq4: highestVectors(referenceData.highest.eq4),
};

function severityDistance(
  metrics: Metrics,
  vectors: readonly Metrics[],
  names: readonly MetricName[]
): number {
  // The EQ groups have disjoint metrics. Selecting the first dominating maximum
  // in each group is equivalent to FIRST's first dominating Cartesian product,
  // without materializing up to 30 full vectors per score.
  for (const maximum of vectors) {
    const distances = names.map((name) => {
      const levels = required(LEVELS[name]);
      return (
        required(levels[metric(metrics, name)]) - required(levels[required(maximum.get(name))])
      );
    });
    if (distances.every((distance) => distance >= 0))
      return distances.reduce((sum, distance) => sum + distance, 0);
  }
  throw new Error("No dominating CVSS v4.0 reference vector");
}

function calculate(metrics: Metrics): number {
  if (
    ["VC", "VI", "VA", "SC", "SI", "SA"].every(
      (name) => isMetricName(name) && metric(metrics, name) === "N"
    )
  )
    return 0;
  const [eq1, eq2, eq3, eq4, eq5, eq6] = macroVector(metrics);
  const lookup = (...parts: number[]): number | undefined => LOOKUP[parts.join("")];
  const value = required(lookup(eq1, eq2, eq3, eq4, eq5, eq6));
  let jointLower: number | undefined;
  if (eq3 === 0 && eq6 === 0) {
    // EQ3 and EQ6 are coupled: 00 can descend to 01 or 10. Use the higher score.
    jointLower = Math.max(
      required(lookup(eq1, eq2, 0, eq4, eq5, 1)),
      required(lookup(eq1, eq2, 1, eq4, eq5, 0))
    );
  } else if (eq6 === 1) {
    jointLower = lookup(eq1, eq2, eq3 + 1, eq4, eq5, eq6);
  } else {
    jointLower = lookup(eq1, eq2, eq3, eq4, eq5, eq6 + 1);
  }
  const groups = [
    {
      key: "eq1",
      level: String(eq1),
      lower: lookup(eq1 + 1, eq2, eq3, eq4, eq5, eq6),
      names: ["AV", "PR", "UI"],
    },
    {
      key: "eq2",
      level: String(eq2),
      lower: lookup(eq1, eq2 + 1, eq3, eq4, eq5, eq6),
      names: ["AC", "AT"],
    },
    {
      key: "eq3eq6",
      level: `${eq3}${eq6}`,
      lower: jointLower,
      names: ["VC", "VI", "VA", "CR", "IR", "AR"],
    },
    {
      key: "eq4",
      level: String(eq4),
      lower: lookup(eq1, eq2, eq3, eq4 + 1, eq5, eq6),
      names: ["SC", "SI", "SA"],
    },
  ] satisfies {
    key: keyof typeof HIGHEST;
    level: string;
    lower: number | undefined;
    names: MetricName[];
  }[];
  let total = 0;
  // Threat (EQ5) contributes zero distance, but its lower neighbor still counts
  // in the mean's denominator when it exists.
  let count = lookup(eq1, eq2, eq3, eq4, eq5 + 1, eq6) === undefined ? 0 : 1;
  for (const group of groups) {
    if (group.lower === undefined) continue;
    const distance = severityDistance(
      metrics,
      required(HIGHEST[group.key][group.level]),
      group.names
    );
    const depth = required(required(DEPTHS[group.key])[group.level]) * 0.1;
    total += (value - group.lower) * (distance / depth);
    count++;
  }
  const score = value - (count === 0 ? 0 : total / count);
  if (!Number.isFinite(score)) throw new Error("Invalid CVSS v4.0 calculation");
  return Math.round(Math.min(10, Math.max(0, score)) * 10) / 10;
}

function rating(score: number): ScaCvssV4Result["rating"] {
  if (score === 0) return "None";
  if (score < 4) return "Low";
  if (score < 7) return "Medium";
  if (score < 9) return "High";
  return "Critical";
}

/**
 * Scores a strict, case-sensitive, specification-ordered CVSS:4.0 vector.
 * Throws on malformed, duplicate, unknown, reordered or missing Base metrics.
 * Canonical output omits optional X values (equivalent to absent); Base output
 * always removes all Threat, Environmental and Supplemental metrics.
 * Explicit non-X Threat/Environmental values determine nomenclature even when
 * they equal a scoring default. Supplemental metrics never affect the score.
 * CVSS is owned by FIRST.Org, Inc. and used by permission.
 */
export function scoreScaCvssV4(vector: string): ScaCvssV4Result {
  const metrics = parseVector(vector);
  const baseMetrics = new Map(BASE.map((name) => [name, required(metrics.get(name))]));
  const score = calculate(metrics);
  const threat = metrics.has("E") && metrics.get("E") !== "X";
  const environmental = ENVIRONMENTAL.some(
    (name) => metrics.has(name) && metrics.get(name) !== "X"
  );
  return {
    score,
    vector: canonicalVector(metrics, ORDER),
    nomenclature: threat
      ? environmental
        ? "CVSS-BTE"
        : "CVSS-BT"
      : environmental
        ? "CVSS-BE"
        : "CVSS-B",
    rating: rating(score),
    base_score: calculate(baseMetrics),
    base_vector: canonicalVector(baseMetrics, BASE),
  };
}
