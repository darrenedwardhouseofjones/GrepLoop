import { prisma } from "@/src/lib/prisma";

/**
 * Resolve a PR by ID, ordinal, or substring. ALWAYS scope to a repoId.
 *
 * @param param PR id, ordinal number, or substring.
 * @param repoId REQUIRED. Every API-authenticated caller has a repoId in
 *   scope (from the URL, body, or session→repo binding). All matching —
 *   exact, ordinal, endsWith, contains — is scoped to this repo, so an
 *   API key valid for one repo can never resolve PRs in another by
 *   guessing ordinals or substrings.
 *
 * Exact-by-id is also scoped: a caller passing a leaked ID from another
 *   repo gets null, not the cross-repo PR. Defense-in-depth over caller
 *   discipline — previous signature accepted `repoId?` and trusted every
 *   caller to pass it.
 */
export async function findPrByIdOrNumber(param: string, repoId: string): Promise<any | null> {
  const normalized = param.toString().trim();
  if (!normalized || !repoId) return null;

  const exact = await prisma.pullRequest.findUnique({ where: { id: normalized } });
  if (exact && exact.repoId === repoId) return exact;

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
