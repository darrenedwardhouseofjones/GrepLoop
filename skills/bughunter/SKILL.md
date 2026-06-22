---
name: bughunter
description: Review your code changes through the GrepLoop AI review engine. Use when the user asks to review their branch, check their code for bugs, run a code review, fix issues found by review, or invokes /bughunter.
user-invocable: true
---

# BugHunter

BugHunter is a self-hosted AI code review engine built on GrepLoop. It indexes the codebase, builds a call graph, and runs an agentic review loop with tool access to find bugs, security issues, and correctness problems — producing findings backed by evidence chains.

You drive it through the GrepLoop HTTP API. The review endpoint is synchronous — it blocks until the review completes (typically 30-120s for a full agentic loop).

## How `/bughunter` finds the right PR

- **`/bughunter 42`** — review PR #42 by number
- **`/bughunter`** (no args) — the skill detects the current git repo and branch, then calls MCP with `{ repoId, branch }` to look up the matching PR
- If neither a PR number nor a branch match is found, it tells the user the PR isn't registered in GrepLoop yet

This means users can just run `/bughunter` in any project directory and it works — no need to remember PR numbers.

All API endpoints require authentication. Pass your API key in the `Authorization` header:
```
Authorization: Bearer gl_mcp_<your_key>
```
Generate a key from the GrepLoop UI → Settings → MCP API Keys. If no key is configured, tell the user to create one.

## Two skills

Two separate skills, one for each job:

### `/bughunter` — Hunt (review & report)

- **`/bughunter`** or **`/bughunter review [number]`** — Review the current PR. Returns a rating 1-5 and a list of findings with confidence scores.
- **`/bughunter status`** — Show the current PR's last review result without triggering a new scan.

If no PR number is given, the skill reads the current git branch and resolves the PR automatically.

### `/bugfixer` — Fix (auto-fix loop)

- **`/bugfixer`** — Review → fix → re-review until rating >= 4/5, then report pass.
- **`/bugfixer once`** — Apply fixes for all findings above `minConfidence` in one pass (no loop).

The fixer calls `/bughunter` to get findings, applies each fix, commits (`fix: address review findings`), then re-reviews. It loops until rating >= 4/5 or the user hits interrupt.

## Rating scale

The GrepLoop review returns a rating from 1 to 5:

- **4–5** — Production grade, safe to merge
- **1–3** — Needs fixes. Loop with `/bugfixer` until it passes.

## What the GrepLoop API returns

`POST /api/mcp/command` with command `/prcheck <number>` or `{ repoId, branch }`:

```
{
  "status": "Success",
  "rating": "4/5",
  "productionGrade": "YES" | "NO",
  "summary": "...",
  "findingsCount": 3,
  "findings": [
    "[Security | blocker] src/auth.ts:42 - Unvalidated redirect...",
    "[Correctness | warning] src/api.ts:88 - Missing error handling..."
  ]
}
```

`POST /api/mcp/command` with command `/prcomments <number>` returns the persisted findings:

```
{
  "status": "Success",
  "comments": [
    { "category": "Security", "severity": "blocker", "filename": "src/auth.ts",
      "line": 42, "comment": "...", "fixSuggestion": "...", "confidence": 0.92 }
  ]
}
```

A non-200 response means the repo hasn't been indexed yet or the PR wasn't found. Surface the error message to the user with instructions.

## Auto-fix protocol (`/bugfixer`)

When fixing findings, follow this loop:

1. **Call review** — `POST /api/mcp/command` with `/prcheck` (or pass `repoId`+`branch`)
2. **Check rating** — If >= 4/5, report pass and exit
3. **Present findings** — Show findings filtered by confidence (>= 0.5). Skip low-confidence noise.
4. **Apply fixes** — For each finding, read the file at the specified line, understand context, apply the `diffSuggestion` code change.
5. **Commit** — `fix: address review findings`
6. **Re-review** — Call `/prcheck` again
7. **Loop** — If still < 4/5, repeat. If 3+ iterations with no rating improvement, warn the user.
8. **Report** — Final verdict: passed (4-5) or what remains

## Installing the pre-push hook

Run `npm run greploop install-hooks` (or `npm run install-hooks`) to install the pre-push hook. This copies `scripts/hooks/pre-push` into `.git/hooks/pre-push`. The hook automatically blocks pushes that fail review (rating < 4/5), acting as a safety net even when you don't explicitly run `/bughunter`.

## Preconditions

Before running any review:
- The GrepLoop dev server must be running
- Verify with `curl -s http://localhost:3300/api/repos | jq length` — if the response is empty or fails, tell the user to start the server with `npm run dev`.
- The current directory must be inside a git repository with a non-default branch
- The repo must be registered in GrepLoop (visible in the sidebar)
- The repo must have been indexed (open the "Codebase AST graph" tab and run the indexer)
