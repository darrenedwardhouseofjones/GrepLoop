# Shape — GitHub PR Number Resolution

## Scope

Make `/gloop <n>` resolve `n` as the GitHub PR number when the repo has a GitHub remote. Today `n` is a GrepLoop ordinal (nth PR by `createdAt`), which never matches what users see in their IDE.

Concrete trigger: user is on `feature/agent-blog-api` in solarplanner, Claude Code shows `PR #13`, they type `/gloop 13`, GrepLoop looks for the 13th PR in its DB — finds nothing because only 4 PRs are registered. UX is broken.

## Decisions

- **Nullable column, not backfill.** Add `githubPrNumber Int?`. Existing rows get `null` and resolve via ordinal until next scan repopulates. Cheaper than a one-shot backfill script and the scan will catch up within seconds of deploy.
- **`gh` CLI as the data source, not GitHub REST API.** Avoids OAuth/token plumbing — `gh` is already authed on dev machines and CI. If `gh` is missing or unauthed, we silently fall back to ordinal. No new env vars, no secrets to manage.
- **One `gh pr list` call per scan, not per branch.** `gh pr list --json number,headRefName --state all --limit 500` returns the full branch→number map in one shot. Cached in a `Map<string, number>` for the duration of the scan loop. Avoids N+1 API calls.
- **Resolver order: GitHub number → literal ID → ordinal.** GitHub number is what users mean. Ordinal is the silent fallback for local-only repos (no GitHub remote). The fallback preserves backwards compatibility.
- **When a branch has multiple PRs over time, keep the highest number.** Solarplanner's `feature/help-calculator-templates` was GH#3 (merged) then GH#9 (open). Users running `/gloop 9` expect the open one. Taking `max(number)` matches that intuition.
- **Surface `#13` in list output.** Users need to see the mapping. The list view in the skill and UI shows `feature/agent-blog-api (#13) — 3/10` so the number is visible without forcing users to look it up in GitHub.
- **Spec lives separately from deploy-key spec.** The deploy-key spec (`2026-06-23-1445-deploy-key-remote-repos`) is scoped to PRD §8.3 remote registration. This feature is orthogonal UX — affects local AND remote repos. Different scope, different spec.

## Context

- **Visuals:** None. No UI mockups — the change is additive (a `#13` chip next to existing branch name).
- **References studied:** `src/lib/findPr.ts`, `src/lib/getRealLocalPrs.ts`, `src/app/api/mcp/command/[[...args]]/route.ts:80-93` (legacy ordinal resolver), `prisma/schema.prisma:63-80` (PullRequest model).
- **Product alignment:** Supports the PRD's positioning of GrepLoop as a Greptile competitor — the UX has to feel native to developers already living in GitHub.
- **Standards applied:** None — `agent-os/standards/index.yml` is empty (same situation as the deploy-key spec).

## Out of scope

- GitLab merge-request number resolution (would need `glab mr list` equivalent). Follow-up if/when a user asks.
- Resolving by GitHub PR URL (`https://github.com/owner/repo/pull/13`). Could be added to the resolver later; the `#13` shortcut covers 95% of cases today.
- Backfilling `githubPrNumber` for existing PR rows in a one-shot migration. Next scan handles it.
- Caching the `gh pr list` result across scans (e.g. in DB or Redis). Per-scan fetch is fast enough; cross-scan caching adds invalidation complexity.

## Follow-ups noted (not in this spec)

- The current `/gloop status` output is overly verbose — the agent adds hallucination analysis and follow-up menus the skill doc doesn't ask for. Separate fix needed in `skills/gloop/SKILL.md` (terseness rule + `status` no-args mode).
- The retrieval layer is pulling cross-repo context into reviews (solarplanner's scan cited `app.greploop.com` in a CORS finding). Separate indexing/retrieval contamination bug to investigate in `reviewService.ts:297+`.
