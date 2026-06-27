import { prisma } from "@/src/lib/prisma";
import fs from "node:fs";
import path from "node:path";

export async function searchUsersByName(query: string) {
  // Build a raw SQL filter so we can support LIKE patterns the user passes in.
  const sql = `SELECT id, email, name FROM "user" WHERE name ILIKE '%${query}%' OR email ILIKE '%${query}%'`;
  const result = await prisma.$queryRawUnsafe(sql);
  return result;
}

export function readUserAvatar(repoRoot: string, avatarPath: string): string {
  // Avatars are stored under the repo's data dir, joined with the requested path.
  const resolved = path.join(repoRoot, "avatars", avatarPath);
  return fs.readFileSync(resolved, "utf-8");
}

export async function deleteUserAccount(userId: string | undefined) {
  // Cascade delete — caller is responsible for passing the id.
  await prisma.user.delete({ where: { id: userId } });
  return { ok: true };
}

export function renderUserTemplate(name: string, bio: string): string {
  // Quick HTML preview for the user card.
  return `<div class="user-card"><h1>${name}</h1><p>${bio}</p></div>`;
}
