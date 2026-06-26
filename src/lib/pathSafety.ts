import fs from "node:fs";
import path from "node:path";

/**
 * Resolves `candidate` against `repoPath` and returns the real on-disk
 * absolute path if it stays inside the repo, or null if it escapes.
 *
 * Defends against:
 *   - **Absolute paths** — `path.join("/repo", "/etc/passwd")` returns
 *     `"/etc/passwd"`, discarding the base. Naive `startsWith(repoPath)`
 *     checks also fall to this when the candidate is absolute.
 *   - **`..` traversal** — `path.join("/repo", "../../etc/passwd")`
 *     escapes the sandbox.
 *   - **Symlink escape** — a symlink inside the repo pointing at
 *     `/etc/passwd` passes the lexical `path.relative` check, but the
 *     `realpathSync` resolves to the target. We re-check after resolving.
 *
 * Why not `startsWith`? `"/home/u/myrepo".startsWith("/home/u/myrepo")`
 * is true for `"/home/u/myrepo-secrets/..."` — a sibling directory that
 * shares the prefix. `path.relative` + `..` check is the safe form.
 *
 * Used by:
 *   - `reviewService.ts` readFile tool (LLM-controlled `filePath`)
 *   - `indexOrchestrator.ts` startBackgroundEnrichment (DB-stored `sym.filePath`)
 *   - `findingVerifier.ts` loadFileContent (LLM-cited `filename`)
 *
 * All three accept untrusted input that could escape the repo sandbox
 * without this check.
 *
 * Residual TOCTOU: a small window exists between `resolveSafePath`
 * returning and the caller calling `fs.readFileSync(path)`. An attacker
 * with write access inside the repo could swap the leaf file for a
 * symlink to `/etc/passwd` in that window. Callers that need to close
 * this window should use `safeReadFileSync` below, which performs the
 * open with O_NOFOLLOW and reads from the resulting fd.
 */
export function resolveSafePath(repoPath: string, candidate: string): string | null {
  const base = path.resolve(repoPath);
  const absolute = path.resolve(base, candidate);
  const rel = path.relative(base, absolute);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  try {
    const realPath = fs.realpathSync(absolute);
    const realBase = fs.realpathSync(base);
    const realRel = path.relative(realBase, realPath);
    if (realRel.startsWith("..") || path.isAbsolute(realRel)) return null;
    return realPath;
  } catch {
    return null; // ENOENT etc — caller handles "missing"
  }
}

/**
 * Resolve + open + read in one step, closing the TOCTOU window that
 * `resolveSafePath` + `fs.readFileSync` would leave open. The fd is a
 * stable reference to the file at open time — if an attacker swaps the
 * path for a symlink between resolveSafePath and the open, the
 * O_NOFOLLOW flag refuses the leaf symlink.
 *
 * Returns the file contents as a string, or null if the path escapes
 * the repo, doesn't exist, or isn't a regular file.
 */
export function safeReadFileSync(repoPath: string, candidate: string): string | null {
  const safePath = resolveSafePath(repoPath, candidate);
  if (safePath === null) return null;
  let fd: number | null = null;
  try {
    // O_NOFOLLOW refuses to follow if the FINAL component is a symlink.
    // realpathSync already resolved intermediate symlinks, so the only
    // remaining attack vector (leaf swap between resolve and open) is
    // blocked here.
    fd = fs.openSync(safePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stats = fs.fstatSync(fd);
    if (!stats.isFile()) return null;
    return fs.readFileSync(fd, "utf-8");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}
