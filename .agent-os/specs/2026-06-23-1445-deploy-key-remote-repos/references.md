# References for Deploy-Key Remote Repos

Existing patterns borrowed by the implementation. Read these before writing any new code in Phase 0+.

## Safe shell execution

### `src/lib/getRealLocalPrs.ts:6-8`
- **Relevance:** Canonical safe pattern for invoking git in this codebase.
- **Pattern:** `execFileSync("git", ["log", ...], { cwd })` — args as array, no shell interpolation.
- **Borrow for:** `src/lib/gitRemote.ts` (Phase 2.1) — `cloneRepo` and `fetchRepo`. Never use `execSync` with string interpolation.

### `src/lib/webhook.ts:42-49` (existing `gitFetch()`)
- **Relevance:** The pattern to **replace**. Currently uses `execSync` with string-interpolated repo paths — an injection vector if any path contains shell metacharacters.
- **Borrow for:** Phase 5.2 — gut the body, delegate to `gitRemote.fetchRepo(repo)`.

## Atomic file writes with chmod

### `src/lib/llmPresets.ts:162-177`
- **Relevance:** Existing atomic-write pattern for secret files. Write to temp, chmod 0600, rename over target. Survives crashes mid-write.
- **Borrow for:** Phase 2.1 `buildSshEnv()` — when writing the decrypted deploy key to a tmp file for `GIT_SSH_COMMAND`. Tmp file must be mode 0600, used once, then unlinked.

## `globalThis` singleton with Turbopack guard

### `src/lib/prisma.ts` + `src/lib/llmClient.ts`
- **Relevance:** The lazy-singleton pattern this codebase uses for module-level state. The `globalThis` guard prevents duplicate instances during Turbopack dev's double-fire of module imports.
- **Borrow for:** Phase 0.1 `crypto.ts` — cache the derived AES key in `globalThis.__greploopMasterKey` so re-imports don't re-derive. Phase 0.3 `instrumentation.ts` — `globalThis.__greploopAuditDone` to make the startup audit idempotent.

## In-memory concurrency lock

### `src/services/indexingService.ts:48`
- **Relevance:** Existing `activeIndexers = new Set<string>()` Set-based lock. Prevents the same repo from being indexed twice concurrently.
- **Borrow for:** Phase 2.1 `gitRemote.ts` — same Set pattern to prevent double-clone. Phase 2.2 `remoteFetchWorker.ts` — dedupe per-repo jobs.

## Secret hashing

### `src/lib/mcpAuth.ts:6-15`
- **Relevance:** How this codebase hashes secrets at rest (SHA-256). MCP API keys use this — they're never stored plaintext, only their hash.
- **Borrow for:** Reference for the "DB never sees the plaintext" mental model. Phase 0.1 crypto uses symmetric encryption (because deploy keys and PATs need to be *used*, not just *verified*), but the storage discipline is the same.

## Webhook HMAC verification (existing but unused)

### `src/lib/webhook.ts:5-15` (`verifyGithubSignature()`)
- **Relevance:** Already implemented. Already imported nowhere. This is the gap.
- **Borrow for:** Phase 5.1 — call this at the top of the GitHub webhook handler with the per-repo `webhookSecret`. Return 401 on mismatch.

### `src/app/api/webhooks/github/route.ts` + `gitlab/route.ts`
- **Relevance:** Existing webhook handlers. Parse events, call `gitFetch()` + `scanRepoPrs()`. Already work — they just don't verify signatures.
- **Borrow for:** Phase 5.3 — add signature verification, then swap inline `gitFetch` for `remoteFetchWorker.enqueue(repoId)` so the handler returns 200 fast.

## Schema

### `prisma/schema.prisma` — `Repository` model
- **Relevance:** Today's schema. Has 14 fields; only `path` is filesystem-specific. Read by name (`repo.path`, `repository.path`) in 11 places across the codebase.
- **Borrow for:** Phase 1 — making `path` optional is source-compatible with existing readers (local repos still set it). New remote-repo fields live alongside; no breaking rename.
