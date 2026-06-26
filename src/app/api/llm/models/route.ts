import { NextResponse } from "next/server";
import { fetchRemoteModels, readPresets } from "@/src/lib/llmPresets";
import { authenticateSessionOrKey } from "@/src/lib/apiAuth";

/**
 * Proxies the model catalog from an OpenAI-compatible /v1/models endpoint.
 * Doubles as a connection test — a 200 means the endpoint is reachable and
 * the key is valid. The browser never sees the stored API key directly.
 *
 * If the body's apiKey is empty, the server looks up the stored key for
 * a preset with a matching endpoint (lets the user re-fetch the catalog
 * without re-entering the key in the masked UI).
 */
export async function POST(req: Request) {
  // Route-level auth: leaks preset endpoints + acts as connection test
  // (any caller could enumerate which providers are configured). proxy.ts
  // is cookie-PRESENCE only — must validate the session.
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  try {
    const body = await req.json().catch(() => ({}));
    const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";

    let effectiveKey = apiKey;
    if (!effectiveKey && endpoint) {
      const match = readPresets().presets.find((p) => p.endpoint === endpoint);
      if (match) effectiveKey = match.apiKey;
    }

    const result = await fetchRemoteModels(endpoint, effectiveKey);
    if (!result.ok) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 400 },
      );
    }
    return NextResponse.json({
      success: true,
      count: result.count,
      models: result.models,
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || String(err) },
      { status: 500 },
    );
  }
}
