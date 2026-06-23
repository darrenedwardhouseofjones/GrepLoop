# Multi-Provider Fallback — Shaping Notes

## Scope

Eliminate silent failure modes in the GrepLoop review pipeline by (a) removing the procedural fallback that masks LLM failures with templated findings, (b) adding backup providers for both chat and embedding roles, (c) adding diagnostic logging to the agentic loop, and (d) fixing the legacy API command handler to accept `prcheckstatus`.

## Decisions

- **Honest failure over fake success.** When all LLM providers fail, persist zero findings + null rating + actionable `systemWarn`. Users see "LLM unavailable — check config" instead of hallucinated CORS findings.
- **Primary + fallback per role.** Two roles (chat, embedding) each get independent primary/fallback presets. Both can point at the same preset (no fallback) or different ones.
- **Circuit breaker for embeddings.** After all embedding providers fail once, subsequent calls return `[]` instantly for the rest of the session. Prevents log spam from the indexing service.
- **Backward-compatible schema migration.** `activeChatPresetId` auto-copies to `primaryChatPresetId` on first read. Existing single-provider setups keep working with no fallback configured.
- **Agentic loop logging** uses the same `console.log`/`console.warn` pattern as existing code — lands in `/tmp/greploop-dev.log`.

## Context

- **Visuals:** None
- **References:**
  - `reviewService.ts:18-91` (procedural fallback — to delete)
  - `reviewService.ts:330-455` (single-provider block — to refactor)
  - `src/services/embeddingService.ts:46-67` (single-provider embedding — to refactor)
  - `src/lib/llmClient.ts` (lazy singletons — to extend with chain getters)
  - `src/lib/llmPresets.ts` (preset storage — to extend with fallback fields)
  - `src/app/api/mcp/command/[[...args]]/route.ts:277-330` (legacy handler — to extend)
- **Product alignment:** Directly serves the PRD's reliability promise — GrepLoop must produce either real LLM output or clear failure, never templated hallucinations.

## Standards Applied

- `security/secrets-at-rest` (not yet defined) — preset file stays chmod 0600, no new secrets introduced.
- `api/response-format` (not yet defined) — `prlist` response gains optional `fallbackChatPresetId`/`fallbackEmbeddingPresetId` fields; purely additive.
- `api/error-handling` (not yet defined) — every external tool call (`gh`, LLM provider) wrapped in try/catch with empty-MAP/empty-array fallback.
