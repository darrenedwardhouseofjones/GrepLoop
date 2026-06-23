import { prisma } from "@/src/lib/prisma";

export async function findPrByIdOrNumber(param: string): Promise<any | null> {
  const normalized = param.toString().trim();
  if (!normalized) return null;

  let pr = await prisma.pullRequest.findUnique({ where: { id: normalized } });
  if (pr) return pr;

  if (/^\d+$/.test(normalized)) {
    pr = await prisma.pullRequest.findUnique({ where: { id: `pr-${normalized}` } });
    if (pr) return pr;

    const list = await prisma.pullRequest.findMany({
      where: { id: { endsWith: `-${normalized}` } },
    });
    if (list.length > 0) return list[0];

    const ordinal = await prisma.pullRequest.findMany({
      orderBy: { createdAt: "asc" },
      skip: parseInt(normalized, 10) - 1,
      take: 1,
    });
    if (ordinal.length > 0) return ordinal[0];
  }

  const fallback = await prisma.pullRequest.findFirst({
    where: { id: { contains: normalized } },
  });
  return fallback || null;
}

export async function findPrByBranch(repoId: string, branch: string): Promise<any | null> {
  const pr = await prisma.pullRequest.findFirst({
    where: { repoId, sourceBranch: branch },
    orderBy: { createdAt: "desc" },
  });
  return pr || null;
}
