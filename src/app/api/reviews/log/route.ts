import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const prId = searchParams.get("prId");

    if (!prId) {
      return NextResponse.json({ error: "Missing prId query parameter" }, { status: 400 });
    }

    const logs = await prisma.reviewLog.findMany({
      where: { prId },
      orderBy: { createdAt: "asc" },
      take: 100,
      select: { id: true, message: true, level: true, createdAt: true },
    });

    if (logs.length > 0) {
      const lastFew = logs.slice(-3).map(l => `[${l.level}] ${l.message.slice(0,60)}`).join(" | ");
      console.log(`[scan] log-api: returning ${logs.length} logs for prId=${prId} -- ${lastFew}`);
    } else {
      console.log(`[scan] log-api: returning 0 logs for prId=${prId}`);
    }

    return NextResponse.json(logs);
  } catch (err: any) {
    console.error("Failed to fetch review logs:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
