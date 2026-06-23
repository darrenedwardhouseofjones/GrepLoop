# Standards for Deploy-Key Remote Repos

## Currently applied

**None.** `agent-os/standards/index.yml` exists but is empty. No standards have been authored yet for this codebase.

## Standards this work *should* touch (to be authored)

These are the standards the implementation will implicitly follow. They should be written into `agent-os/standards/` (and referenced from `index.yml`) before or alongside Phase 0 shipping, so future contributors have the same paper trail.

### `api/response-format`
The registration API returns JSON. New endpoints (`POST /api/repos`, `POST /api/repos/[id]/webhook`) should follow whatever envelope shape the existing `/api/repos/*` handlers use. Audit `src/app/api/repos/route.ts` and existing handlers to extract the convention before Phase 3.

### `api/error-handling`
Crypto failures (missing `GREPLOOP_MASTER_KEY`, decrypt failure), git failures (clone timeout, auth rejected), and webhook verification failures (401 on HMAC mismatch) all need consistent error codes and messages. Phase 0 (`crypto.ts` throws loud) sets the tone.

### `database/migrations`
Phase 1 changes `Repository` schema (optional `path`, new encrypted-blob + webhook columns). Currently the repo uses `npx prisma db push` in dev. Decide whether to start creating migration files now or wait until the first release cut. Document the convention.

### `security/secrets-at-rest`
The AES-256-GCM + master-key pattern in Phase 0 will likely recur (MCP keys at rest, future credentials). Worth a standard once the pattern is proven. Should cover: master-key source (`GREPLOOP_MASTER_KEY` env, base64, 32 bytes), cipher/iv/tag column convention, fail-loud policy on missing key, no plaintext fallback.

### `shell/exec-pattern`
The split between safe `execFileSync("git", args, { cwd, env })` (Phase 2.1, borrowed from `getRealLocalPrs.ts`) and the injection-prone `execSync` string-interpolation it replaces (`webhook.ts:42-49`) is worth a standard. Rule: never interpolate user-derived or repo-derived strings into a shell command; always pass args as an array.

### `startup/instrumentation-hook`
The `instrumentation.ts` + `globalThis.__greploopAuditDone` guard pattern (Phase 0.3) will recur for any startup-time work (DB connectivity check, LLM endpoint ping, etc.). Worth documenting the Turbopack dev double-fire gotcha once.

---

When any of these are authored, update this file to cite them by name and remove them from the "to be authored" list.
