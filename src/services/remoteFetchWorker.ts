import { prisma } from "../lib/prisma";
import { decryptSecret, hasMasterKey } from "../lib/crypto";
import { cloneRepo, fetchRepo } from "../lib/gitRemote";
import { IndexingService } from "./indexingService";

const activeFetches = new Set<string>();

export function isFetching(repoId: string): boolean {
  return activeFetches.has(repoId);
}

export async function enqueue(repoId: string): Promise<void> {
  if (activeFetches.has(repoId)) return;
  activeFetches.add(repoId);

  try {
    const repo = await prisma.repository.findUnique({ where: { id: repoId } });
    if (!repo) throw new Error(`Repository not found: ${repoId}`);
    if (repo.provider === "local" || !repo.cloneUrl) {
      throw new Error(`Repository ${repoId} is not a remote repo`);
    }

    let deployKey: string | undefined;
    let pat: string | undefined;

    if (repo.deployKeyCipher && repo.deployKeyIv && repo.deployKeyTag) {
      if (!hasMasterKey()) throw new Error("GREPLOOP_MASTER_KEY is not set");
      deployKey = decryptSecret(repo.deployKeyCipher, repo.deployKeyIv, repo.deployKeyTag);
    }

    if (repo.patCipher && repo.patIv && repo.patTag) {
      if (!hasMasterKey()) throw new Error("GREPLOOP_MASTER_KEY is not set");
      pat = decryptSecret(repo.patCipher, repo.patIv, repo.patTag);
    }

    let localPath = repo.localPath;
    if (!localPath) {
      localPath = cloneRepo({ repoId, cloneUrl: repo.cloneUrl, deployKey, pat });
      await prisma.repository.update({
        where: { id: repoId },
        data: { localPath },
      });
    } else {
      fetchRepo({ localPath, cloneUrl: repo.cloneUrl, deployKey, pat });
    }

    await IndexingService.indexFolder(repoId, localPath);

    await prisma.repository.update({
      where: { id: repoId },
      data: { lastFetchAt: new Date() },
    });
  } finally {
    activeFetches.delete(repoId);
  }
}
