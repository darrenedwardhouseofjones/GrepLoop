/**
 * Next.js instrumentation hook — runs `register()` once on server boot,
 * before any request is served. Next.js 16 auto-discovers this file at
 * `src/instrumentation.ts`.
 *
 * Used here to sweep orphaned `ReviewRun` rows (status=in_progress past
 * the stale TTL) so a freshly restarted server doesn't present bricked
 * PRs to the operator. See `src/services/runReaper.ts` for the why.
 *
 * Errors are swallowed — boot must not fail just because the reaper
 * couldn't reach the DB. Layer 2 in `assertNoActiveScan` will retry on
 * the next request.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Dynamic import keeps this code out of the edge bundle and avoids
  // loading Prisma during module evaluation of instrumentation.ts
  // (which would break `next build` on empty env).
  const { reapStaleRuns } = await import("./services/runReaper");
  void reapStaleRuns();
}
