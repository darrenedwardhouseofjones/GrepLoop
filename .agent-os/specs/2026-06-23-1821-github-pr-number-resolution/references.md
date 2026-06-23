# References — GitHub PR Number Resolution

Code locations studied while shaping this spec. Each entry includes location, relevance, and what to borrow.

## Code that will change

### `src/lib/findPr.ts:3-31`

- **Relevance:** This is the resolver. `findPrByIdOrNumber` is the function that translates `/gloop 13` into a PR record. Today the numeric path tries (in order): literal ID, `pr-{n}` ID, ID-suffix match, ordinal skip/take.
- **What to borrow:** Insert a new step **before** the existing numeric matches that does `prisma.pullRequest.findFirst({ where: { githubPrNumber: n } })`. The existing chain is the fallback. Keep the `findPrByBranch` function unchanged — it's used when callers pass a branch name explicitly.

### `src/lib/getRealLocalPrs.ts:108-162`

- **Relevance:** The per-branch scan loop that creates/updates PR records. Each iteration builds `prData` and calls `prisma.pullRequest.upsert`. This is where `githubPrNumber` needs to land in the upsert payload.
- **What to borrow:**
  - Call `fetchGitHubPrNumberMap(resolvedPath)` **once before the loop** (not inside it — would do N+1 `gh` calls otherwise).
  - In the `prData` object literal, add `githubPrNumber: ghNumberMap.get(branch.name) ?? null`.
  - The upsert's `create: { id: prId, ...prData }` and `update: prData` will both pick it up automatically.
- **Safe-fail pattern at line 113-114:** The per-branch `try/catch` is the model — if a single branch fails, the scan continues. Same defensive posture applies to the `gh` call.

### `prisma/schema.prisma:63-80`

- **Relevance:** The `PullRequest` model. Mapped to `pull_requests` table via `@@map("pull_requests")` — important: the SQL table name is `pull_requests`, not `PullRequest`. (Bitten by this during the DB audit; documenting so future debugging doesn't repeat the mistake.)
- **What to borrow:** Add `githubPrNumber Int?` between `rating` and the `repository` relation. Keeps nullable-derived fields grouped together.

### `src/app/api/mcp/command/[[...args]]/route.ts:80-93`, `270-273`

- **Relevance:** The legacy `handleLegacyCommand` ordinal resolver. Same logic as `findPrByIdOrNumber` but inline — used by callers passing `{ command: "prlist 2" }` style. Won't automatically pick up the resolver change.
- **What to borrow:** Refactor to delegate to `findPrByIdOrNumber` instead of duplicating the skip/take logic. Removes the second resolver site so the GitHub-number preference applies uniformly. Alternatively, mirror the same `githubPrNumber` lookup at line 80 — but DRY suggests the delegation.

## Code to mirror

### `src/lib/getRealLocalPrs.ts:6-8`

```typescript
function git(args: string[], cwd: string) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
}
```

- **Relevance:** The safe subprocess-call pattern. `execFileSync` with explicit args array (no shell interpolation), `cwd` scoped to the repo, stdio tuned to swallow stdin/stderr.
- **What to borrow:** Use the exact same shape for `execFileSync("gh", [...], { cwd, stdio: ["ignore", "pipe", "ignore"] })` in `githubPrNumbers.ts`. Consistency prevents injection vectors.

### `src/lib/getRealLocalPrs.ts:23-33` (`branchMatches`)

- **Relevance:** Tiny glob matcher, included to show the file's style: pure functions, no classes, defensive regex.
- **What to borrow:** Code style for `fetchGitHubPrNumberMap` — same approach: pure function, returns a value, doesn't throw.

### `src/lib/webhook.ts` (referenced but not modified)

- **Relevance:** Existing webhook verification code uses similar `execFileSync` patterns. Confirms the safe-subprocess approach is established convention.

## Adjacent code worth knowing

### `src/lib/prisma.ts`

- **Relevance:** The Prisma singleton. The new `githubPrNumber` column will be available via `prisma.pullRequest` after `npx prisma generate`. No code change needed here.

### `src/app/api/mcp/prcheck/[prIdOrNumber]/route.ts`

- **Relevance:** Another caller of PR resolution. Currently takes `prIdOrNumber` from the URL path and matches via `id` only. Should consider whether `/api/mcp/prcheck/13` should also resolve via the new GitHub-number logic — but that's a separate question, not required for the core `/gloop` UX fix.

### `src/components/views/PrsView.tsx`

- **Relevance:** Where the `#13` chip needs to land in the UI. Look for where `pr.sourceBranch` is rendered and add a chip alongside it. Pattern: `{pr.githubPrNumber && <span className="...">#{pr.githubPrNumber}</span>}`.
