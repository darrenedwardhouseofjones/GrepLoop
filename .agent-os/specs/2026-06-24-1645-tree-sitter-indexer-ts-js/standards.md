# Standards — Tree-sitter Indexer (TS/JS v1)

`agent-os/standards/index.yml` is empty today (header only). Listed below are the implicit standards this work touches, derived from CLAUDE.md (global + project) and the PRD's non-negotiables. Future authors formalizing these into `agent-os/standards/*.md` should start here.

---

## `code/file-size` (from CLAUDE.md global)

> Keep all files under 500 lines of code. Create a directory and put refactored files into a directory that has meaning for the usecase.

**Applies to:** the entire `src/services/indexingService.ts` rewrite. The file is currently 736 lines — split into `src/services/indexing/{index,types,tsParser,graphBuilder,incrementalUpdater,indexOrchestrator}.ts`. Each must stay under 500.

**How to apply:** any new module created during this spec must be checked with `wc -l` before commit. If a module threatens to exceed 500, split further by concern (e.g., `tsParser/{functions,classes,calls}.ts`).

---

## `code/lazy-singleton` (from CLAUDE.md project conventions)

> The OpenAI clients are lazy dual singletons at `src/lib/llmClient.ts` with `globalThis` guards. Never instantiate `OpenAI` at module load (breaks `next build` on empty env).

**Applies to:** the new `src/lib/treeSitter.ts`. Same hazard — `Parser.init()` and `Language.load()` are async and pull `.wasm` files; running them at module load breaks `next build` and risks invoking the filesystem during type-check.

**How to apply:**
- Export `getParser()` / `getLanguage()` async functions, not a module-level instance.
- Cache on `globalThis.__treeSitterCache` so dev-mode hot reloads don't leak Parser instances.
- Mirror the exact shape of `__llmClientCache` in `llmClient.ts`.

---

## `code/regex-no-fallback` (PRD §11.1 non-negotiable)

> v1 indexing must use real tree-sitter parsers, not regex or hand-rolled pattern matching. Regex extraction is acceptable only as throwaway scaffolding while wiring the rest of the pipeline.

**Applies to:** the entire `parseFileSymbols` function (`indexingService.ts:84-377`) and its brace-counting helper `findBlockEnd` (`:53-74`).

**How to apply:** delete both in Task 7. The temporary `legacyRegexParser.ts` exists during the spec only to power parity tests in Task 6 — it is deleted in Task 7 before the spec closes. Never ship regex-based symbol extraction.

---

## `data/edge-casing` (bug fix from PRD §14.7 gap audit)

> Edge kind casing must be normalized between index writes and review reads (`call` vs `CALLS`) so caller/callee retrieval actually works.

**Applies to:** the writer at `indexingService.ts:563` (`kind: "call"`) and any reader that filters by edge kind.

**How to apply:**
- Audit all readers before changing the writer: `grep -rn "kind.*call\|kind.*CALLS\|where.*kind" src/`.
- Normalize to `CALLS` (uppercase) everywhere — matches PRD §11.2 convention (`CALLS`, `IMPORTS`, `DEFINES`, `EXTENDS`, `OVERRIDES`).
- Update both writer and readers in the same commit. A partial change breaks caller retrieval silently.

---

## `data/symbol-id-stability` (PRD §12.3)

> When a file is unchanged (same hash), its symbols must keep the same IDs across re-indexes so incremental updates can skip them.

**Applies to:** the symbol ID generation scheme in the orchestrator (`indexingService.ts:502`).

**Current scheme:** `sym-${repoId}-${md5(filePath + name).slice(0,10)}` — collides on duplicate names within a file (two `handleClick` functions in different scopes get the same ID).

**New scheme:** `sym-${repoId}-${md5(filePath + kind + name + lineStart).slice(0,12)}` — lineStart disambiguates within-file duplicates and is stable across re-parses of identical input (tree-sitter gives deterministic positions).

**How to apply:** update the ID generation in `indexOrchestrator.ts`. Existing symbol rows in the DB will get new IDs on next index — that's expected and fine since the orchestrator already deletes + re-inserts on file change.

---

## `build/postinstall-safe` (new implicit standard)

> `postinstall` scripts must be idempotent, must not fail on missing optional files, and must not require network access.

**Applies to:** the new `scripts/copy-grammars.mjs`.

**How to apply:**
- Use `fs.cp` with `recursive: true` and `force: false` to avoid re-copying unchanged files.
- If `node_modules/tree-sitter-typescript/*.wasm` doesn't exist (package not yet installed), exit 0 silently — npm may run postinstall before peer deps are fully resolved.
- Never `npm install` or hit the network from postinstall.

---

## Notes for future standards authors

- The **"fail-and-log-skip"** pattern for unsupported languages (log a warning, contribute zero symbols, don't crash the whole index run) is worth standardizing across the indexing pipeline. Same shape as the embedding circuit breaker.
- The **"atomic swap with parity tests"** cutover pattern deserves a process standard: when replacing a core service, write fixtures that the old code passes, then port until the new code passes them too, then delete the old code in the same PR. Avoids the half-migrated state that haunted the procedural-fallback cleanup.
