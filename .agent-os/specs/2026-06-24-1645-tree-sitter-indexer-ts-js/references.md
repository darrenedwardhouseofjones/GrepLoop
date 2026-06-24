# References — Tree-sitter Indexer (TS/JS v1)

## Code that will change

### `src/services/indexingService.ts` (736 lines — being split + rewritten)

- **Relevance:** The entire indexer. Currently uses regex pattern matching for symbol discovery and call-graph construction. PRD §11.1 marks this as non-negotiable to replace.
- **What to split:**
  - Lines 1-50: interfaces + class declaration → `src/services/indexing/types.ts`
  - Lines 53-74: `findBlockEnd` brace counter → **delete** (tree-sitter gives block boundaries for free)
  - Lines 84-377: `parseFileSymbols` regex extractor → **replace** with `src/services/indexing/tsParser.ts` (temporary copy lives at `legacyRegexParser.ts` for parity tests, then deleted)
  - Lines 382-397: `indexFolder` re-entrancy lock → `indexOrchestrator.ts`
  - Lines 399-567: `runIndex` orchestration → split:
    - File-diff logic (`:421-481`) → `incrementalUpdater.ts`
    - Edge resolution (`:539-567`) → `graphBuilder.ts`
    - Orchestration skeleton → `indexOrchestrator.ts`
  - Lines 569-736: walk/ignore helpers + `enrichSymbols` → `indexOrchestrator.ts` (or split further if needed)
- **What to borrow:** The re-entrancy lock pattern (`activeIndexers` Set at `:50`) is good — keep it as-is in the orchestrator. The `parseFileSymbols` return shape `{ symbols, rawCalls }` is the contract the new `tsParser.ts` must match.

### `package.json`

- **Relevance:** Needs new deps + a postinstall hook.
- **What to change:** Add `web-tree-sitter` and `tree-sitter-typescript` to `dependencies`. Add `"postinstall": "node scripts/copy-grammars.mjs"` to `scripts`.

### `src/app/api/repos/[id]/index/route.ts` (or wherever indexing is triggered — verify path)

- **Relevance:** Caller of `IndexingService.indexFolder`. Must keep working after the split.
- **What to check:** Import path. If we add `src/services/indexing/index.ts` as a barrel that re-exports `IndexingService`, callers don't need to change. Otherwise update imports.

### `reviewService.ts` (`getCallers` consumer)

- **Relevance:** Reads `Edge` rows filtered by `kind`. Current writer uses `"call"`; readers may expect `"CALLS"`.
- **What to do FIRST:** `grep -n "kind.*call\|CALLS" reviewService.ts` and any other readers. Confirm the casing readers expect, then normalize both writer and readers in the same commit.

## Code to mirror (not change)

### `src/lib/llmClient.ts`

- **Relevance:** Lazy singleton pattern for the new `treeSitter.ts`.
- **What to borrow:**
  - `globalThis` guard via a `globalForLlm` typed interface.
  - `__llmClientCache` Map keyed by preset id — mirror for `__treeSitterLanguageCache` keyed by extension.
  - Lazy async getters (`getChatClient`, `getChatModel`) — same shape for `getParser`, `getLanguage`.
  - Module-load hazard warning in CLAUDE.md applies identically.

### `src/lib/prisma.ts`

- **Relevance:** Simpler globalThis singleton pattern.
- **What to borrow:** The `globalForPrisma` pattern with `if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;` — same pattern for caching the Parser across dev-mode hot reloads.

### `src/services/embeddingService.ts` (135 lines)

- **Relevance:** Circuit-breaker pattern for graceful degradation when a dependency fails.
- **What to consider:** If tree-sitter init fails (missing `.wasm`, corrupt file), should we trip a circuit breaker like `embeddingCircuitOpen`? Probably yes for v1 — log once, return empty symbols, don't crash the index run. Borrow the pattern if init failures turn out to be noisy.

## Test code to mirror

### Existing test pattern (verify before writing new tests)

- **Relevance:** Vitest is already configured (`package.json:45`). Mirror the existing test layout.
- **What to check:** Look at `tests/` to see the existing test style. Use the same import shape, `describe`/`it`/`expect` conventions.

## Prior spec format template

### `.agent-os/specs/2026-06-23-1919-multi-provider-fallback/`

- **Relevance:** Most recent completed spec. Same 5-file format (plan, shape, standards, references, tasks).
- **What to borrow:**
  - `plan.md` structure: Context → numbered Tasks → Verification → Out of scope.
  - `tasks.md` format: phase-grouped `- [ ]` checkboxes with file/line specificity, marked `- [x]` as work ships.
  - `shape.md`: scope / decisions / context / standards applied.
  - `references.md`: code-that-will-change vs code-to-mirror sections.
  - `standards.md`: even when `index.yml` is empty, list the implicit standards touched.

## PRD and roadmap anchors

- `prd.md:15` — the headline pitch that depends on this work.
- `prd.md:188-214` — §11 indexing pipeline spec.
- `prd.md:199` — non-negotiable: v1 must use real tree-sitter.
- `prd.md:337` — gap audit: IndexingService still uses pattern matching.
- `prd.md:471` — open question on grammar packaging (resolved: npm + postinstall).
- `roadmap.md:80-94` — Track 1A task list.
- `roadmap.md:84` — Track 1A task #1: replace regex with tree-sitter.

## External references (tree-sitter docs)

- `tree-sitter.github.io/tree-sitter/` — official docs.
- `github.com/tree-sitter/tree-sitter` — main repo.
- `github.com/tree-sitter/tree-sitter-typescript` — TS/JS/TSX/JSX grammar package.
- `npmjs.com/package/web-tree-sitter` — WASM build for Node/browser use.
