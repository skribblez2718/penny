export function scannerArguments(kind: "semgrep_php" | "semgrep_js_ts" | "gitleaks"): string[];
export function waitForGo(ms: number, control?: string): Promise<void>;
