import { NextResponse } from "next/server";
import { getLatestCompletedReview } from "@/src/lib/reviewFreshness";

/**
 * GET /api/prs/[prId]/findings
 *
 * Returns findings for the PR's latest completed ReviewRun (excluding
 * verifier-rejected findings) plus a freshness signal.
 *
 * - `reviewRun`: metadata about the run (commitHash, diffHash, completedAt,
 *   rating) so the UI can show "Reviewed commit: abc1234".
 * - `stale`: true when the PR's current PrFile diff doesn't match the
 *   run's recorded diffHash (i.e. the diff has moved since the review).
 * - `rejectedCount`: how many findings the verifier rejected — surfaced as
 *   a collapsible "Verifier filtered: N findings" section in the UI.
 *
 * If no completed run exists, returns an empty findings list with
 * `reviewRun: null` so the UI can render the "no review yet" state.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ prId: string }> }) {
  try {
    const { prId } = await params;

    const latest = await getLatestCompletedReview(prId);

    if (!latest.reviewRun) {
      return NextResponse.json({
        reviewRun: null,
        findings: [],
        rejectedFindings: [],
        rejectedCount: 0,
        stale: false,
        message: "No completed review yet. Run a scan.",
      });
    }

    return NextResponse.json({
      reviewRun: {
        id: latest.reviewRun.id,
        commitHash: latest.reviewRun.commitHash,
        diffHash: latest.reviewRun.diffHash,
        completedAt: latest.reviewRun.completedAt,
        rating: latest.reviewRun.rating,
        model: latest.reviewRun.model,
        triggerReason: latest.reviewRun.triggerReason,
      },
      findings: latest.findings,
      rejectedFindings: latest.rejectedFindings,
      rejectedCount: latest.rejectedCount,
      stale: latest.stale,
    });
  } catch (err: any) {
    console.error("Error fetching findings for PR:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
