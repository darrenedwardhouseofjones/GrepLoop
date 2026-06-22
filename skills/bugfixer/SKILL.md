---
name: bugfixer
description: Auto-fix code review findings from BugHunter. Use when the user wants to fix issues found by a review, or invokes /bugfixer.
user-invocable: true
---

# BugFixer

Automatically fixes code review findings from a BugHunter review. Calls `/bughunter` to get findings, applies the suggested fixes, commits, and re-reviews until the rating hits 4/5 or better.

## How to use

- **`/bugfixer`** — Full loop: review → fix → re-review → repeat until 4/5
- **`/bugfixer once`** — Single pass: fix all findings above 0.5 confidence, commit, done

## Auto-fix protocol

1. **Get review** — Call `POST /api/mcp/command` with `/prcheck` (or `{ repoId, branch }`)
2. **Check rating** — If >= 4/5, report "Already passing" and exit
3. **Filter findings** — Only act on findings with `confidence >= 0.5`. Skip noise.
4. **Apply fixes** — For each finding:
   - Read the file at the reported line
   - Understand the surrounding context
   - Apply the `diffSuggestion` code change (or a reasonable fix)
5. **Commit** — `git commit -am "fix: address review findings"`
6. **Re-review** — Call `/prcheck` again on the updated commit
7. **Loop** — If still < 4/5, repeat from step 3. If 3+ iterations with no rating improvement, warn the user and stop.
8. **Report** — Show the final rating and a summary of what was fixed.

## Preconditions

Same as `/bughunter`: dev server must be running, repo must be indexed, a PR must exist for the current branch.
