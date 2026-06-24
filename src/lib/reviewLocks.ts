/**
 * Shared in-progress review tracker. Maps prId → start timestamp.
 *
 * Hoisted out of the command route so the in-app scan route
 * (`/api/prs/[prId]/scan`) shares the SAME lock — otherwise two concurrent
 * scans of one PR race `reviewFinding.deleteMany`→`createMany`,
 * double-increment `reviewsCount`, and write duplicate `reviewHistory`.
 * Both routes run in the same Node process, so this module singleton is
 * shared between them.
 *
 * Why TTL: a review that hangs (network partition, LLM stall, an unhandled
 * rejection that bypasses .catch) would otherwise sit in the Map forever,
 * blocking re-reviews. Entries older than REVIEW_TTL_MS are evicted on read
 * and the caller can re-queue.
 *
 * Restart note: in-memory only. A server crash mid-review loses the entry —
 * the PR simply appears "not in progress" and the caller can re-trigger.
 * Acceptable for single-user dev; a persistent queue is the production fix.
 */
const activeReviews = new Map<string, number>();
const REVIEW_TTL_MS = 5 * 60 * 1000;

export function isReviewActive(prId: string): boolean {
  const startedAt = activeReviews.get(prId);
  if (!startedAt) return false;
  if (Date.now() - startedAt > REVIEW_TTL_MS) {
    activeReviews.delete(prId);
    console.warn(`[review] lock timed out for ${prId} (>${REVIEW_TTL_MS}ms) — evicted`);
    return false;
  }
  return true;
}

/** Mark a PR's review as in-flight. */
export function beginReview(prId: string): void {
  activeReviews.set(prId, Date.now());
}

/** Clear a PR's in-flight marker (call in finally / .catch). */
export function endReview(prId: string): void {
  activeReviews.delete(prId);
}
