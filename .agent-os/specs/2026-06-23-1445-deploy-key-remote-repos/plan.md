# PRD §8.3 — Deploy-Key Repo Registration (Remote Repos)

## Context

GrepLoop today only indexes repos that live on the same filesystem as the server (`Repository.path` is a non-null `String`). The product wedge is now **cost + control + multi-LLM ensemble**: the server may run on an office box while the user's repos live on GitHub/GitLab. To support that, GrepLoop needs to clone or fetch a remote repo using a user-supplied credential (SSH deploy key or PAT), index it the same way it indexes a local path, and stay in sync via webhook.

Two cross-cutting concerns make this more than a clone-and-fetch task:

1. **The credential is a secret at rest.** A deploy private key or PAT stored in plaintext in Postgres becomes a privilege-escalation vector the moment the DB leaks. The user explicitly asked for "most secure" storage — we encrypt at rest with AES-256-GCM under a master key the DB never sees.
2. **GrepLoop must refuse to start if its own config files are world-readable.** Per user instruction, `.env*` and `.greploop/*` must be `chmod 0600`. If they aren't, the server fixes them and warns — never silently continues.

Outcome: a user can register a GitHub repo from the UI by pasting either an SSH deploy key+URL or a fine-grained PAT; GrepLoop clones it, indexes it, and optionally sets up the webhook itself using the PAT; pushes to the repo then trigger re-indexing automatically.

---

## Phase 0 — Crypto + startup hardening (no DB changes)

### 0.1 `src/lib/crypto.ts` (new, ~80 lines)

AES-256-GCM wrapper. Master key from `GREPLOOP_MASTER_KEY` (32-byte, base64). Key derived once at module load, cached in `globalThis` (mirror the `prisma.ts` / `llmClient.ts` singleton pattern).

Exports:
- `encryptSecret(plaintext: string): { cipher: string; iv: string; tag: string }` — all base64.
- `decryptSecret(cipher: string, iv: string, tag: string): string`.
- `hasMasterKey(): boolean` — for the registration UI to show a "set `GREPLOOP_MASTER_KEY` first" message.

Fail loud: if `GREPLOOP_MASTER_KEY` is missing or wrong length, throw at first use — don't silently fall back to plaintext.

### 0.2 `src/lib/startupAudit.ts` (new, ~60 lines)

Walks the list of secret-bearing files and enforces mode 0600:
- `.env`, `.env.local`, `.env.production`
- Everything under `.greploop/` (recursive)

For each: if it exists and `stat.mode & 0o077 !== 0`, `fs.chmod(path, 0o600)` and log a warning. Never throw — the goal is to fix and continue, not block startup. Returns a list of fixed paths for logging.

### 0.3 `src/instrumentation.ts` (new, ~25 lines)

Next.js startup hook. Calls `startupAudit()` inside a `globalThis.__greploopAuditDone` guard (Turbopack dev double-fire protection — same pattern as `prisma.ts`). Runs before any route handler is mounted, so secret files are guaranteed 0600 by the time the first request lands.

---

## Phase 1 — Schema migration

Edit `prisma/schema.prisma` (`Repository` model):

