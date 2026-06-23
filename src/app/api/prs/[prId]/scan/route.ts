import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { runPrScan } from "@/reviewService";
import { refreshPrFiles } from "@/src/lib/getRealLocalPrs";
import { assertIndexFresh } from "@/src/lib/indexFreshness";
import { IndexingService } from "@/src/services/indexingService";

export async function POST(req: Request, { params }: { params: Promise<{ prId: string }> }) {
  const { prId } = await params;
  await req.json().catch(() => ({}));
  console.log(`[scan] route: POST received for prId=${prId}`);

  try {
    const pr = await prisma.pullRequest.findUnique({
      where: { id: prId },
      select: { repoId: true, sourceBranch: true, targetBranch: true },
    });
    if (!pr) {
      console.log(`[scan] route: PR ${prId} not found`);
      return NextResponse.json({ error: "PR not found." }, { status: 404 });
    }
    console.log(`[scan] route: PR found, repoId=${pr.repoId}, branch=${pr.sourceBranch}`);

    const repo = await prisma.repository.findUnique({
      where: { id: pr.repoId },
      select: { id: true, name: true, indexedAt: true, lastCommitHash: true, path: true, baseBranch: true },
    });
    if (!repo) {
      console.log(`[scan] route: repo not found for repoId=${pr.repoId}`);
      return NextResponse.json({ error: "Repository record not found." }, { status: 404 });
    }
    console.log(`[scan] route: repo=${repo.name}, indexedAt=${repo.indexedAt}, path=${repo.path}`);

    const freshness = assertIndexFresh(repo);
    if (freshness.ok === false) {
      console.log(`[scan] route: freshness not ok kind=${freshness.kind} message=${freshness.message}`);
      if (freshness.kind === "INDEX_REQUIRED") {
        console.log(`[scan] route: INDEX_REQUIRED - returning 409`);
        return NextResponse.json(
          { error: freshness.kind, message: freshness.message, repoId: pr.repoId },
          { status: 409 },
        );
      }
      console.log(`[scan] route: STALE_INDEX - triggering incremental index`);
      if (repo.path) {
        await IndexingService.indexFolder(pr.repoId, repo.path);
        console.log(`[scan] route: incremental index complete`);
      }
    } else {
      console.log(`[scan] route: freshness check OK (indexedAt=${repo.indexedAt})`);
    }

    await prisma.pullRequest.updateMany({ where: { id: prId }, data: { status: 'In Progress' } });
    const deletedLogs = await prisma.reviewLog.deleteMany({ where: { prId } });
    console.log(`[scan] route: status set to In Progress, deleted ${deletedLogs.count} stale review logs`);

    const repoPath = repo.path;
    const baseBranch = pr.targetBranch || repo.baseBranch || "main";
    let files: any[] = [];
    if (repoPath && pr.sourceBranch) {
      console.log(`[scan] route: refreshing PR files from git`);
      files = await refreshPrFiles(repoPath, baseBranch, pr.sourceBranch, prId);
      console.log(`[scan] route: got ${files.length} files`);
    } else {
      console.log(`[scan] route: no repoPath or sourceBranch - skipping file refresh`);
    }

    console.log(`[scan] route: calling runPrScan with ${files.length} files`);
    const result = await runPrScan(prId, files);
    console.log(`[scan] route: runPrScan complete - rating=${result.rating}, findings=${result.findings?.length}, model=${result.usedModel}`);

    return NextResponse.json(result);
  } catch (err: any) {
    console.error(`[scan] route: ERROR:`, err);
    try {
      await prisma.pullRequest.updateMany({ where: { id: prId }, data: { status: 'Failed' } });
      console.log(`[scan] route: PR status set to Failed`);
    } catch (dbErr) {
      console.error(`[scan] route: failed to mark PR as Failed:`, dbErr);
    }
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
