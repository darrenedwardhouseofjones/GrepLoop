# References — Multi-Provider Fallback

## Code that will change

### `src/lib/llmPresets.ts`

- **Relevance:** Source of truth for `.greploop/llm-presets.json`. Currently exposes `activeChatPresetId`/`activeEmbeddingPresetId` as single-valued strings.
- **What to borrow:** Extend `PresetsFile` interface with `primaryChatPresetId`/`fallbackChatPresetId`/`primaryEmbeddingPresetId`/`fallbackEmbeddingPresetId`. Add backward-compat read in `parseFile()` — if old fields exist and new don't, copy across. Add `getFallbackChatPreset()` and `getFallbackEmbeddingPreset()` mirroring existing `getActiveChatPreset()`. Update `listPresets` and `validatePresetsInput`.

### `src/lib/llmClient.ts`

- **Relevance:** Lazy singleton OpenAI clients. Currently exposes `getChatClient()`/`getChatModel()`/`getEmbeddingClient()`/`getEmbeddingModel()` returning the primary preset's client.
- **What to borrow:** Add `getChatChain()` returning `Array<{client: OpenAI, model: string, name: string}>` — primary first, fallback second if distinct. Mirror for `getEmbeddingChain()`. The cache pattern (`globalForLlm.__llmChatClient`) extends to a small Map keyed by presetId.

### `reviewService.ts:18-91` (delete), `:330-455` (refactor)

- **Relevance:** The procedural fallback and the single-provider agentic loop. Both need to change.
- **What to borrow:** Replace the `if (!client || !chatModel)` block + the `try { ... } catch` around the agentic loop with a single `for (const { client, model, name } of chain)` loop. Inside, run the existing agentic loop parameterized by `client`/`model`. On exception, log + continue. After chain exhausts without `finalReview`, set actionable `systemWarn` and leave findings `[]`/rating `null`. Delete `generateRealisticFindings` entirely.

### `src/services/embeddingService.ts:46-67`

- **Relevance:** `generateEmbedding`. Currently single-provider with `console.error` spam on every failure.
- **What to borrow:** Loop over `getEmbeddingChain()`, try each provider, break on first success. If all fail, set module-level `embeddingCircuitOpen = true` and log once.

### `src/app/api/mcp/command/[[...args]]/route.ts:285-332`

- **Relevance:** `handleLegacyCommand` dispatches prcheck/prcomments/prlist but not prcheckstatus.
- **What to borrow:** Add `cmdName.endsWith("prcheckstatus") || cmdName.endsWith("status")` branch before the Unknown fallthrough at line 332. Reuse `resolvePr`, `isReviewActive`, and the persisted findings lookup pattern from the `prcomments` branch above.

### `src/components/views/llm-config/RolePanel.tsx`, `ModelPicker.tsx`

- **Relevance:** Current UI has one picker per role (chat, embedding). Needs to grow to two per role.
- **What to borrow:** Either extend RolePanel to render primary + fallback pickers, or add a new RolePanel instance per slot. Pattern: pass `slot="primary"|"fallback"` prop, render "None" option for fallback.

## Adjacent code worth knowing

### `src/hooks/useDashboardData.ts:288`

- **Relevance:** Maps `result.systemWarn` to the `notice` field rendered as a banner. Honest-failure `systemWarn` strings will surface here automatically — no change needed.

### `src/components/views/PrsView.tsx:262-265`

- **Relevance:** Renders the notice banner. No change needed — the new systemWarn strings just flow through.

### `prisma/schema.prisma`

- **Relevance:** Confirms `rating Int?` is nullable. Phase 3's null rating on failure is already schema-compatible. No migration needed.
