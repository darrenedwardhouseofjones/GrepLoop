import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

/**
 * Next.js 16 network-boundary gate (the renamed `middleware` convention —
 * Vercel PR #84119). Requires a Better Auth session for the JSON API.
 *
 * This is a lightweight cookie-PRESENCE check only — it never touches the
 * database (Prisma is Node-only and can't run at the network boundary).
 * Full DB-backed validation stays in the Node route handlers via
 * `requireSession()` on the secret-handling routes.
 *
 * The matcher deliberately excludes endpoints that authenticate by other
 * means, so they must NOT be gated by a browser session cookie:
 *   - /api/auth/*       Better Auth's own handler (login/register/session)
 *   - /api/webhooks/*   HMAC-verified (verifyGithubSignature)
 *   - /api/hooks/*      API key (Authorization: Bearer gl_…) from the CLI/hook
 *   - /api/command, /api/prcheck, /api/prcomments  API-key endpoints (skill/CLI)
 *
 * Note: /api/keys is intentionally NOT excluded — key minting/listing
 * must require a logged-in session (it's a browser-only, UI-driven route).
 */
export async function proxy(req: NextRequest) {
  const session = getSessionCookie(req);
  if (!session) {
    return NextResponse.json(
      {
        error:
          "Unauthorized. Sign in to GrepLoop, or call API-key endpoints " +
          "(/api/command, /api/prcheck, /api/prcomments, /api/hooks/*) with Authorization: Bearer gl_<key>.",
      },
      { status: 401 },
    );
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/api/((?!auth|webhooks|hooks|command|prcheck|prcomments).*)",
  ],
};
