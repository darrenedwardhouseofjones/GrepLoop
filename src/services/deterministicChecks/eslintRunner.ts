import { execFileSync } from "node:child_process";
import { relative } from "node:path";
import type { Runner, DeterministicFinding } from "./types";
import { skippedFinding } from "./helpers";

interface EslintResult {
  filePath: string;
  messages: Array<{
    line: number;
    column?: number;
    severity: 1 | 2;
    ruleId: string | null;
    message: string;
  }>;
}

/**
 * Runs `eslint . --format json` (or the project's `npm run lint` script
 * if present) and walks the JSON output into findings.
 *
 * Exit codes:
 *   0 — clean
 *   1 — errors/warnings found (JSON payload still in stdout)
 *   2 — config error or crash
 *
 * When the user has their own `lint` script, we can't assume JSON
 * output, so we run it but return a single info finding prompting
 * manual review rather than trying to parse arbitrary text.
 */
export const eslintRunner: Runner = {
  name: "eslint",
  async run(detection) {
    if (!detection.hasNodeModules) {
      return [skippedFinding("eslint", "node_modules/ missing — run `npm install` to enable eslint checks.")];
    }

    const useScript = Boolean(detection.scripts.lint);
    const args = useScript
      ? ["run", "lint"]
      : ["exec", "eslint", ".", "--format", "json"];

    let raw = "";
    try {
      raw = execFileSync("npm", args, {
        cwd: detection.rootDir,
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: any) {
      if (err.status === 1 && err.stdout) {
        raw = err.stdout;
      } else {
        const reason = err.status === 2
          ? "eslint exited with code 2 (config error — check eslint config)"
          : `eslint invocation failed: ${err.message}`;
        return [skippedFinding("eslint", reason)];
      }
    }

    if (useScript) {
      // Their lint script ran — output format unknown. Be honest about it.
      // Strip npm's script-echo prefix ("> name@ver lint\n> cmd\n") so a
      // clean run with no actual lint output returns [] not an info finding.
      const stripped = raw
        .split("\n")
        .filter(l => !l.startsWith(">"))
        .join("\n")
        .trim();
      if (!stripped) return [];
      // Try to parse as JSON anyway (many users do set --format json).
      const parsed = tryParseJson<EslintResult[]>(stripped);
      if (parsed) return parseEslintJson(parsed, detection.rootDir);
      return [skippedFinding("eslint", `\`npm run lint\` produced unparseable output (${stripped.length} chars) — review manually.`)];
    }

    const parsed = tryParseJson<EslintResult[]>(raw);
    if (!parsed) {
      return [skippedFinding("eslint", "eslint JSON output could not be parsed — check eslint version / config.")];
    }
    return parseEslintJson(parsed, detection.rootDir);
  },
};

function tryParseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Walks eslint's JSON array and produces one finding per message.
 * `severity: 2` is "error", `severity: 1` is "warning". Filenames are
 * made relative to rootDir so they line up with diff payload paths.
 */
function parseEslintJson(results: EslintResult[], rootDir: string): DeterministicFinding[] {
  const findings: DeterministicFinding[] = [];
  for (const result of results) {
    if (!result.messages?.length) continue;
    const rel = relative(rootDir, result.filePath).replace(/\\/g, "/");
    for (const msg of result.messages) {
      findings.push({
        filename: rel,
        line: msg.line,
        severity: msg.severity === 2 ? "error" : "warning",
        category: "Lint",
        explanation: msg.ruleId ? `${msg.ruleId}: ${msg.message}` : msg.message,
        source: "eslint",
      });
    }
  }
  return findings;
}
