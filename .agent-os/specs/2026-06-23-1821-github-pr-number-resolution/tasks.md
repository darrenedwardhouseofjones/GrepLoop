# Tasks — GitHub PR Number Resolution

Mark each `- [ ]` as `- [x]` when complete. Per user convention: update this file as work ships.

## Pre-flight

- [ ] Confirm `gh` CLI is installed and authenticated on the dev machine (`gh auth status`). Needed for local testing — production will have its own setup.

## Phase 1 — Schema migration

- [ ] Add `githubPrNumber Int?` to `PullRequest` model in `prisma/schema.prisma` (between `rating` and `repository` relation).
- [ ] Run `npx prisma generate` to refresh the client types.
- [ ] Run `npx prisma db push` to apply the column add. (Additive — safe for dev. Migration file created for prod.)
- [ ] Verify column exists via `psql` or Prisma Studio.

## Phase 2 — GitHub number fetcher

- [ ] Create `src/lib/githubPrNumbers.ts` exporting `fetchGitHubPrNumberMap(repoPath: string): Map<string, number>`.
- [ ] Implement per `plan.md` Phase 2: check remote is GitHub, shell out to `gh pr list --json number,headRefName --state all --limit 500`, parse into Map, keep highest number per branch.
- [ ] Wrap everything in try/catch — return empty Map on any error.
- [ ] Unit test with mocked `execFileSync`: success path (parses PR list), no-GitHub-remote path (returns empty), `gh` missing path (returns empty), `gh` returns malformed JSON (returns empty).

## Phase 3 — Wire into scan

- [ ] In `src/lib/getRealLocalPrs.ts`, import `fetchGitHubPrNumberMap`.
- [ ] Call it once before the per-branch loop, store result as `ghNumberMap`.
- [ ] Add `githubPrNumber: ghNumberMap.get(branch.name) ?? null` to the `prData` object literal.
- [ ] Confirm the existing `upsert` `create` and `update` spreads both pick it up.
- [ ] Manual test: trigger a scan on solarplanner, verify `githubPrNumber` is populated for `feature/agent-blog-api` (should be 13).

## Phase 4 — Resolver update

- [ ] In `src/lib/findPr.ts`, add `githubPrNumber` match as the first numeric-resolution step in `findPrByIdOrNumber`.
- [ ] Confirm fallback chain is preserved (literal ID → `pr-{n}` → suffix → ordinal).
- [ ] Refactor `src/app/api/mcp/command/[[...args]]/route.ts:80-93` legacy resolver to delegate to `findPrByIdOrNumber` (or mirror the new logic — DRY preferred).
- [ ] Unit test: seed PRs with `githubPrNumber`, verify `/gloop 13` returns the GitHub-13 PR not the 13th-ordinal PR.

## Phase 5 — API + UI surfacing

- [ ] Add `githubPrNumber` field to `prlist` response in `src/app/api/mcp/command/[[...args]]/route.ts`.
- [ ] In `formatFindings` and the list-mode formatter, render `(#13)` next to branch name when present.
- [ ] In `src/components/views/PrsView.tsx`, add a `#13` chip element next to the branch name when `pr.githubPrNumber` is set.
- [ ] Manual E2E: load `/` in browser, confirm chip appears for `feature/agent-blog-api`.

## Phase 6 — Skill + docs

- [ ] Update `skills/gloop/SKILL.md` resolution section: explain GitHub-number priority, ordinal fallback for local-only repos.
- [ ] Mirror change to `~/.claude/skills/gloop/SKILL.md`.
- [ ] Update `CLAUDE.md` to note the new resolution order.
- [ ] Update `prd.md` if it currently references ordinal resolution.

## Phase 7 — Ship

- [ ] Type check: `npm run lint`.
- [ ] Tests: `npm test`.
- [ ] End-to-end test on solarplanner: `/gloop 13` resolves to `feature/agent-blog-api`. Confirms the user's original bug is fixed.
- [ ] Commit in the 4-PR sequence described in `plan.md`.
