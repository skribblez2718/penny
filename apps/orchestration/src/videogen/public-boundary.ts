export interface PublicBoundaryInput {
  readonly path: string;
  readonly content: string;
}
export interface PublicBoundaryFinding {
  readonly path: string;
  readonly rule: "operator_path" | "endpoint" | "secret" | "model_default" | "downstream_binding";
}
/** Scoped source guard, not a secret scanner or runtime authorization. Callers choose source scope. */
export function inspectVideogenPublicBoundary(
  files: readonly PublicBoundaryInput[]
): readonly PublicBoundaryFinding[] {
  const rules: readonly {
    readonly rule: PublicBoundaryFinding["rule"];
    readonly pattern: RegExp;
  }[] = [
    { rule: "operator_path", pattern: /\/(?:home|Users|mnt|srv)\/[^\s"'`]+/u },
    {
      rule: "endpoint",
      pattern: /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|[a-z0-9.-]+)(?::[0-9]+)?/iu,
    },
    {
      rule: "secret",
      pattern: /(?:api_key|apiKey|password|secret|token)\s*[:=]\s*["'][^"']{8,}["']/iu,
    },
    {
      rule: "model_default",
      pattern: /(?:default_model|defaultModel|checkpoint_name|model_id)\s*[:=]\s*["'][^"']+["']/u,
    },
    {
      rule: "downstream_binding",
      pattern: /(?:downstream_project|operator_project|private_corpus)\s*[:=]\s*["'][^"']+["']/u,
    },
  ];
  return files.flatMap((file) =>
    rules
      .filter((x) => x.pattern.test(file.content))
      .map((x) => ({ path: file.path, rule: x.rule }))
  );
}
