# Standards — Multi-Provider Fallback

`agent-os/standards/index.yml` is empty, so no standards formally apply. Listed below are the standards this work touches once the index is populated.

## Standards this work would touch

### `security/secrets-at-rest` (not yet defined)

- `.greploop/llm-presets.json` continues to be written with mode 0o600 and re-chmod'd after every save (already implemented in `savePresets`).
- No new secrets stored. Fallback presets reuse the same Preset shape — their `apiKey` is protected identically to primary apiKeys.
- The circuit breaker state is in-memory only; no secrets cross the log boundary.

### `api/response-format` (not yet defined)

- `listPresets` response gains `fallbackChatPresetId` and `fallbackEmbeddingPresetId` string fields (empty string when unassigned, matching the existing `activeChatPresetId` convention).
- Existing fields unchanged. Additive — old clients keep working.

### `api/error-handling` (not yet defined)

- Every chat provider call wrapped in try/catch; failures log `[review] chat provider ${name} failed: ${msg}` and continue to next provider.
- Every embedding provider call wrapped in try/catch; failures log `[embedding] provider ${name} failed: ${msg}` and continue.
- When all providers in a chain fail: chat path sets actionable `systemWarn` + returns empty findings + null rating. Embedding path trips circuit breaker and returns `[]`.

### `database/migrations` (not yet defined)

- No schema changes. The presets file is JSON on disk; extending it with new optional keys is non-breaking. The `readPresets()` migration copies old `activeChatPresetId` to new `primaryChatPresetId` on first read and writes back atomically.

## Notes for future standards authors

- The "fail-open + log once" pattern (try every provider, log a single error when all fail, suppress subsequent noise via circuit breaker) is worth standardizing across the codebase.
- The "honest failure" rule (never persist templated data that looks like real LLM output) should be formalized — the procedural fallback was a three-month footgun.
