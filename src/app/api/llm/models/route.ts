import { NextResponse } from "next/server";
import { fetchRemoteModels } from "@/src/lib/llmConfig";

/**
 * Proxies the model catalog from an OpenAI-compatible /v1/models endpoint.
 * Doubles as a connection test — a 200 means the endpoint is reachable and
 * the key is valid. The browser never sees the API key directly.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";

    // If the user left the key blank but one is already in env, use that
    // — lets them re-fetch the catalog without re-entering the key.
    const effectiveKey = apiKey || process.env.LLM_API_KEY || "";

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
