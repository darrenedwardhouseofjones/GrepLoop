/* eslint-disable @typescript-eslint/no-require-imports */

export async function register() {
  const g = globalThis as typeof globalThis & { __greploopAuditDone?: boolean };
  if (g.__greploopAuditDone) return;
  g.__greploopAuditDone = true;

  let root: string;
  try {
    root = process.cwd();
  } catch {
    return;
  }

  const { existsSync, chmodSync, readdirSync, statSync } = require("fs");
  const { join } = require("path");

  const files: string[] = [];

  for (const name of [".env", ".env.local", ".env.production"]) {
    const p = join(root, name);
    if (existsSync(p)) files.push(p);
  }

  const greploopDir = join(root, ".greploop");
  if (existsSync(greploopDir)) {
    try {
      for (const entry of readdirSync(greploopDir)) {
        files.push(join(greploopDir, entry));
      }
    } catch {}
  }

  const fixed: string[] = [];
  for (const p of files) {
    try {
      const mode = statSync(p).mode;
      if (mode & 0o077) {
        chmodSync(p, 0o600);
        fixed.push(p);
      }
    } catch {}
  }
  if (fixed.length > 0) {
    console.warn(`[startup-audit] fixed mode to 0600: ${fixed.join(", ")}`);
  }
}