- `path String? @unique` — make optional. Local repos keep it; remote repos have `null`.
- Add: `provider String?` (`"github"` | `"gitlab"` | `"local"`)
- Add: `cloneUrl String?` — `git@github.com:...` or `https://...`
- Add: `deployKeyCipher String?`, `deployKeyIv String?`, `deployKeyTag String?` — encrypted SSH private key
- Add: `patCipher String?`, `patIv String?`, `patTag String?` — encrypted PAT (alternative to deploy key)
- Add: `webhookSecret String?` — HMAC secret (plaintext; it's a verifier not a credential, and the DB needs it to verify inbound webhooks)
- Add: `webhookId String?` — provider's webhook ID, for later deletion
- Add: `lastFetchAt DateTime?`
- Add: `localPath String?` — where the clone lives on disk (server-side, not user-supplied)

Run `npx prisma db push` in dev. No migration file needed until we cut a release.

`Repository.path` is read by name in 11 places (search shows `repo.path`, `repository.path`). Optional `String?` is source-compatible — existing local-repo code keeps working because those repos still have a `path`. New code paths use `localPath` for the clone directory.

---

## Phase 2 — Remote git access

### 2.1 `src/lib/gitRemote.ts` (new, ~140 lines)

All shell calls use **`execFileSync("git", args, { cwd, env })`** — never `execSync` with string interpolation. Template: `src/lib/getRealLocalPrs.ts:6-8`.

Exports:
- `cloneRepo(repo: Repository): Promise<string>` — clones into `repos/<repoId>/` (server-managed directory under the project root, added to `.gitignore`). Returns the local path. Stores it back as `localPath` in the DB.
- `fetchRepo(repo: Repository): Promise<void>` — `git -C <localPath> fetch --all --prune`. Idempotent.
- `buildSshEnv(repo: Repository): NodeJS.ProcessEnv` — returns `process.env` plus `GIT_SSH_COMMAND=ssh -i <tmpkey> -o StrictHostKeyChecking=no`. The tmp key is written from the decrypted deploy key to a mode-0600 temp file, used for the fetch, then unlinked. Never written into the repo directory.

In-memory lock to prevent double-clone: reuse the `activeIndexers = new Set<string>()` pattern from `src/services/indexingService.ts:48`.

### 2.2 `src/services/remoteFetchWorker.ts` (new, ~80 lines)

Lightweight worker: on webhook delivery or manual refresh, enqueue a `(repoId)` fetch+reindex job. Dedupes concurrent jobs per repo using the same Set-based lock. Reuses `indexingService.indexRepo()` once the clone is on disk.

---

## Phase 3 — Registration API

Modify the existing repo-registration route handler (search `src/app/api/repos` for the POST handler that creates a `Repository` today).

New request shape:
```json
{
  "mode": "local" | "ssh" | "pat",
  "path"?: "/abs/path",
  "cloneUrl"?: "git@github.com:…",
  "deployKey"?: "-----BEGIN…",
  "cloneUrlHttps"?: "https://…",
  "pat"?: "github_pat_…"
}
```

Flow:
1. Validate `GREPLOOP_MASTER_KEY` is set (via `crypto.hasMasterKey()`); reject with a clear message if not.
2. Branch on mode:
   - `local` — existing path-based flow, unchanged.
   - `ssh` — `crypto.encryptSecret(deployKey)` → store cipher/iv/tag. `provider` inferred from `cloneUrl` host.
   - `pat` — `crypto.encryptSecret(pat)` → store cipher/iv/tag.
3. Kick off `remoteFetchWorker.enqueue(repoId)` (clone + index).
4. Return the repo record with a `webhookSetupToken` (single-use) the UI uses to set up the webhook next.

---

## Phase 4 — Webhook setup (hybrid PAT-driven auto-create)

### 4.1 `src/lib/webhookSetup.ts` (new, ~150 lines)

Two paths:

**Auto (PAT available):**
- `setupWebhookWithPat(repo): Promise<{ id: string; secret: string }>`
- GitHub: `POST /repos/{owner}/{repo}/hooks` with `push`+`pull_request` events, the server's public webhook URL, and a freshly generated HMAC secret. Save `webhookId` and `webhookSecret` to the repo.
- GitLab: equivalent `POST /projects/:id/hooks`.
- Wraps the call so the UI can ask "yes, set it up" once and have it done.

**Manual fallback (SSH deploy key, or auto fails):**
- `getManualWebhookInstructions(repo): { url, contentType, secret, events }`
- Returns the values the user pastes into the provider UI. The `webhookSecret` is generated server-side and persisted; the user must paste it into the provider's "secret" field.

The registration UI asks the user once: "Set up webhook automatically? (yes/no)". Yes → tries auto, falls back to manual instructions on any failure. No → straight to manual instructions.

The server's webhook URL must be configurable via `GREPLOOP_PUBLIC_URL` env (defaults to `http://localhost:3300` for dev). Without it, the auto-setup can't tell the provider where to deliver.

### 4.2 New route handler `src/app/api/repos/[id]/webhook/route.ts`

- `POST` → runs `setupWebhookWithPat(repo)` (or returns manual instructions if no PAT).
- `DELETE` → calls the provider's delete-hook endpoint using the stored PAT, then clears `webhookId`.

---

## Phase 5 — Webhook handler hardening

Existing handlers at `src/app/api/webhooks/github/route.ts` and `gitlab/route.ts` already parse events and call `gitFetch()` + `scanRepoPrs()`. They **do not** verify HMAC signatures — that's the gap.

### 5.1 Wire up signature verification

`src/lib/webhook.ts` already has `verifyGithubSignature()` (lines 5-15) implemented but unused. Call it at the top of the GitHub handler: look up `webhookSecret` by `cloneUrl` from the DB, verify `x-hub-signature-256`, return 401 on mismatch. Same shape for GitLab (`x-gitlab-token` against the stored secret).

### 5.2 Replace injection-prone `gitFetch()`

`src/lib/webhook.ts:42-49` uses `execSync` with string-interpolated paths — an injection vector if a repo path ever contains shell metacharacters. Replace the body with a call to `gitRemote.fetchRepo(repo)` from Phase 2.1 (which uses `execFileSync` with arg arrays).

### 5.3 Use the worker

Both handlers, after signature verification, enqueue `remoteFetchWorker.enqueue(repoId)` instead of doing the fetch inline. Webhook handlers must return 200 fast — the provider retries aggressively on slow responses.

---

## Phase 6 — UI

Split the existing AddRepoModal into two tabs (file-size rule — keep under 500 lines; new modal directory if needed):

- **Local path** — unchanged today.
- **Remote repo** — three fields: clone URL, mode toggle (SSH deploy key / PAT), secret textarea. Submit calls the registration API. After success, a second panel asks "Set up webhook automatically?" (only shown if mode === "pat") and on "no" displays the manual webhook instructions.

Install-path hint in `src/components/views/llm-config/McpKeysPanel.tsx` already references `skills/gloop` — unrelated to this phase but worth a grep to confirm it's still correct.

---

## GitHub App for local testing

For local webhook auto-create testing we need a real GitHub App (the auto-setup path uses a PAT, but a GitHub App is the cleaner long-term delivery mechanism and the user specifically asked for it).

Setup checklist (documented in `docs/dev-setup.md`, new file):
1. On the user's GitHub account/org: **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. App name: `GrepLoop (dev)`. Homepage URL: `http://localhost:3300`. Webhook URL: `https://<tunnel-url>/api/webhooks/github`. Webhook secret: any random string (matches what GrepLoop stores).
3. Permissions: **Repository → Contents: Read**, **Metadata: Read**, **Pull requests: Read**, **Repository administration: Read** (for hook creation).
4. Subscribe to events: **Push**, **Pull request**.
5. Generate a private key (.pem) — download it; this is the App's credential.
6. Install the App on the test repo.
7. For local receipt: run a Cloudflare Tunnel (`cloudflared tunnel --url http://localhost:3300`) — set `GREPLOOP_PUBLIC_URL` to the tunnel URL so the webhook setup endpoint advertises the right delivery address.

For the **PAT-driven auto-setup path** in Phase 4, the same tunnel is used; the only difference is the credential the server presents to GitHub (PAT vs. App installation token). Phase 4.1 is built against the PAT path first because it's simpler; App-installation-token support is a follow-up.

---

## PR sequence

Five small PRs, each independently mergeable:

1. **Phase 0** — crypto + startup audit + instrumentation. No behavior change yet; just the safety net.
2. **Phase 1** — schema migration + `db push`. Existing flows unchanged.
3. **Phase 2** — `gitRemote.ts` + `remoteFetchWorker.ts`. Called by nobody yet; safe to land.
4. **Phase 3+4** — registration API + webhook setup endpoint.
5. **Phase 5+6** — webhook handler hardening + UI tabs.

---

## Critical files

| Path | Role |
|---|---|
| `prisma/schema.prisma` | Make `path` optional; add encrypted-blob + webhook fields |
| `src/lib/crypto.ts` (new) | AES-256-GCM encrypt/decrypt under `GREPLOOP_MASTER_KEY` |
| `src/lib/startupAudit.ts` (new) | chmod 0600 enforcement on `.env*` + `.greploop/*` |
| `src/instrumentation.ts` (new) | Runs startup audit once per boot |
| `src/lib/gitRemote.ts` (new) | Safe `execFileSync`-based clone/fetch + SSH env builder |
| `src/services/remoteFetchWorker.ts` (new) | Deduped in-memory fetch+index worker |
| `src/lib/webhookSetup.ts` (new) | PAT auto-create + manual fallback |
| `src/app/api/repos/[id]/webhook/route.ts` (new) | Webhook setup/delete endpoint |
| `src/app/api/webhooks/github/route.ts` | Add HMAC verify; switch to worker |
| `src/app/api/webhooks/gitlab/route.ts` | Same hardening |
| `src/lib/webhook.ts` | Wire `verifyGithubSignature` in; replace injection-prone `gitFetch` |
| `src/lib/llmPresets.ts:162-177` | Reference for atomic tmp+rename+chmod write pattern |
| `src/lib/getRealLocalPrs.ts:6-8` | Reference for safe `execFileSync` pattern |
| `src/lib/mcpAuth.ts:6-15` | Reference for hashing/secret-handling pattern |
| `src/services/indexingService.ts:48` | Reference for `Set`-based in-memory lock |
| AddRepoModal (find under `src/components/`) | Add Remote-repo tab |

---

## Verification

End-to-end, with the dev server running (`npm run dev`):

1. **Startup audit** — `chmod 0644 .env.local`, restart server, confirm log line `startup audit: fixed .env.local → 0600` and that the file is now 0600.
2. **Crypto round-trip** — write a one-off script that calls `encryptSecret("hello")` then `decryptSecret(...)` and asserts equality. Run once.
3. **Local repo (regression)** — register a local-path repo as today, confirm `prlist` still returns it and `/gloop` still works.
4. **Remote repo (SSH mode)** — generate an SSH deploy key on GitHub, paste private key + clone URL into the new UI tab, confirm clone appears under `repos/<id>/` and indexing completes.
5. **Remote repo (PAT mode)** — generate a fine-grained PAT, paste into UI, confirm clone + index. Then click "Set up webhook automatically" and confirm `webhookId` populates in the DB.
6. **Webhook delivery** — open a Cloudflare tunnel, set `GREPLOOP_PUBLIC_URL`, push a commit to the registered repo, confirm the push event arrives, signature verifies, and a re-index kicks off (check `lastFetchAt` updates).
7. **HMAC rejection** — replay the webhook with a tampered signature, confirm 401.
8. **Manual fallback** — register an SSH-mode repo (no PAT), confirm UI shows manual webhook instructions with the right URL + secret.
9. **`/gloop` against remote repo** — list PRs on a remote repo, run `/gloop <n>`, confirm findings come back as before.
10. **chmod audit didn't break startup** — `.env.local` mode 0600, server boots, all good.
