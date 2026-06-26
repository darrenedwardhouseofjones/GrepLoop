import { NextResponse } from "next/server";
import { getPublicUrl } from "@/src/lib/publicUrl";
import { authenticateSessionOrKey } from "@/src/lib/apiAuth";

export async function GET(req: Request) {
  // Route-level auth: exposes configured public URL (deployment metadata).
  // proxy.ts is cookie-PRESENCE only — must validate the session.
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  try {
    return NextResponse.json(getPublicUrl());
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
