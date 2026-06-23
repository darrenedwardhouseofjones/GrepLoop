# Plan — GitHub PR Number Resolution

## Problem

`/gloop <n>` resolves `n` as a **GrepLoop ordinal** (nth PR in `createdAt asc`), but users see **GitHub PR numbers** in their IDE and think in those terms. Example from solarplanner today:

| User sees (Claude Code status bar) | What `/gloop 13` resolves to |
|---|---|
| `PR #13` (= `feature/agent-blog-api`) | Nothing — there are only 4 PRs in GrepLoop's DB. Fails. |

Same number, two different PRs. Unworkable.

## Goal

Make `/gloop <n>` resolve to GitHub PR #`n` when the repo has a GitHub remote. Fall back to ordinal for local-only repos. Surface the GitHub number in list output so users can see the mapping.

## Approach

Add a nullable `githubPrNumber Int?` column to `PullRequest`. Populate it during the existing `getRealLocalPrs` scan by calling `gh pr list --json number,headRefName --state all` once per repo (cached per scan, not per branch). Update the resolver to prefer `githubPrNumber` match over ordinal.

## Phases

### Phase 1 — Schema migration

- Add `githubPrNumber Int?` to `PullRequest` model in `prisma/schema.prisma`.
- Run `npx prisma db push` (dev). Existing rows get `null` — that's fine, they'll be populated on next scan.
- Update the prisma client: `npx prisma generate`.

### Phase 2 — GitHub number fetcher

New file: `src/lib/githubPrNumbers.ts`.

```typescript
import { execFileSync } from "child_process";

/**
 * Returns a Map of branchName → githubPrNumber for the repo.
 * Calls `gh pr list --json number,headRefName --state all --limit 500` once.
 * Returns an empty Map if:
 *   - the repo has no GitHub remote
 *   - `gh` isn't installed or isn't authenticated
 *   - the command fails for any reason
 *
 * Errors are non-fatal — we just fall back to ordinal resolution.
 * Caller treats null/empty as "no GitHub data available".
 */
export function fetchGitHubPrNumberMap(repoPath: string): Map<string, number> {
  try {
    // Quick check: does this repo have a GitHub remote?
    const remote = execFileSync("git", ["remote", "get-url", "origin"], { cwd: repoPath }).toString().trim();
    if (!remote.includes("github.com")) return new Map();

    // `gh pr list` returns JSON; --state all catches merged/closed too so
    // we can still resolve numbers for branches whose PR was already merged.
    const out = execFileSync("gh", [
      "pr", "list",
      "--json", "number,headRefName",
      "--state", "all",
      "--limit", "500",
    ], { cwd: repoPath, stdio: ["ignore", "pipe", "ignore"] }).toString();

    const arr = JSON.parse(out) as Array<{ number: number; headRefName: string }>;
    const map = new Map<string, number>();
    for (const pr of arr) {
      // If a branch has multiple PRs over time, keep the highest number
      // (most recent).
      const existing = map.get(pr.headRefName);
      if (existing === undefined || pr.number > existing) {
        map.set(pr.headRefName, pr.number);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}
```

~30 lines. Safe-fail: returns empty map on any error.

### Phase 3 — Wire into `getRealLocalPrs`

In `src/lib/getRealLocalPrs.ts`, before the per-branch loop:

```typescript
const ghNumberMap = fetchGitHubPrNumberMap(resolvedPath);
```

Inside the loop, when building `prData`:

```typescript
const prData = {
  // ...existing fields...
  githubPrNumber: ghNumberMap.get(branch.name) ?? null,
};
```

The existing upsert's `create` and `update` both spread `prData`, so this lands in both paths automatically. Branches with no GitHub PR get `null` — resolver will skip them when matching by number.

### Phase 4 — Resolver update

In `src/lib/findPr.ts`, change `findPrByIdOrNumber` so the numeric path tries GitHub number first:

```typescript
if (/^\d+$/.test(normalized)) {
  const n = parseInt(normalized, 10);

  // 1. NEW: GitHub PR number match (what users actually expect)
  const byGhNumber = await prisma.pullRequest.findFirst({
    where: { githubPrNumber: n },
    orderBy: { createdAt: "desc" },
  });
  if (byGhNumber) return byGhNumber;

  // 2. Existing: literal ID match (`pr-13`)
  pr = await prisma.pullRequest.findUnique({ where: { id: `pr-${normalized}` } });
  if (pr) return pr;

  // 3. Existing: legacy suffix match
  const list = await prisma.pullRequest.findMany({
    where: { id: { endsWith: `-${normalized}` } },
  });
  if (list.length > 0) return list[0];

  // 4. Existing: ordinal fallback (local-only repos)
  const ordinal = await prisma.pullRequest.findMany({
    orderBy: { createdAt: "asc" },
    skip: n - 1,
    take: 1,
  });
  if (ordinal.length > 0) return ordinal[0];
}
```

Order matters: GitHub number is now the primary path; ordinal is last-resort fallback.

### Phase 5 — API + UI surfacing

- `src/app/api/mcp/command/[[...args]]/route.ts` — add `githubPrNumber` to the `prlist` response shape. Format as `#13` in the human-readable text output next to the branch name:
  ```
  1. feature/agent-blog-api  (#13)  3/10
  ```
- `src/components/views/PrsView.tsx` and related — add a `#13` chip next to the branch name in the PRs list.

### Phase 6 — Skill + docs

- `skills/gloop/SKILL.md` — add to the resolution section: "`/gloop <n>` resolves `n` as the GitHub PR number when the repo has a GitHub remote. Falls back to ordinal (nth PR in createdAt order) for local-only repos."
- `~/.claude/skills/gloop/SKILL.md` — mirror the change.
- `CLAUDE.md` — note the new resolution priority.
- `prd.md` — update §8.x if it currently references ordinal resolution.

## PR sequence

1. **PR1:** Phase 1 + 2 (schema + helper) — safe to merge; helper isn't wired yet.
2. **PR2:** Phase 3 (wire helper into scan) — populates column for existing repos on next scan.
3. **PR3:** Phase 4 (resolver change) — `/gloop <n>` now prefers GitHub number.
4. **PR4:** Phase 5 + 6 (UI + docs) — users see `#13` and the skill doc explains it.

Each PR is independently shippable. PR1+2 are pure additions; PR3 is the user-visible behavior change.

## Edge cases

- **Repo has no GitHub remote** (local-only or GitLab) → `fetchGitHubPrNumberMap` returns empty map; `githubPrNumber` stays `null`; resolver falls through to ordinal. No UX change.
- **`gh` CLI not installed / not authed** → `execFileSync` throws; we catch and return empty map. Same as above.
- **Branch has multiple PRs over time** (e.g. solarplanner's `feature/help-calculator-templates` was GH#3 then GH#9) → keep the highest number in the map (line: `if (existing === undefined || pr.number > existing)`).
- **Branch exists locally but has no GitHub PR** (unpushed work) → `githubPrNumber` is `null`. Resolver skips it on number match, still finds it on ordinal or branch-name match.
- **GitHub API rate limit** → `gh` will fail; we catch and return empty map. Next scan retries.

## Testing

- Unit test `fetchGitHubPrNumberMap` with mocked `execFileSync` (success path, no-remote path, gh-missing path).
- Integration test `findPrByIdOrNumber` with seeded `githubPrNumber` values — verify GitHub-number match beats ordinal.
- Manual E2E on solarplanner after deploy: `/gloop 13` should resolve to `feature/agent-blog-api`.
