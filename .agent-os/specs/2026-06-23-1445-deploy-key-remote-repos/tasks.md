# Tasks — Deploy-Key Remote Repos

Mark each task `- [x]` when complete. Add follow-up tasks under "Discovered during work" as the implementation surfaces them.

## Pre-flight

- [ ] **Revoke leaked MCP API key** in `opencode.json` (commit `4fc0596`). Key: `gl_mcp_835aa1df03b5c663832e0fe76496e67926adef72a126dff19f311e9881710a2a`. Revoke from UI → MCP API Keys. Local-only commit, no push has happened.
- [ ] **Clean up commit `4fc0596`** — soft reset `HEAD~1`, add `opencode.json` to `.gitignore`, recommit the consolidated `/gloop` skill work without the secret.

## Phase 0 — Crypto + startup hardening (no DB changes)

- [ ] **0.1** `src/lib/crypto.ts` — AES-256-GCM wrapper. Exports `encryptSecret`, `decryptSecret`, `hasMasterKey`. Master key from `GREPLOOP_MASTER_KEY` (base64, 32 bytes), cached in `globalThis`. Fail loud if missing/malformed.
- [ ] **0.2** `src/lib/startupAudit.ts` — chmod 0600 enforcement on `.env*` and `.greploop/*`. Fixes mode + logs warning; never throws.
- [ ] **0.3** `src/instrumentation.ts` — Next.js startup hook. Calls `startupAudit()` once per boot via `globalThis.__greploopAuditDone` guard.
- [ ] **Verify:** Crypto round-trip test (`encryptSecret("hello")` → `decryptSecret(...)` returns `"hello"`). Startup audit fixes a deliberately loose `.env.local` back to 0600.

## Phase 1 — Schema migration

- [ ] **1.1** Edit `prisma/schema.prisma` Repository model: `path String? @unique`, add `provider`, `cloneUrl`, `deployKeyCipher/Iv/Tag`, `patCipher/Iv/Tag`, `webhookSecret`, `webhookId`, `lastFetchAt`, `localPath`.
- [ ] **1.2** `npx prisma db push` in dev.
- [ ] **Verify:** Existing local-repo registration still works end-to-end. No type errors in the 11 places that read `repo.path`.

## Phase 2 — Remote git access

- [ ] **2.1** `src/lib/gitRemote.ts` — `cloneRepo`, `fetchRepo`, `buildSshEnv`. All shell calls via `execFileSync("git", args, { cwd, env })`. SSH deploy key written to mode-0600 tmp file, unlinked after use.
- [ ] **2.2** `src/services/remoteFetchWorker.ts` — deduped fetch+index worker using `indexingService.indexRepo()`. Per-repo Set-based lock.
- [ ] **Verify:** Clone a test remote repo manually via a one-off script. Confirm `repos/<id>/` directory appears, `localPath` is persisted.

## Phase 3+4 — Registration API + webhook setup

- [ ] **3.1** Modify existing repo-registration POST handler for `{ mode, path?, cloneUrl?, deployKey?, cloneUrlHttps?, pat? }` request shape. Encrypts secrets, kicks off `remoteFetchWorker.enqueue()`.
- [ ] **4.1** `src/lib/webhookSetup.ts` — `setupWebhookWithPat()` (GitHub + GitLab auto-create) and `getManualWebhookInstructions()` (fallback). Reads `GREPLOOP_PUBLIC_URL` env.
- [ ] **4.2** `src/app/api/repos/[id]/webhook/route.ts` — POST to set up webhook, DELETE to tear down.
- [ ] **Verify:** Register a remote repo in PAT mode, click "set up webhook automatically", confirm `webhookId` populates in DB. Register in SSH mode (no PAT), confirm manual instructions appear.

## Phase 5+6 — Webhook hardening + UI

- [ ] **5.1** Wire `verifyGithubSignature()` into `src/app/api/webhooks/github/route.ts`. Equivalent for GitLab. Return 401 on mismatch.
- [ ] **5.2** Replace `gitFetch()` body in `src/lib/webhook.ts:42-49` with delegate to `gitRemote.fetchRepo()`.
- [ ] **5.3** Both webhook handlers enqueue `remoteFetchWorker` instead of fetching inline. Return 200 fast.
- [ ] **6.1** Split AddRepoModal into Local-path + Remote-repo tabs (new modal directory if file exceeds 500 lines).
- [ ] **6.2** Remote tab fields: clone URL, mode toggle (SSH/PAT), secret textarea. Post-success webhook-setup prompt.
- [ ] **Verify:** Push a commit to a registered remote repo. Confirm webhook arrives, signature verifies, `lastFetchAt` updates, `/gloop <n>` returns findings against the latest state. Tampered signature → 401.

## Discovered during work

_(empty — add tasks here as the implementation surfaces them)_
