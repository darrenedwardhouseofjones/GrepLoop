# Deploy-Key Remote Repos — Shaping Notes

## Scope

Register remote GitHub/GitLab repos with GrepLoop using either SSH deploy keys or fine-grained PATs. GrepLoop clones the repo, indexes it the same way it indexes a local path, and stays in sync via webhook so pushes automatically trigger re-indexing. Local-repo registration continues to work unchanged.

This unblocks the "GrepLoop server on office box, repos on GitHub" deployment mode that the cost+control+multi-LLM-ensemble product wedge depends on.

## Decisions

- **AES-256-GCM encryption at rest under `GREPLOOP_MASTER_KEY`.** User said "encrypted at rest is good by me" and "i want most secure". Master key lives in env, never in the DB. Cipher/IV/tag columns hold the encrypted blobs.
- **chmod 0600 enforcement at startup.** User said "greploop shold always check the config.json/.env for chmod 600 so no one can view it other than the owner rigth". `instrumentation.ts` runs once per boot, fixes mode on `.env*` and `.greploop/*`, logs warnings. Never silently continues with world-readable secrets.
- **Hybrid webhook setup: PAT-driven auto-create with manual fallback.** User said "i would like it auto setup with the users permissions, so ask the user, woudl you like to setup web hook now(yes|no) if yes then create, if not then supply the web hook information for htem". One UI prompt — yes tries PAT auto-create and falls back to manual instructions; no goes straight to manual.
- **GitHub App for local testing.** User said "we need the gtuhub app installed locally for testing". Documented setup checklist in `docs/dev-setup.md`. Phase 4.1 ships the simpler PAT path first; App-installation-token support is a follow-up.
- **`/gloop` command family stays.** No rename to BugHunter; no `/greploop` or `/check-pr` (Greptile namespaces to avoid). This is decided and shipped — this spec doesn't touch it.
- **Path field becomes optional.** `Repository.path String? @unique` keeps local repos working (they still set `path`) while letting remote repos use `localPath` (server-managed clone directory) instead.
- **Edit-repo is a Phase 7 addition, not Phase 3.** User pointed out after the original spec landed that the edit-repo flow ("how do I edit a project to put the repo and deploy key") was missing. Phase 7 mirrors the registration flow (Phase 3+4) but operates on `PUT /api/repos/[id]` with secret-preservation semantics ("leave blank to keep current") so users can rotate keys or switch SSH↔PAT without re-cloning.
- **Deployment topology: support both, detect at runtime.** User said "it's on a VPS, they don't need Cloudflare which I want to avoid, but if we need it we need it." Phase 8 introduces `getPublicUrl()` returning `{ url, isLocal }` — WebhookPrompt shows Cloudflare Tunnel setup steps only when `isLocal` is true (localhost / 127.0.0.1 / 0.0.0.0). VPS users with a public URL skip the tunnel steps entirely. The user explicitly chose "Support both (detect at runtime)" over tunnel-always or tunnel-never.

## Context

- **Visuals:** None.
- **References:** See `references.md` — eight existing patterns borrowed (safe execFileSync, atomic chmod write, globalThis singleton, Set-based lock, existing-but-unused HMAC verifier, injection-prone gitFetch to replace, hashing pattern, schema model).
- **Product alignment:** prd.md §8.3. The pivot to cost+control+multi-LLM ensemble is in `2b05e38`.
- **Hardware:** No local GPU (no DGX Spark). Cloud LLM for the review role, local Ollama fine for embeddings. See memory `hardware-llm-constraints`. Doesn't block this spec — indexing is LLM-agnostic — but affects how we test the end-to-end review flow.
- **Pre-flight blocker:** Commit `4fc0596` accidentally swept in `opencode.json` containing a real MCP API key (`gl_mcp_835aa1df03b5c663832e0fe76496e67926adef72a126dff19f311e9881710a2a`). Local only, no push. Before any of this work merges: revoke the key in the UI, soft-reset the commit, gitignore `opencode.json`, recommit.

## Standards applied

None. `agent-os/standards/index.yml` exists but is empty. See `standards.md` for the list of standards that *should* be authored before this work is done.

## Follow-ups (not in this spec)

- Migrate existing `agent-os/standards/` (non-dotted) to `.agent-os/standards/` for folder-convention consistency.
- Populate `agent-os/standards/index.yml` with the standards listed in `standards.md`.
- Consider creating `.agent-os/product/` (mission.md, roadmap.md, tech-stack.md) to anchor future specs.
- GitHub App installation-token support (after Phase 4.1 PAT path ships).
