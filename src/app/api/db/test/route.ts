import { NextResponse } from "next/server";
import { buildConnectionString, testConnectionString } from "@/src/lib/dbConfig";
import { authenticateSessionOrKey } from "@/src/lib/apiAuth";

export async function POST(req: Request) {
  // Auth: connection test takes DB credentials in the body — must be gated.
  // proxy.ts is cookie-PRESENCE only.
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  try {
    const body = await req.json().catch(() => ({}));
    const cs = buildConnectionString({
      dialect: body.dialect,
      host: body.host,
      port: body.port,
      username: body.username,
      password: body.password,
      database: body.database,
    });

    if (!cs) {
      return NextResponse.json(
        { success: false, error: "No connection details supplied." },
        { status: 400 },
      );
    }

    const result = await testConnectionString(cs);
    if (!result.ok) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 400 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || String(err) },
      { status: 500 },
    );
  }
}
