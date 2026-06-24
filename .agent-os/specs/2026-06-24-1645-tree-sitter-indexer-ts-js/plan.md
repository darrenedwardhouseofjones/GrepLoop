# Plan — Tree-sitter Indexer for TypeScript/JavaScript (v1)

## Context

**Why this work, why now.** BugHunter's entire pitch is "Greptile-tier review quality" (`prd.md:15`). That quality depends on a codebase index built from **real AST parses**, not regex. Today the indexer fakes it:

- `src/services/indexingService.ts:36-40` self-documents as *"custom pattern-matching lexer rules… without requiring platform-native binary bindings"* — that was scaffolding.
- `:116-329` discovers symbols by walking lines and running regexes (`/^class\s+/, /function\s+/, brace-counting `findBlockEnd` at `:53-74`).
- `:329, 343, 356, 369` build the call graph with `line.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)` — matches keywords, control flow, declarations. Produces junk edges.

Three concrete failures that block the PRD's quality bar:

1. **Wrong line ranges.** Brace-counting miscounts on template literals, JSX, comments with `{`. Evidence chains cite the wrong lines → PRD §15 requirement ("every finding must have evidence") is unsoundable.
2. **Junk call edges.** `matchAll(name\()` catches `if (`, `for (`, `switch (` despite the keyword blocklists at `:332, 372`. `getCallers()` returns noise → PRD §13.2 caller retrieval is broken.
3. **Non-repeatable symbol identity.** Re-parsing a slightly-changed file produces different symbol IDs → PRD §12.3 incremental indexing can't diff reliably.

The PRD is explicit and non-negotiable (`prd.md:199`): *"v1 indexing must use real tree-sitter parsers, not regex."* `prd.md:337` flags it as the top gap. `roadmap.md:84` makes it Track 1A task #1.

**Outcome:** after this spec ships, pointing BugHunter at any TS/JS/TSX/JSX codebase (including BugHunter itself) produces a clean symbol table and call graph with correct line ranges — the foundation that evidence chains, counter-evidence retrieval, and the agentic review loop depend on.

**Decisions locked with user (2026-06-24):**
- Scope: **TS + JS** via the `tree-sitter-typescript` package (bundles both grammars).
- Packaging: **npm install + postinstall copy** of `.wasm` files into `public/grammars/`.
- Cutover: **atomic swap** with parity tests; delete regex code in the same PR.
- Refactor: **split `indexingService.ts` (736 lines) into `src/services/indexing/` directory** (CLAUDE.md 500-line rule).

---

## Task 1: Save Spec Documentation

Create `.agent-os/specs/2026-06-24-1645-tree-sitter-indexer-ts-js/` with five files matching the existing convention (see `.agent-os/specs/2026-06-23-1919-multi-provider-fallback/`):

- **plan.md** — this plan
- **shape.md** — scope, decisions, context
- **standards.md** — implicit standards touched
- **references.md** — pointers to code being changed
- **tasks.md** — phase-grouped checkboxes

---

## Task 2: Install Dependencies + Grammar Packaging

**Files:** `package.json`, new `scripts/copy-grammars.mjs`, `public/grammars/.gitignore`.

- `npm install web-tree-sitter tree-sitter-typescript`
- Add `"postinstall": "node scripts/copy-grammars.mjs"` to `package.json`
- `scripts/copy-grammars.mjs` copies `.wasm` files from `node_modules/tree-sitter-typescript/` into `public/grammars/`.
- `.gitignore` entry for `public/grammars/` (regenerated from `node_modules`, not committed).

---

## Task 3: Create `treeSitter.ts` Lazy Singleton

**New file:** `src/lib/treeSitter.ts`.

Mirror the lazy-singleton pattern from `src/lib/llmClient.ts` and `src/lib/prisma.ts` (globalThis guards, no module-load instantiation).

Exports:
```ts
export async function getParser(): Promise<Parser>
export async function getLanguage(ext: ".ts"|".tsx"|".js"|".jsx"): Promise<Language>
export async function getLanguageByFilePath(filePath: string): Promise<Language | null>
```

Cache `Parser` and per-ext `Language` on `globalThis.__treeSitterCache`.

---

## Task 4: Split `indexingService.ts` into `indexing/` Directory

**Current:** `src/services/indexingService.ts` (736 lines, violates CLAUDE.md 500-line cap).

**Target structure:**

```
src/services/indexing/
├── index.ts                    // re-exports IndexingService class
├── types.ts                    // SymbolNode, EdgeNode, ParsedFile interfaces
├── tsParser.ts                 // tree-sitter-based symbol/call extraction for TS/JS
├── legacyRegexParser.ts        // TEMPORARY: current parseFileSymbols, deleted in Task 7
├── graphBuilder.ts             // resolves rawCalls → edge rows
├── incrementalUpdater.ts       // file diff/unchanged/changed/deleted logic
└── indexOrchestrator.ts        // the IndexingService class: indexFolder, runIndex, isIndexing
```

Each file under 500 lines.

---

## Task 5: Implement Tree-sitter TS/JS Parser

**New file:** `src/services/indexing/tsParser.ts`.

Replace `parseFileSymbols` with tree-sitter-based extraction. Use the **query DSL**:

```scheme
(function_declaration name: (identifier) @name) @fn
(variable_declarator name: (identifier) @name value: (arrow_function)) @arrow
(class_declaration name: (type_identifier) @name) @cls
(method_definition name: (property_identifier) @name) @method
(call_expression function: [(identifier) (member_expression)] @callee)
(import_statement (import_clause (named_imports (import_specifier name: (identifier) @imported)))) @import
```

Key invariants:
- **Symbol ID** derived from `(repoId, filePath, kind, name, lineStart)` — deterministic across re-parses.
- **Edge kind** normalized to `CALLS` everywhere (write + read). Fixes the `call` vs `CALLS` casing bug.
- **JSX/TSX** handled via `tree-sitter-tsx.wasm` grammar.
- **Anonymous/default exports** get a synthetic name like `default` or `anonymous-${lineStart}`.
- Non-TS/JS files skipped with logged warning until follow-on specs land.

---

## Task 6: Parity Tests

**New files:** `tests/indexing/parity.test.ts`, `tests/indexing/fixtures/*.{ts,tsx,js,jsx}`.

Fixtures cover: named/async/generator functions, arrow functions, classes, methods (including private `#method`), TS generics/decorators/interfaces/enums, JSX/TSX components, nested functions, method chains, default/named imports, comment patterns that broke the brace counter.

Assert symbol count, line ranges, ID stability across re-parses, and agreement with the legacy regex parser on obvious cases.

Vitest is already in devDeps. Mirror existing test pattern.

---

## Task 7: Wire Parser + Delete Regex Code

- Replace `parseFileSymbols` call in `indexOrchestrator.ts` with tree-sitter parser from `tsParser.ts`.
- Add extension gate: only `.ts/.tsx/.js/.jsx` parsed; others log `[indexing] skipping {file}: no grammar yet`.
- Delete `legacyRegexParser.ts`, `findBlockEnd`, regex patterns at `:116-377`.
- Update class header comment at `:36-40`.

---

## Task 8: Documentation + Final Verification

- Add `CLAUDE.md` conventions entry for tree-sitter singleton.
- Add `CLAUDE.md` Troubleshooting for missing-grammar case.
- Update `README.md` to mention TS/JS support.
- Update `prd.md:337` gap audit + `roadmap.md:84` Track 1A — mark resolved.
- Mark all `tasks.md` items complete.

---

## Verification (end-to-end)

1. **Unit:** `npm test` — parity tests pass. Existing tests still pass.
2. **Lint:** `npm run lint` (tsc --noEmit) clean.
3. **Build:** `npm run build` — catches WASM loader issues that only surface at build time.
4. **Runtime — self-index:** Start dev server, register GrepLoop's own repo, trigger indexing. Confirm:
   - `public/grammars/*.wasm` exists.
   - No "no grammar yet" warnings for `.ts`/`.tsx` files.
   - `Symbol` table rows with correct `(filePath, lineStart, lineEnd)`.
   - `Edge` table rows with `kind = "CALLS"`.
5. **Runtime — review:** Trigger PR scan on a TS-only test branch. Findings cite real line numbers.
6. **Incremental:** Touch one file, re-index. Only that file's symbols/edges change.
7. **Stability:** Same index twice with no changes. Symbol count identical.

---

## Out of Scope (deferred to follow-on specs)

- **Python / Go / Ruby / PHP grammars.** Each is its own spec.
- **`IMPORTS`, `DEFINES`, `EXTENDS`, `OVERRIDES` edge kinds** (PRD §11.2). Wire incrementally after `CALLS` is stable.
- **`searchCodebase` semantic fix** (`prd.md:339`). Review-time tool contract, separate concern.
- **Finding verifier** (`prd.md:340`). Separate spec.
- **`ReviewPass` / ensemble schema** (`prd.md:341`). Phase 1.5.
- **Tree-sitter incremental edit API.** Optimization for later; v1 re-parses whole files.

---

## Follow-on Language Pattern (what adding Python looks like)

| Step | Change | Size |
|---|---|---|
| 1 | `npm install tree-sitter-python` | one line |
| 2 | Add `.py` to `scripts/copy-grammars.mjs` | one line |
| 3 | Add `.py → tree-sitter-python.wasm` to `getLanguage()` map | one line |
| 4 | Create `pythonParser.ts` with Python-specific queries | ~150 lines |
| 5 | Add Python fixtures + parity test | ~200 lines |
| 6 | Update orchestrator dispatch | ~10 lines |

The plumbing (`treeSitter.ts`, edge normalization, symbol ID scheme, incremental updater, graph builder, DB persistence) is language-agnostic. Each follow-on is mechanical.

---

## Critical files referenced

- `src/services/indexingService.ts` — being replaced (736 lines, regex-based)
- `src/lib/llmClient.ts` — lazy-singleton pattern to mirror
- `src/lib/prisma.ts` — globalThis guard pattern
- `src/services/embeddingService.ts` — circuit-breaker pattern (may need similar for tree-sitter init)
- `reviewService.ts` — `getCallers` consumer; verify edge-kind casing before changing writer
- `.agent-os/specs/2026-06-23-1919-multi-provider-fallback/` — format template
- `prd.md:188-214` (indexing pipeline), `prd.md:337` (gap audit), `prd.md:471` (open Q — resolved)
- `roadmap.md:80-94` (Track 1A tasks)
