import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { findPrByIdOrNumber } from "@/src/lib/findPr";
import { runPrScan } from "@/reviewService";
import { authenticateApiRequest } from "@/src/lib/apiAuth";
import { IndexingService } from "@/src/services/indexingService";
import { assertIndexFresh } from "@/src/lib/indexFreshness";

export async function GET(req: Request, { params }: { params: Promise<{ prIdOrNumber: string }> }) {
  const auth = await authenticateApiRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ status: "Error", message: auth.error }, { status: 401 });
  }

  const { prIdOrNumber } = await params;
  try {
    const url = new URL(req.url);
    const repoId = url.searchParams.get("repoId") || undefined;
    const pr = await findPrByIdOrNumber(prIdOrNumber, repoId);
    if (!pr) {
      return NextResponse.json({
        status: "Error",
        message: `Pull request reference "${prIdOrNumber}" could not be matched in the database.`
      }, { status: 404 });
    }

    const repo = await prisma.repository.findUnique({
      where: { id: pr.repoId },
      select: { id: true, name: true, indexedAt: true, lastCommitHash: true, path: true },
    });
    if (!repo) {
      return NextResponse.json({
        status: "Error",
        message: `Repository for PR "${prIdOrNumber}" could not be loaded.`,
      }, { status: 404 });
    }

    const freshness = assertIndexFresh(repo);
    if (freshness.ok === false) {
      if (freshness.kind === "INDEX_REQUIRED") {
        return NextResponse.json({ status: "Error", message: freshness.message }, { status: 409 });
      }
      // STALE_INDEX — auto-trigger incremental index
      if (repo.path) {
        await IndexingService.indexFolder(pr.repoId, repo.path);
      }
    }

    const scanResult = await runPrScan(pr.id);
    const isProductionReady = scanResult.rating >= 8;

    return NextResponse.json({
      status: "Success",
      prId: pr.id,
      title: pr.title,
      productionGrade: isProductionReady ? "YES" : "NO",
      rating: `${scanResult.rating}/10`,
      assessment: isProductionReady
        ? "This Pull Request is highly secure, performant, correct, and fully production grade."
        : "NOT production grade. Please review the blocker/warning findings in comments and refactor.",
      usedModel: scanResult.usedModel,
      findingsCount: scanResult.findings.length,
      findings: scanResult.findings.map((f: any) => ({
        category: f.category,
        severity: f.severity,
        filename: f.filename,
        line: f.line,
        explanation: f.explanation,
        diffSuggestion: f.diffSuggestion,
        evidenceChain: f.evidenceChain || []
      })),
      systemWarn: scanResult.systemWarn
    });
  } catch (err: any) {
    console.error("[prcheck error]:", err);
    return NextResponse.json({ status: "Error", message: err.message }, { status: 500 });
  }
}
