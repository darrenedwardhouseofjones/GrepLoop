# Plan — Index Freshness Gates + UI Hardening

## Context

The endpoint sweep surfaced five concrete issues blocking the "scan the correct updated code" guarantee:

1. **3 scan paths bypass the indexedAt gate.** Only `/api/prs/{prId}/scan` returns `409 INDEX_REQUIRED`. The prepush hook, MCP `prcheck`, and the legacy `{command:"prcheck"}` shape all run `runPrScan` directly against un-indexed repos — silent diff-only reviews.
2. **No staleness check.** `indexedAt` proves *some* index exists, not that it matches the working tree. New commits after indexing → review runs against stale context until manual reindex.
3. **BigInt serialization crash.** `/api/repos/{id}/symbols` throws `Do not know how to serialize a BigInt` because `Symbol.summaryAt` and `File.parsedAt` are `BigInt?`. Symbol tab is broken.
4. **No in-flight UI guard.** Scan + Reindex can be clicked concurrently. The API blocks double-reindex (409), but the UI fires Reindex → Scan against the half-cleared index without warning.
5. **Presets .bak spam.** `[llmPresets] main file unreadable, falling back to .bak` appears 40+ times in `/tmp/greploop-dev.log`. Not fatal, but obscures real errors.

Intended outcome: every scan path requires a fresh index, the UI prevents the obvious race, the symbol endpoint works, and the dev log only warns once per actual corruption event.

---

## Phase 1 — `indexedAt` gate on bypassing scan paths

**Files:**
- `src/app/api/hooks/prepush/route.ts`
- `src/app/api/mcp/prcheck/[prIdOrNumber]/route.ts`
- `src/app/api/mcp/command/[[...args]]/route.ts` (both `handlePrCheck` and the legacy `prcheck` branch)

**Pattern (mirror `/api/prs/[prId]/scan/route.ts:26`):**

After resolving the repo, before calling `runPrScan`, check `repo.indexedAt`. Return the surface-appropriate failure envelope:

- prepush: `{ passed: false, error: "INDEX_REQUIRED", message: "..." }` with 409
- MCP prcheck GET: `{ status: "Error", message: "..." }` with 409
- MCP command (both branches): return a markdown string `> ⚠ **Index required** ...` so the LLM agent gets a hint to call the index tool first

No shared helper — the response envelopes differ enough that a helper would just shuffle shape constants. Three small inline checks are clearer.

---

## Phase 2 — Staleness check (HEAD vs indexed-at HEAD)

**Schema:** `Repository.lastCommitHash String` already exists. The indexer just doesn't populate it.

**File:** `src/services/indexingService.ts`

After `prisma.repository.updateMany({ ..., data: { status: 'idle', indexedAt: ... } })` (two sites: short-circuit at line ~417, full success at ~550), capture the working-tree HEAD via `execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'])` and persist it in `lastCommitHash`. Using `execFileSync` (not `execSync`) avoids the shell — no injection risk even with weird paths.

**Shared helper:** `src/lib/indexFreshness.ts`

Exports `assertIndexFresh(repo)` returning a discriminated union:
- `{ ok: true }` — index is current
- `{ ok: false, kind: "INDEX_REQUIRED", message }` — `indexedAt` is null
- `{ ok: false, kind: "STALE_INDEX", message }` — `lastCommitHash` is non-empty and differs from current HEAD

The check uses `execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'])`. Failures (not a git repo, git missing) are caught and treated as "can't verify, trust indexedAt" — never block scans on git errors.

**Apply at all 4 scan entry points**, replacing the Phase 1 indexedAt-only check: `/api/prs/[prId]/scan`, `/api/hooks/prepush`, `/api/mcp/prcheck/[prIdOrNumber]`, and inside `handlePrCheck` in the MCP command route (covers both the JSON-RPC tool and legacy command paths).

For the legacy command + MCP paths, the STALE_INDEX case returns a markdown hint rather than a 409 — agents can read the hint and call reindex.

---

## Phase 3 — BigInt serialization fix

**File:** `src/app/api/repos/[id]/symbols/route.ts`

The BigInt columns are `Symbol.summaryAt` and `File.parsedAt`. Replace the bare `NextResponse.json(symbols)` with a map that coerces BigInt → string. Explicit, type-checked, no global JSON override that could mask other BigInt sources.

```ts
const safe = symbols.map((s) => ({
  ...s,
  summaryAt: s.summaryAt != null ? s.summaryAt.toString() : null,
}));
return NextResponse.json(safe);
```

Check `/api/repos/[id]/files` for the same `parsedAt` issue during impl; apply same pattern if affected.

---

## Phase 4 — UI in-flight guard

**File:** `src/components/views/PrsView.tsx`

Add a derived `busy` flag = `isReindexing || isScanning`. Both buttons disabled when true.

Concrete changes:
- Scan button: `disabled={busy || !repoIndexedAt}`
- Reindex button: `disabled={busy}`

After Reindex completes successfully, force a refetch of the repo so `lastCommitHash` is fresh in the UI (currently `onIndexComplete` triggers this — verify the chain works end-to-end).

---

## Phase 5 — Presets .bak spam

**File:** `src/lib/llmPresets.ts`

Investigation hypothesis: the spam fires when `existsSync(PRESETS_PATH)` returns true but `parseFile` returns null. Possible causes: file briefly empty during overlapping writes, or file got rewritten with a non-PresetsFile shape.

**Fix:** dedupe the warning via a module-level boolean. First occurrence logs at warn level with the underlying error; subsequent occurrences fall back silently. This is noise reduction, not a correctness fix — the underlying race/corruption root cause would need file-watcher debugging outside the scope of this spec.

```ts
let warnedAboutBakFallback = false;

if (bak) {
  if (!warnedAboutBakFallback) {
    console.warn("[llmPresets] main file unreadable, falling back to .bak");
    warnedAboutBakFallback = true;
  }
  ...
}
```

---

## Verification

1. `curl -X POST localhost:3300/api/hooks/prepush -d '{"branch":"<branch>","repoPath":"<path>"}'` on an un-indexed repo → 409 INDEX_REQUIRED
2. Touch the working tree (any file change, commit), trigger `/api/prs/{prId}/scan` → 409 STALE_INDEX
3. Re-run after reindex completes → 200
4. `curl localhost:3300/api/repos/{id}/symbols` → 200 with array, no BigInt error
5. In UI: click Reindex, immediately try Scan → Scan button stays disabled until Reindex lands
6. Tail `/tmp/greploop-dev.log` after a fresh server start with valid presets → no `.bak fallback` spam even if reads happen frequently
7. `npm run lint && npm test` clean (33 tests still pass)

---

## Out of scope

- **Reindex during scan race.** Scan-then-reindex-simultaneously still has a window where the scan reads a half-cleared index. The Phase 4 UI guard prevents the obvious user-driven race; programmatic callers (prepush, MCP) can still hit it. Fixing properly needs a per-repo read/write lock — punt to a future spec.
- **Persisting `lastCommitHash` retroactively for already-indexed repos.** Existing rows have empty `lastCommitHash`. First scan after this ships will skip the stale check (no hash to compare against), then the next reindex populates it. Acceptable — no data migration.
