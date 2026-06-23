# Plan — Multi-Provider Fallback + Honest Failure Mode

## Context

Three reliability problems surfaced while debugging solarplanner's `feature/agent-blog-api` review:

1. **Procedural fallback masks LLM failures.** `reviewService.ts:18-91` defines `generateRealisticFindings()` — templated findings with real-looking specifics (`src/middleware/cors.ts:4`, "CORS wildcard *"). When the LLM path fails, these get persisted alongside a procedural rating, making the output look like a real review. Three months of solarplanner "reviews" were this template — the agentic loop was silently failing.

2. **Single-provider LLM config.** Today's `llm-presets.json` has one `activeChatPresetId` + one `activeEmbeddingPresetId`. If OpenRouter has a hiccup or the local Ollama binary is missing (current state — see dev log), the whole review pipeline fails. No fallback.

3. **Silent agentic loop.** `reviewService.ts:354-440` iterates up to 8 times calling tools, but logs nothing per iteration. When the LLM never produces a `submitReview` call, we have no diagnostic trace — just the silent `finalReview === null` branch.

User decisions:
- **Chat LLM**: add a backup OpenAI-compatible provider. If primary fails, try fallback. If both fail, persist zero findings + null rating + clear actionable error message.
- **Embeddings**: add a cloud embedding provider alongside the local Ollama. Same fallback pattern. If both fail, log once with a friendly message.

Bonus issue found during research:
4. **`prcheckstatus` not in legacy command handler.** `src/app/api/mcp/command/[[...args]]/route.ts:277-330` dispatches `prcheck`, `prcomments`, `prlist` via the `{command:...}` shape but not `prcheckstatus`. Returns "Unknown command".

Intended outcome: every PR review either produces real LLM output OR a clear "LLM unavailable — check config" message. Never silent templated findings again.

---

## Phase 1 — Schema: primary + fallback presets

**Files:** `src/lib/llmPresets.ts`, `.greploop/llm-presets.json` (auto-migrate).

- Rename `activeChatPresetId` → `primaryChatPresetId`, `activeEmbeddingPresetId` → `primaryEmbeddingPresetId` (with backward-compat read in `readPresets()`).
- Add `fallbackChatPresetId: string | null`, `fallbackEmbeddingPresetId: string | null`.
- Update `listPresets`, `validatePresetsInput` to expose new fields.
- Add `getFallbackChatPreset()` and `getFallbackEmbeddingPreset()` getters.

## Phase 2 — Chat + embedding client chains

**File:** `src/lib/llmClient.ts`.

- Add `getChatChain(): Array<{client, model, name}>` — primary first, fallback second (if distinct).
- Add `getEmbeddingChain()` mirror.
- Keep `getChatClient()`/`getChatModel()` as primary-only shortcuts.

## Phase 3 — Review service: iterate chain, honest failure

**File:** `reviewService.ts:330-455`.

- Loop over `getChatChain()`; on exception, log and try next.
- Delete `generateRealisticFindings()` and its three call sites (lines 337, 446, 452).
- Change `let rating = 5;` to `let rating: number | null = null;`.
- On `finalReview === null`: set clear `systemWarn`, leave findings `[]`, rating `null`.
- Persistence loop handles empty list correctly (no-op).

## Phase 4 — Embedding service: iterate chain + circuit breaker

**File:** `src/services/embeddingService.ts:46-67`.

- Loop over `getEmbeddingChain()`; on exception, try next provider.
- Module-level `embeddingCircuitOpen` flag — trips after all providers fail, makes further calls return `[]` instantly until process restart.

## Phase 5 — Agentic loop logging

**File:** `reviewService.ts:354-440`.

- Log iteration count + provider name at top of each loop.
- Log each tool call result summary.
- Log `submitReview` receipt (rating + findings count).
- Log on loop exit without `submitReview`.

## Phase 6 — Legacy command handler: route prcheckstatus

**File:** `src/app/api/mcp/command/[[...args]]/route.ts:319-330`.

- Add `prcheckstatus` / `status` branch before the Unknown fallthrough.
- Returns status JSON equivalent to the `{tool:prcheckstatus}` shape.

## Phase 7 — UI: 4 pickers in LLM Settings

**File:** `src/components/views/llm-config/`.

- Expose 4 pickers: primary chat, fallback chat, primary embedding, fallback embedding.
- "Test Fallback" button when fallback configured.

## Phase 8 — Ollama fix script + docs

**New file:** `scripts/fix-ollama.sh`.

**Docs:** `CLAUDE.md` Troubleshooting section; `README.md` note.

---

## Verification

1. **Phase 1-3**: with OpenRouter key valid + fallback unset, run `/gloop 1` on solarplanner. Confirm real LLM findings land (or empty + systemWarn if the model fails). Then break the primary key and re-run — confirm fallback kicks in if set, or clear error message if not.
2. **Phase 4**: tail `/tmp/greploop-dev.log` after a scan. Confirm no repeated "Failed to generate embedding" spam — at most one error per session when both providers are unreachable.
3. **Phase 5**: trigger a scan on a PR with a model that doesn't support tool calling. Confirm iteration logs show tool_calls: false and the loop exits with a clear "no submitReview" log line.
4. **Phase 6**: `curl -X POST localhost:3300/api/mcp/command -d '{"command":"prcheckstatus","repoId":"...","branch":"..."}'` — confirm valid JSON response, not "Unknown command".
5. **Phase 7**: load `/` in browser, open LLM Settings, confirm all four pickers render and save correctly.
6. **Phase 8**: `bash scripts/fix-ollama.sh` then restart dev server. Confirm embedding errors stop.

After all phases: `npm run lint && npm test` clean. Existing tests should still pass (no test references procedural findings).

---

## Out of scope

- **OpenRouter embedding models**: don't exist in standard OpenAI-compatible shape. Cloud embedding fallback assumes user adds a separate preset.
- **Persisted rating for previously-procedural PRs**: existing PR rows still hold old procedural ratings. Re-scan overwrites.
- **Indexing service rewrite**: indexer keeps trying to embed after breaker trips. Breaker makes it return `[]` instantly; no real work done. Good enough for dev.
