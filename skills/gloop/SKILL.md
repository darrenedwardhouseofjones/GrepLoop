---
name: gloop
description: Review code through the GrepLoop engine. Use when the user asks to review their branch, check code for bugs, run a code review, fix issues found by review, or invokes /gloop.
user-invocable: true
---

# GrepLoop (`/gloop`)

GrepLoop is a self-hosted AI code review engine. It indexes the codebase, builds a call graph, and runs an agentic review loop with tool access to find bugs, security issues, and correctness problems — producing findings backed by evidence chains.

You drive it through the GrepLoop HTTP API. Reviews start asynchronously — poll `prcheckstatus` until the run completes (typically 30-120s for a full agentic loop).

## Commands

All commands live under `/gloop`:

| Command | What it does |
|---|---|
| `/gloop` | List all PRs for the current repo with ratings. Lets the user pick one. |
| `/gloop <number>` | Review a specific PR. Returns rating 1-5 + findings with confidence scores. |
| `/gloop status <number>` | Show existing review results without triggering a new scan. |
| `/gloop fix <number>` | Auto-fix loop: review → fix → re-review until rating >= 4/5. |
| `/gloop fix <number> --once` | Single pass: fix all findings above 0.5 confidence, commit, done. |

Typical workflow: `/gloop` → see PR list → `/gloop 2` → see it's 2/5 → `/gloop fix 2` → loop until 4/5.

## How `/gloop` resolves the repo

Detect the current repo from the working directory and resolve it to a GrepLoop `repoId` via `GET /api/repos/resolve?dir=<pwd-url-encoded>`. If the API returns null, say "This project is not registered in GrepLoop" and stop. Otherwise use the resolved repoId for subsequent calls.

Dispatch on `$ARGUMENTS`:
- Empty → list mode
- `status <number>` → status mode
- `fix <number> [--once]` → fix mode
- `<number>` → review mode

## Auth

All API endpoints require an API key in the `Authorization` header:
```
Authorization: Bearer gl_mcp_<your_key>
```
Generate a key from the GrepLoop UI → Settings → MCP API Keys. If no key is configured, tell the user to create one. The CLI (`scripts/greploop.mjs`) and pre-push hook read it from `GREPLOOP_API_KEY`.

## Rating scale

The GrepLoop review returns a rating from 1 to 5:
- **4–5** — Production grade, safe to merge
- **1–3** — Needs fixes. Loop with `/gloop fix` until it passes.

## API endpoints

All POST to `/api/mcp/command`. Body is JSON.

**Start a review** — `{ "tool": "prcheck", "args": { "number": "5" } }` or `{ "args": { "repoId": "...", "branch": "..." } }`. Returns immediately; poll with `prcheckstatus`.

**Poll a review** — `{ "tool": "prcheckstatus", "args": { "number": "5" } }`. Returns progress or the completed result.

**Get persisted findings** — `{ "tool": "prcomments", "args": { "number": "5" } }`. Returns the latest saved findings without re-running.

**List PRs** — `{ "tool": "prlist", "args": { "repoId": "..." } }`. Returns all PRs with their current ratings.

Completed review response shape:
```
{
  "status": "Success",
  "rating": "4/5",
  "productionGrade": "YES" | "NO",
  "summary": "...",
  "findings": [{
    "category": "Security" | "Correctness" | "Performance" | "Accessibility" | "Style",
    "severity": "blocker" | "warning" | "suggestion",
    "filename": "src/foo.ts",
    "line": 42,
    "explanation": "...",
    "diffSuggestion": "...",
    "confidence": 0.0-1.0,
    "evidenceChain": [{ "file": "...", "line": 88, "text": "..." }]
  }]
}
```

## Subcommand protocols

### `/gloop` (list mode)

1. Detect repo via `git remote get-url origin` (or current working dir), resolve via `GET /api/repos/resolve`.
2. POST `prlist` with the resolved repoId.
3. Render the PR list with ratings; ask the user to pick one or run `/gloop <number>`.

### `/gloop <number>` (review mode)

1. Detect repo, resolve repoId.
2. POST `prcheck` with `{ number }` (or `{ repoId, branch }`).
3. Poll `prcheckstatus` until `status` is `Success` (or `Failed`).
4. Render the rating, summary, and findings with confidence scores. Group by severity.

### `/gloop status <number>`

1. Detect repo, resolve repoId.
2. POST `prcomments` with `{ number }`.
3. Render the existing review without triggering a new scan. If no review exists yet, say so and suggest `/gloop <number>`.

### `/gloop fix <number>` (and `--once`)

1. **Get review** — POST `prcheck` with `{ number }`, poll `prcheckstatus` to completion.
2. **Check rating** — If >= 4/5, report PASS and exit.
3. **Filter findings** — Only act on findings with `confidence >= 0.5`. Skip noise.
4. **Apply fixes** — For each finding: read the file at the reported line, understand the surrounding context, apply the `diffSuggestion` (or a reasonable fix that addresses the root cause).
5. **Commit** — `git commit -am "fix: address review findings"`.
6. **`--once` stops here.** Otherwise re-review via `prcheck` and loop from step 2.
7. **Stop conditions** — rating >= 4/5, or 3+ iterations with no rating improvement (warn the user and stop).
8. **Report** — Show the final rating and a summary of what was fixed.

## Preconditions

- GrepLoop dev server running (`npm run dev` from the GrepLoop repo).
- Current repo registered in GrepLoop and indexed.
- A PR exists for the current branch (or pass `<number>` explicitly).
- `GREPLOOP_API_KEY` env var set, or pass via `Authorization: Bearer` header.
