# Tasks — Multi-Provider Fallback + Honest Failure

Mark each `- [ ]` as `- [x]` when complete. Per user convention: update this file as work ships, one commit per phase.

## Phase 1 — Schema: primary + fallback presets

- [x] Extend `PresetsFile` interface in `src/lib/llmPresets.ts` with `primaryChatPresetId`, `fallbackChatPresetId`, `primaryEmbeddingPresetId`, `fallbackEmbeddingPresetId`.
- [x] Backward-compat migration in `parseFile()`: if old `activeChatPresetId` exists and `primaryChatPresetId` doesn't, copy across. Same for embedding. Trigger save on first detection.
- [x] Update `emptyState()` to include the four new fields (null for fallbacks).
- [x] Add `getFallbackChatPreset()` and `getFallbackEmbeddingPreset()` getters.
- [x] Update `listPresets()` to return all four slot ids.
- [x] Update `validatePresetsInput()` to type-check the four new fields and ensure fallback ids (when non-empty) reference existing presets.
- [x] Updated `src/app/api/llm/presets/route.ts` PUT handler to write the new shape.
- [x] `npm run lint` clean.
- [ ] Manual: load UI, confirm existing single-provider config still loads (primary slot populated, fallback empty).

## Phase 2 — Chat + embedding client chains

- [x] Add `getChatChain(): Array<{client: OpenAI, model: string, name: string}>` in `src/lib/llmClient.ts`.
- [x] Mirror `getEmbeddingChain()`.
- [x] Both return primary first, fallback second (skip if fallback unset or equal to primary).
- [x] Keep existing `getChatClient`/`getChatModel`/`getEmbeddingClient`/`getEmbeddingModel` working as primary-only shortcuts.
- [x] Per-preset client cache via `__llmClientCache` Map on globalThis (supports multiple simultaneous providers).
- [x] `npm run lint` clean.

## Phase 3 — Review service: iterate chain, honest failure

- [x] Change `let rating = 5;` to `let rating: number | null = null;` in `reviewService.ts`.
- [x] Update `ScanResult.rating` type to `number | null`.
- [x] Delete `generateRealisticFindings()` (was lines 18-91).
- [x] Delete the three call sites in `reviewService.ts` (was 337, 446, 452).
- [x] Replace the `if (!client || !chatModel)` block + try/catch with a chain iteration loop.
- [x] Inside the loop: run the agentic loop parameterized by `client`/`model`. Break on `finalReview`. Catch per-provider errors and continue.
- [x] After the loop: if `finalReview`, use its findings/rating. Otherwise set actionable `systemWarn` and leave findings `[]`/rating `null`.
- [x] Refactor `src/app/api/reviews/route.ts` to drop procedural seeding on manual review log (second caller of deleted function).
- [x] `npm run lint` clean.
- [x] `npm test` — all 33 tests pass.
- [ ] Manual: trigger scan on solarplanner `feature/agent-blog-api`. Confirm either real findings OR empty + systemWarn, never templated findings.

## Phase 4 — Embedding service: chain + circuit breaker

- [x] Add module-level `let embeddingCircuitOpen = false;` in `src/services/embeddingService.ts`.
- [x] Refactor `generateEmbedding` to loop over `getEmbeddingChain()`, try each provider, return first success.
- [x] If all fail: trip `embeddingCircuitOpen`, log single `console.error` with friendly message, return `[]`.
- [x] Early-return `[]` at top of `generateEmbedding` if `embeddingCircuitOpen` is true.
- [x] Exposed `resetCircuitBreaker` + `isCircuitOpen` as test/admin hooks.
- [x] `npm run lint` clean.
- [x] `npm test` — all 33 tests pass.
- [ ] Manual: tail `/tmp/greploop-dev.log` after a scan. Confirm at most one embedding error per session.

## Phase 5 — Agentic loop logging

- [x] Log `[review] iteration ${loopCount}/8 provider=${name}` at top of each iteration.
- [x] Log `[review] tool ${fnName} → ${resultSummary}` after each tool call (where resultSummary is "N results" or "error: ...").
- [x] Log `[review] submitReview received: rating=${...} findings=${...}` when submitReview fires.
- [x] Log `[review] loop exited without submitReview (iterations used: ${loopCount}, last message had tool_calls: ${...})` when finalReview stays null.
- [x] Bonus: log when text-path JSON is parsed as finalReview.
- [x] `npm run lint` clean.
- [x] `npm test` — all 33 tests pass.

## Phase 6 — Legacy command handler: route prcheckstatus

- [x] Add `cmdName.endsWith("prcheckstatus") || cmdName.endsWith("status")` branch in `handleLegacyCommand` before Unknown fallthrough.
- [x] Reuse `resolvePr`, `isReviewActive`, persisted findings/rating lookups.
- [x] Return shape: `{ status, type: "status", productionScore, findingsCount, findings }`.
- [x] Re-fetches PR after `isReviewActive` check so async rating updates are reflected.
- [x] `npm run lint` clean.
- [x] `npm test` — all 33 tests pass.
- [ ] Manual: `curl -X POST localhost:3300/api/mcp/command -d '{"command":"prcheckstatus","repoId":"<id>","branch":"<branch>"}'` returns JSON, not "Unknown command".

## Phase 7 — UI: 4 pickers in LLM Settings

- [x] Update `src/components/views/llm-config/RolePanel.tsx` to render primary + fallback pickers per role.
- [x] Fallback picker includes a "(no fallback)" option.
- [x] Wire save handler to persist all four slot ids.
- [x] Updated `shared.ts` to use a `SlotState` record (4 slots) instead of separate chat/embedding ids.
- [x] Updated `LlmPresetsState` type in `src/lib/types.ts` to include all four slot fields.
- [x] Updated explanatory card to describe multi-provider fallback + honest failure mode.
- [x] All three files under 500 lines (index 379, RolePanel 195, shared 154).
- [x] `npm run lint` clean.
- [x] `npm test` — all 33 tests pass.
- [ ] Manual: load `/` in browser, open LLM Settings, confirm all four pickers render and persist across reload.

## Phase 8 — Ollama fix script + docs

- [ ] Create `scripts/fix-ollama.sh` (curl install ollama + pull mxbai-embed-large).
- [ ] `chmod +x scripts/fix-ollama.sh`.
- [ ] Add "Troubleshooting" section to `CLAUDE.md` covering circuit breaker, fix script, fallback configuration.
- [ ] Note multi-provider support in `README.md` LLM Settings description.

## Final verification

- [ ] `npm run lint` clean (tsc --noEmit).
- [ ] `npm test` — existing tests still pass.
- [ ] Commit each phase individually per the user's `git add .` convention.
