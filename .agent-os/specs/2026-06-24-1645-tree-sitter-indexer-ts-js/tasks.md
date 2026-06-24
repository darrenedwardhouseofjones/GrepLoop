# Tasks — Tree-sitter Indexer (TS/JS v1)

Mark each `- [ ]` as `- [x]` when complete. Per user convention: update this file as work ships, one commit per phase.

## Phase 1 — Spec documentation

- [x] Create `.agent-os/specs/2026-06-24-1645-tree-sitter-indexer-ts-js/` with plan.md, shape.md, standards.md, references.md, tasks.md.

## Phase 2 — Install deps + grammar packaging

- [ ] `npm install web-tree-sitter tree-sitter-typescript`.
- [ ] Add `"postinstall": "node scripts/copy-grammars.mjs"` to `package.json`.
- [ ] Create `scripts/copy-grammars.mjs` that copies all `.wasm` files from `node_modules/tree-sitter-typescript/` into `public/grammars/`.
- [ ] Add `public/grammars/` to `.gitignore`.
- [ ] Run `npm run postinstall` manually; verify `ls public/grammars/*.wasm` shows TS + TSX (and JS + JSX if shipped).
- [ ] `npm run lint` clean.

## Phase 3 — `treeSitter.ts` lazy singleton

- [ ] Create `src/lib/treeSitter.ts` exporting `getParser()`, `getLanguage(ext)`, `getLanguageByFilePath(filePath)`.
- [ ] Mirror `globalThis.__treeSitterCache` guard from `llmClient.ts`.
- [ ] Never call `Parser.init()` or `Language.load()` at module load.
- [ ] Confirm `npm run build` doesn't break (catches WASM-at-build-time issues).
- [ ] `npm run lint` clean.

## Phase 4 — Split `indexingService.ts` into `indexing/` directory

- [ ] Create `src/services/indexing/types.ts` (SymbolNode, EdgeNode, ParsedFile interfaces).
- [ ] Create `src/services/indexing/legacyRegexParser.ts` (temporary copy of `parseFileSymbols` + `findBlockEnd` for parity tests).
- [ ] Create `src/services/indexing/graphBuilder.ts` (edge resolution from raw calls — logic from `:539-567`).
- [ ] Create `src/services/indexing/incrementalUpdater.ts` (file diff logic from `:421-481`).
- [ ] Create `src/services/indexing/indexOrchestrator.ts` (`IndexingService` class: `indexFolder`, `runIndex`, `isIndexing`, re-entrancy lock).
- [ ] Create `src/services/indexing/index.ts` barrel re-exporting `IndexingService` (back-compat for callers).
- [ ] Update callers if any import path changes (`grep -rn "indexingService" src/`).
- [ ] Verify each file under 500 lines (`wc -l src/services/indexing/*.ts`).
- [ ] Delete old `src/services/indexingService.ts`.
- [ ] `npm run lint` clean.
- [ ] `npm test` — existing tests still pass.

## Phase 5 — Tree-sitter TS/JS parser

- [ ] Create `src/services/indexing/tsParser.ts` with `parseFileSymbols(repoId, filePath, content)` matching the existing return shape.
- [ ] Use tree-sitter query DSL for symbol extraction (functions, arrow consts, classes, methods).
- [ ] Use tree-sitter query DSL for call-site extraction (`call_expression`).
- [ ] Symbol ID = `hash(repoId + filePath + kind + name + lineStart)`.
- [ ] Edge kind normalized to `CALLS` everywhere.
- [ ] JSX/TSX dispatched to `tree-sitter-tsx.wasm` grammar.
- [ ] Audit `reviewService.ts` and all other edge-kind readers; normalize to `CALLS` in the same commit.
- [ ] Anonymous/default exports get synthetic names (`default`, `anonymous-${lineStart}`).
- [ ] `npm run lint` clean.

## Phase 6 — Parity tests

- [ ] Create `tests/indexing/` directory.
- [ ] Create fixtures: `tests/indexing/fixtures/{functions,classes,methods,jsx,imports,nested,calls}.{ts,tsx,js,jsx}`.
- [ ] Create `tests/indexing/parity.test.ts`:
  - [ ] Symbol count per fixture matches expected.
  - [ ] Each symbol's `(lineStart, lineEnd)` correct (manual verification).
  - [ ] Symbol IDs stable across two parses of identical input.
  - [ ] Tree-sitter parser agrees with legacy regex parser on named functions/classes (regression guard).
- [ ] Cover edge cases that broke the regex: template literals with `{`, JSX, comments containing `function`.
- [ ] `npm test` — all parity tests pass + existing tests still pass.

## Phase 7 — Wire new parser + delete regex code

- [ ] Replace `parseFileSymbols` call in `indexOrchestrator.ts` with `tsParser.ts` import.
- [ ] Add extension gate: `.ts/.tsx/.js/.jsx` → tree-sitter; others → `[indexing] skipping {file}: no grammar yet` + contribute zero symbols.
- [ ] Delete `src/services/indexing/legacyRegexParser.ts`.
- [ ] Delete `findBlockEnd` if still present anywhere.
- [ ] Delete the regex patterns (now dead code in legacy file).
- [ ] Update class header comment (no longer "custom pattern-matching lexer").
- [ ] `npm run lint` clean.
- [ ] `npm test` — all tests pass.
- [ ] `npm run build` — production build succeeds.

## Phase 8 — Docs + final verification

- [ ] Add `CLAUDE.md` conventions entry for `treeSitter.ts` singleton (mirror the `llmClient.ts` paragraph).
- [ ] Add `CLAUDE.md` Troubleshooting: "If indexing skips all files with 'no grammar yet' — `npm run postinstall` didn't copy `.wasm`. Check `public/grammars/`."
- [ ] Update `README.md` to mention TS/JS support (drop any stale "all languages" claim).
- [ ] Update `prd.md:337` gap audit — mark tree-sitter item resolved.
- [ ] Update `roadmap.md:84` Track 1A task #1 — mark `[x]`.
- [ ] Mark all items in this `tasks.md` complete.

## Final verification

- [ ] `npm run lint` clean (tsc --noEmit).
- [ ] `npm test` — all tests pass.
- [ ] `npm run build` — production build succeeds.
- [ ] Manual: start dev server, register GrepLoop's own repo, trigger indexing. Confirm `Symbol` rows have correct line ranges + `Edge` rows have `kind = "CALLS"`.
- [ ] Manual: trigger PR scan on a TS-only branch. Findings cite real line numbers.
- [ ] Commit each phase individually per the user's `git add .` convention.
