# Roadmap: GrepLoop

**Status:** Living document. Updated whenever priorities shift.
**Pair with:** [`prd.md`](./prd.md) (what we're building) and [`CLAUDE.md`](./CLAUDE.md) (how the codebase is wired).

---

## Where we are now (June 2026)

GrepLoop is a single-framework Next.js 16 app talking to Supabase Postgres via Prisma 7. Express and Firebase have been removed. All 18 API endpoints are Route Handlers. The dashboard boots, talks to real Supabase, and can run a fake review against a local git repo.

**Done in the current cycle:**
- Consolidated PRD-1 + PRD-2 into one self-hosted-multi-tenant spec (`prd.md` Draft v3)
- Removed Express + Firebase; migrated all endpoints to Next Route Handlers
- Wired the in-app DB config tab to real Postgres/Supabase connections (with the pg 8.21 SSL workaround)
- Extracted `DashboardSidebar`, `DbConfigView`, `PrsView`, `AddRepoModal` out of `App.tsx` (1,642 → 774 lines)
- Added CI (lint + test + build on PR)
- Added Vitest smoke tests for `dbConfig.ts` and `types.ts`
- Deleted the prompt-injection `AGENTS.md`, replaced with a clean `CLAUDE.md`
- Scrubbed leaked Supabase password out of `.env.example`

**Carryover from this cycle (small items, finish before Phase 1):**
- Extract `useDashboardData` hook — `App.tsx` is still 774 lines, target <500
- Rebrand remaining "Woodhill" strings (`src/App.tsx` footer, `reviewService.ts` sample findings)
- Rotate Supabase DB password (leaked in git history at `9ac1490` — **user action, dashboard**)
- Delete `FIREBASE_SERVICE_ACCOUNT_GREPLOOP_956F8` GitHub repo secret (**user action, repo settings**)

---

## How the roadmap is organized

Five phases. Each phase has a **goal** (the user-visible outcome), **work items** (concrete deliverables), and a **definition of done**. Phases are sequential by default but work items inside a phase can be parallelised.

Phases 0–1 are "make it real" — without them nothing else matters. Phases 2–3 are "make it good." Phase 4 is "make it shippable to someone else."

---

## Phase 0 — Finish what we started (1–2 days)

**Goal:** Zero loose ends from the current refactor. Codebase is in a state where a new feature branch starts from a clean base.

### Work items
- [ ] Extract `useDashboardData` hook (polling, CRUD state) from `App.tsx` to get it under 500 lines
- [ ] Rebrand "Woodhill" → "GrepLoop" in `src/App.tsx` footer and `reviewService.ts` sample findings
- [ ] Add Vitest coverage for at least one Route Handler (pattern: mock `prisma`, test happy + error path)
- [ ] Add a `README.md` worth reading — what GrepLoop is, how to run it, where the PRD lives, link to `CLAUDE.md`
- [ ] Add `CONTRIBUTING.md` with the branch / commit-message / file-size conventions from `CLAUDE.md`

### Definition of Done
- `App.tsx` < 500 lines
- No "Woodhill" string anywhere in `src/`
- `npm run lint && npm test && npm run build` clean on CI
- A new contributor can clone the repo, read `README.md`, and have the app running locally within 15 minutes

---

## Phase 1 — Auth foundation (the gate to everything multi-tenant)

**Goal:** A user can sign up, sign in, be a member of an organization, and only see repos their role grants. The PRD's Section 5 is implemented end-to-end.

This is the **single most important phase**. Without it, "multi-tenant" is just a word in the PRD.

### Work items
- [ ] Install and configure Better Auth 1.6 with the organizations plugin
- [ ] Prisma schema: `User`, `Organization`, `OrganizationMember`, `RepositoryMember` (PRD Section 5.1 — schema supports multi-org from day one even though MVP ships single-org)
- [ ] Better Auth schema migration (their required tables: `user`, `session`, `account`, `verification`, `organization`, `member`)
- [ ] Sign-up / sign-in / sign-out UI (replace or sit alongside the current no-auth dashboard)
- [ ] Organization switcher in `DashboardSidebar` (a user can be a member of N orgs — PRD use case 6)
- [ ] Role enforcement middleware: owner / member / viewer per org; same trio per repo
- [ ] **Row-level scoping in every Route Handler** — every `prisma.repo.findMany()` becomes `prisma.repo.findMany({ where: { orgId, id: { in: visibleRepoIds } } })`
- [ ] Invite flow: org owner types an email, recipient gets a magic link, lands in the org
- [ ] Audit log table (`who did what at when` — write-only, used in Phase 3)

### Definition of Done
- Two test users in two orgs cannot see each other's repos
- An org owner can invite a new user via email and that user lands in the org with `member` role
- Every API response is scoped to the calling user's permissions — verified by a test that hits an endpoint as user A and asserts user B's data isn't in the response
- Sessions persist across server restarts

### Risks
- **Better Auth org plugin schema collision** with our existing `User`-ish tables — plan the migration carefully, test against a throwaway Supabase branch first
- **Forgetting a Route Handler** during scoping — every single one needs review. CI test should hit each endpoint as a user with no access and assert 404 (not 403 — don't leak existence)

---

## Phase 2 — Real review engine (replace the fake)

**Goal:** A PR scan produces actual findings from an actual LLM, with evidence chains pointing at real code locations. The current `reviewService.ts` returns hardcoded sample findings — it goes away.

### Work items
- [ ] Pluggable LLM router: Gemini (cloud), Ollama (local), and a "no LLM" rule-only fallback so the product works without an API key (PRD Section 9 — local LLM is a stated wedge)
- [ ] Real review prompt chain: diff → grouped hunks → per-hunk LLM call with file context → findings array
- [ ] Evidence chain shape: `{ finding, severity, file, lineRange, why, relatedSymbols: [{name, file, line}] }` — every finding points at code
- [ ] Streaming UI: findings appear as they're generated, not after a 30-second wait
- [ ] Persist findings to `ReviewFinding` table (schema already exists) with full evidence chain JSON
- [ ] Token / cost accounting per review (so an org owner can see "this PR cost $0.14 to review")
- [ ] Review categories from PRD Section 14: OWASP top 10, WCAG, Core Web Vitals, type safety ("no `any`"), plus the standard bug/smell checks

### Definition of Done
- Running a scan against a real PR produces findings that reference actual code lines (not invented)
- Findings are stable — running the same diff twice produces ~the same output
- Cost per review is visible in the UI
- The fake `reviewService.ts` sample findings are deleted

### Risks
- **Hallucinated evidence** (LLM cites line 472 of a 200-line file) — every finding's line range must be validated to exist in the diff before showing it
- **Cost runaway** — without per-org quotas (Phase 3) a tight inner loop could rack up a big bill. Hard-cap reviews-per-day per org as a stopgap

---

## Phase 3 — Full-codebase indexing (the Greptile-tier wedge)

**Goal:** Reviews aren't diff-only — they have whole-codebase context. This is the architectural decision that separates Greptile-tier review quality from diff-only reviewers per the PRD.

**This is the technically hardest phase.** Defer until Phase 2's review loop is solid.

### Work items
- [ ] tree-sitter integration for TS/JS/Python/Go/Rust (start with TS only — eat our own dog food)
- [ ] Symbol extraction: functions, classes, methods, exports — written to a `Symbol` table
- [ ] Call graph edges: `caller → callee` per symbol
- [ ] LLM-generated per-symbol summaries (one short paragraph per function — batched, cheap model)
- [ ] pgvector extension on Supabase (already available — just enable)
- [ ] Embeddings for every symbol + every docstring/comment block
- [ ] Vector + graph hybrid retrieval: when reviewing a diff, pull (a) the k nearest symbols by embedding, (b) all direct callers/callees of any symbol in the diff
- [ ] Background re-indexing on `git push` (file watcher + incremental index — only re-index changed files)
- [ ] Indexing status UI (currently the dashboard has a polling UI; make it show real indexing progress)

### Definition of Done
- After indexing, asking "what calls `foo()`" returns the correct answer
- A review of a 5-line diff in a 50k-line repo references symbols defined elsewhere in the codebase
- Re-indexing after a 1-file change takes seconds, not minutes (incremental, not full)
- pgvector queries return in <100ms at 100k symbols

### Risks
- **tree-sitter grammar maintenance** — each language is a separate npm package with its own update cadence. Start with TS, add languages one at a time
- **Embedding cost** — 100k symbols × Gemini embedding API = real money. Use a local embedding model (e.g. `nomic-embed-text` via Ollama) as the default, cloud as opt-in
- **pgvector index choice** — HNSW vs IVFFlat. Default HNSW for recall; revisit at scale

---

## Phase 4 — Production hardening (when someone else installs it)

**Goal:** A second person — not the author — can clone, configure, and run GrepLoop in their own infrastructure without calling the author. This is where "self-hosted SaaS" becomes true.

### Work items

**4a. Deployment packaging**
- [ ] `Dockerfile` (multi-stage: build → runtime, final image <300MB)
- [ ] `docker-compose.yml` with GrepLoop + Postgres + (optional) Ollama
- [ ] Health check endpoint (`GET /api/health` — DB reachable, LLM configured, indexer idle)
- [ ] Migration runner as a container entrypoint (`prisma migrate deploy` before Next boots)
- [ ] Documented environment variables in `README.md` — every var, what it does, required vs optional

**4b. Observability**
- [ ] Structured logging (pino or next-logger) — replace `console.log` across Route Handlers
- [ ] Request IDs propagated end-to-end (so a slow scan can be traced)
- [ ] Error tracking — Sentry-compatible (GlitchTip for self-hosted parity) with source maps
- [ ] Basic metrics endpoint: reviews/run, avg latency, LLM spend, index freshness — enough to answer "is the app healthy?"

**4c. Security hardening**
- [ ] Rate limit: 5 auth attempts / minute / IP, 10 scan requests / hour / org
- [ ] CSRF protection on any cookie-auth form post (Better Auth handles most of this — verify)
- [ ] `Secure`/`HttpOnly`/`SameSite=Lax` on all auth cookies (verify Better Auth defaults)
- [ ] Secrets not in `.env.example` (already done — keep it that way)
- [ ] Audit log viewer in the admin UI (write side built in Phase 1)
- [ ] Dependency audit — `npm audit` clean, Dependabot enabled

**4d. Migration strategy**
- [ ] First real Prisma migration (we currently have schema but no migration history — `prisma migrate dev` to baseline)
- [ ] Migration tested against a fresh empty database (catches drift between schema and migrations)
- [ ] Documented upgrade path: pull new image → `prisma migrate deploy` → restart

**4e. Backup and DR**
- [ ] Documented `pg_dump` / `pg_restore` procedure in `README.md`
- [ ] Supabase PITR pointer in docs (Supabase Pro has this built-in — note for self-hosters not on Supabase)
- [ ] Test restore from backup into a fresh database at least once before declaring Phase 4 done

### Definition of Done
- A second person (not the author) follows `README.md` and has a running GrepLoop on their machine within an hour
- Structured logs are queryable (e.g. `docker logs greploop | jq 'select(.level=="error")'`)
- An auth-brute-force test (100 wrong passwords in 10 seconds) is throttled
- A test restore from `pg_dump` succeeds against a fresh Postgres instance
- `npm audit` returns zero high/critical vulnerabilities

### Risks
- **Prisma migration baseline** — our schema has drifted in dev via `db push`. The first `migrate diff` may surface unintended schema deltas. Run it on a copy first
- **Docker image size** — Next.js standalone output mode is mandatory to keep the image small
- **Self-hosted LLM ergonomics** — if we recommend Ollama, the docker-compose needs to optionally pull a multi-GB model on first run. Document it, don't surprise the user

---

## Cross-cutting concerns (not phases — applied throughout)

These don't belong to a single phase; they're ongoing.

### Testing
- **Current:** 22 tests, both in `tests/` against `src/lib/*`
- **Target by end of Phase 1:** Route handler tests (mock prisma, assert response shape + auth scoping)
- **Target by end of Phase 2:** Review engine tests — fixture diff in, expected findings out (snapshot tests are fine here)
- **Target by end of Phase 3:** Indexing integration test — index a 50-file fixture repo, assert graph shape
- **Never:** E2E tests that hit a real LLM. Mock the LLM in CI, real LLM only in manual smoke tests

### Documentation
- `README.md` — getting started, what GrepLoop is, link to PRD
- `docs/self-hosting.md` — Phase 4 deliverable
- `docs/api.md` — auto-generated from Route Handler types if possible
- `CLAUDE.md` — kept current (already exists, update as conventions evolve)
- Inline code comments — per global rule: only when the *why* is non-obvious

### Accessibility
GrepLoop checks other people's code for WCAG issues (PRD Section 14). The app needs to pass the same bar.
- [ ] Phase 1: keyboard-navigable sidebar, focus traps in modals
- [ ] Phase 2: aria-live regions for streaming review findings
- [ ] Phase 4: axe-core in CI, zero critical violations

### Performance
- 2s dashboard polling cadence is current (acceptable for MVP)
- Watch for N+1 in the auth scoping layer (Phase 1) — `findMany` then per-row `findUnique` is the classic trap
- Vector search latency budget: <100ms at 100k symbols (Phase 3 DoD)

---

## Explicitly deferred (per PRD Non-Goals, do **not** pull forward without a decision)

- Posting review comments back to GitHub/GitLab/Bitbucket PRs
- IDE-embedded inline annotations (VS Code extension)
- Review of non-text/binary diffs
- Cross-organization repository sharing (a repo belongs to exactly one org for MVP)
- Public SaaS hosted by us — self-hosted only per PRD
- Billing / paid tiers — the PRD's deployment model is "customer runs it themselves"; billing doesn't apply unless we host it ourselves, which is a separate decision

---

## Decision points (need user input, not yet resolved)

1. **Single-org MVP lock-in?** PRD says schema supports multi-org from day one, but MVP ships single-org. Confirm: do we hide the org switcher in the UI, or show it greyed-out?
2. **Default LLM backend?** Cloud Gemini is the path of least resistance; local Ollama is the wedge (air-gapped use case). Which is the *default* on a fresh install?
3. **Migration baseline timing?** Run `prisma migrate dev` now (Phase 0) to baseline before any Phase 1 schema work, or wait until Phase 4 packaging?
4. **CI environment coverage?** Current CI runs lint/test/build. Add a Postgres service container for integration tests, or keep CI unit-only and run integration tests manually?

---

## Recommended next move

**Phase 0 first, then Phase 1.** Phase 0 is 1–2 days and clears the deck. Phase 1 is the gate — everything else (Phase 2 review engine, Phase 3 indexing) is theoretical until auth scoping is real.

If the user wants a *visible* win sooner, swap Phase 1 and Phase 2 — get a real review working end-to-end (even single-user, no auth) and circle back to multi-tenant. The trade-off: every Phase 2 Route Handler then needs retrofitting for auth scoping in Phase 1. Acceptable if it's the same author; painful if the team has grown.

---

## Changelog

- **2026-06-20** — Initial roadmap. Consolidates the 5 directions previously discussed in-conversation (Auth, Review engine, Indexing, Polish, CI) and adds Deployment packaging, Observability, Security hardening, Migration strategy, Backup/DR, Testing, Documentation, and Accessibility as cross-phase concerns.
