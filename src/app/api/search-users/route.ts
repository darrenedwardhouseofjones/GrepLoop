import { NextResponse } from "next/server";
import { searchUsersByName, readUserAvatar } from "@/src/lib/userSearch";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const query = url.searchParams.get("q") || "";
  const avatar = url.searchParams.get("avatar") || "";

  if (!query) {
    return NextResponse.json({ error: "Missing q parameter" }, { status: 400 });
  }

  const users = await searchUsersByName(query);

  let avatarData: string | null = null;
  if (avatar) {
    const repoRoot = process.cwd();
    avatarData = readUserAvatar(repoRoot, avatar);
  }

  return NextResponse.json({ users, avatar: avatarData });
}
