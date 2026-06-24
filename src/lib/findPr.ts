import { prisma } from "@/src/lib/prisma";

/**
 * Resolve a PR by ID, ordinal, or substring.
 *
 * @param param PR id, ordinal number, or substring.
 * @param repoId When provided, ALL matching is scoped to this repository.
 *   Callers that have a repoId in scope MUST pass it — without it, fuzzy
 *   matching (ordinal, endsWith, contains) is disabled because an API key
 *   valid for one repo could otherwise resolve PRs in another by guessing
 *   numbers or substrings.
 */
export async function findPrByIdOrNumber(param: string, repoId?: string): Promise<any | null> {
  const normalized = param.toString().trim();
  if (!normalized) return null;

  const exact = await prisma.pullRequest.findUnique({ where: { id: normalized } });
  if (exact && (!repoId || exact.repoId === repoId)) return exact;

  if (!repoId) {
    return null;
  }

  if (/^\d+$/.test(normalized)) {
    const synth = await prisma.pullRequest.findUnique({ where: { id: `pr-${normalized}` } });
    if (synth && synth.repoId === repoId) return synth;

    const list = await prisma.pullRequest.findMany({
      where: { repoId, id: { endsWith: `-${normalized}` } },
    });
    if (list.length > 0) return list[0];

    const ordinal = await prisma.pullRequest.findMany({
      where: { repoId },
      orderBy: { createdAt: "asc" },
      skip: parseInt(normalized, 10) - 1,
      take: 1,
    });
    if (ordinal.length > 0) return ordinal[0];
  }

  const fallback = await prisma.pullRequest.findFirst({
    where: { repoId, id: { contains: normalized } },
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
