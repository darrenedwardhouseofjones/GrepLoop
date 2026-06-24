# Tree-sitter Indexer (TS/JS v1) — Shaping Notes

## Scope

Replace the regex-based symbol/call extraction in `src/services/indexingService.ts` with a real tree-sitter-based parser for TypeScript and JavaScript codebases. This is Phase 0 / Track 1A of the indexing pipeline — the foundation that evidence chains, counter-evidence retrieval, and the agentic review loop depend on.

Specifically in scope:
- Install `web-tree-sitter` + `tree-sitter-typescript` (bundles TS, TSX, JS, JSX grammars).
- Lazy-init tree-sitter singleton mirroring `llmClient.ts` pattern.
- Split the 736-line `indexingService.ts` into a focused `indexing/` directory.
- Replace `parseFileSymbols` with tree-sitter query DSL extraction.
- Atomic cutover: ship parity tests, then delete the regex code in the same PR.
- Normalize edge kind casing to `CALLS` everywhere (write + read).

Explicitly out of scope:
- Python / Go / Ruby / PHP / Rust grammars (each is its own follow-on spec).
- `IMPORTS`, `DEFINES`, `EXTENDS`, `OVERRIDES` edge kinds beyond the normalization fix.
- Review-time concerns (verifier, searchCodebase semantic fix, ensemble schema).

## Decisions

- **TS + JS together, not TS-only.** The `tree-sitter-typescript` package bundles grammars for TS, TSX, JS, and JSX — they ship as one unit. Most TS repos also contain `.js`/`.jsx` files. Splitting them would fight the grammar packaging for no benefit.
- **Atomic swap, not feature-flagged side-by-side.** A side-by-side `USE_TREESITTER` flag adds moving parts and code we'd later delete. The parity tests are the safety net; once they pass, the regex code is dead weight.
- **Split the file while we're already rewriting it.** `indexingService.ts` at 736 lines violates the CLAUDE.md 500-line rule. Rewriting the core anyway means we should structure the new code properly from the start rather than carry the debt forward.
- **Edge kind normalized to `CALLS` (uppercase).** The current writer uses `"call"` (`indexingService.ts:563`); readers via `getCallers` expect `"CALLS"`. Audit all readers before changing the writer to avoid breaking caller retrieval during the cutover.
- **Symbol ID = hash(repoId + filePath + kind + name + lineStart).** Deterministic across re-parses of identical input. Fixes the PRD §12.3 incremental-diff reliability bug.
- **Non-TS/JS files are logged-and-skipped, not regex-fallback'd.** A mixed-language repo gets an honest partial index with a warning, not a regex fallback that produces wrong ranges. Follow-on language specs fill the gaps properly.
- **npm + postinstall copy for grammar packaging.** Mirrors every other dep. `.wasm` files live in `node_modules/tree-sitter-typescript/` and get copied to `public/grammars/` so the runtime can load them. `public/grammars/` is gitignored — regeneratable from `node_modules`.

## Context

- **Visuals:** None (backend indexing change, no UI)
- **References:**
  - `src/services/indexingService.ts` (entire file — being replaced and split)
  - `src/lib/llmClient.ts` (lazy-singleton + globalThis guard pattern to mirror)
  - `src/lib/prisma.ts` (globalThis guard pattern)
  - `src/services/embeddingService.ts` (circuit-breaker pattern — may apply to tree-sitter init failures)
  - `reviewService.ts` (`getCallers` consumer — audit before changing edge writer)
  - `package.json` (postinstall hook pattern; vitest already in devDeps)
- **Product alignment:** Directly serves PRD §11.1 / §11.2 / §12 / §13. The "Greptile-tier review quality" pitch collapses without correct line ranges and a clean call graph. This spec is the prerequisite for every evidence-chain feature in the PRD.

## Standards Applied

`agent-os/standards/index.yml` is empty today (just a header comment). The implicit standards this work touches:

- **code/file-size (CLAUDE.md global rule)** — every file under 500 lines. The current `indexingService.ts` at 736 lines violates this; the split into `indexing/` restores compliance.
- **code/lazy-singleton (CLAUDE.md project convention)** — tree-sitter parser init must use a globalThis guard, never module-load instantiation. Same rule as `prisma.ts` and `llmClient.ts` ("Never instantiate `OpenAI` at module load (breaks `next build`)").
- **code/regex-no-fallback (PRD §11.1 non-negotiable)** — *"v1 indexing must use real tree-sitter parsers, not regex."* Regex extraction was scaffolding only.
- **data/edge-casing** — edge kind casing must agree between writer and readers. Current bug: writer says `"call"`, reader expects `"CALLS"`. This spec normalizes to `CALLS`.
- **data/symbol-id-stability (PRD §12.3)** — symbol IDs must be deterministic across re-parses for incremental indexing to diff correctly. New scheme: `hash(repoId + filePath + kind + name + lineStart)`.
