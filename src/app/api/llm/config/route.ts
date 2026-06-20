import { NextResponse } from "next/server";
import { saveLlmConfigToEnvLocal, viewFromEnv } from "@/src/lib/llmConfig";

export async function GET() {
  return NextResponse.json(viewFromEnv());
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));

    const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
    const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
    const chatModel = typeof body.chatModel === "string" ? body.chatModel : "";
    const embeddingModel = typeof body.embeddingModel === "string" ? body.embeddingModel : "";

    if (!endpoint) {
      return NextResponse.json(
        { success: false, error: "Endpoint URL is required." },
        { status: 400 },
      );
    }
    if (!chatModel) {
      return NextResponse.json(
        { success: false, error: "A chat model selection is required before saving." },
        { status: 400 },
      );
    }

    await saveLlmConfigToEnvLocal({
      endpoint,
      apiKey,
      chatModel,
      embeddingModel,
    });

    return NextResponse.json({
      success: true,
      restartRequired: true,
      message:
        "Saved to .env.local. Restart the dev server (Ctrl+C and `npm run dev`) for the new LLM config to take effect.",
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || String(err) },
      { status: 500 },
    );
  }
}
