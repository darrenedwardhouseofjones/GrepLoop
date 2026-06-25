# Plan — Scan Quality + History Redesign

## Context

**Why this work is needed.** Three visible symptoms, all stemming from one
upstream bug plus several missing UX layers:

1. **Scans produce docs-cited findings.** The last scan of `feature/bug-demo`
   returned 17 findings — every one cited
   `.agent-os/specs/2026-06-23-1445-deploy-key-remote-repos/plan.md`, all
   rejected by the verifier, all describing real code patterns the LLM had
   read via tools. The LLM did the work; the filename was just wrong.

2. **Rating/findings disconnect.** Verifier killed all 17 findings, but the
   LLM's rating (5/10) stood — set *before* verification, never adjusted
   post-rejection. UI shows 5/10 + empty findings list + a cryptic
   "Verifier filtered: 17" expandable that doesn't actually show them.

3. **No scan history.** Schema has `ReviewRun` rows but no UI surfaces
   them; `ReviewLog` has no `reviewRunId`, so logs from different scans on
   the same PR blend into one stream. User's mental model — "old scan →
   history, new scan → live log + results" — doesn't exist.

**Root cause (verified):**

- `reviewService.ts:680` and `:701` silently substitute
  `finding.filename || files[0].filename` when persisting. The JSON
  finalizer prompt (reviewService.ts:578-583) never asks for a filename,
  so M3's findings arrive filename-less and inherit `files[0]` — which
  is `.agent-os/specs/.../plan.md` (first in the PR's modified files).
- The diff payload at reviewService.ts:363-373 renders ALL PR files
  (including planning docs, READMEs) with no marker distinguishing context
  from reviewable code. The LLM sees docs as legitimate targets.
- `SYSTEM_INSTRUCTION` (line 239) says "Every finding MUST include exact
  file path" but never constrains the path to source files.

**Outcome after this plan ships:**

- Scans produce findings cited against actual source files in the diff.
- Docs/context files never appear as finding citations.
- If the LLM still misattributes, the verifier catches it AND the rating
  nulls to "unreliable" so the UI shows "re-scan needed" instead of a
  misleading 5/10 with zero findings.
- Rejected findings show inline with a chip + note (audit trail visible).
- Each scan = one `ReviewRun` with its own log stream. Old scan moves to
  history; new scan populates live log + results panels.
- Scan concurrency guarded (UI button / `/gloop` skill / prepush hook
  can no longer race on the same PR).
- UI status reflects scans triggered from any source (curl/skill/hook),
  not just the UI button click path.

**Decisions locked with user (2026-06-25):**
- All four phases in one spec, shipped in sequence.
- Verifier stays — it catches real hallucinations. Stop *hiding* rejected
  findings; start showing them inline.
- Rating nulls when ALL findings rejected (clean "re-scan needed" signal).
  Partial rejection keeps rating but surfaces rejectedCount loudly.
- ReviewLog gets nullable `reviewRunId` (backward-compat with legacy rows).

**Out of scope (follow-on specs):**
- Full verifier taxonomy (`confirmed`/`likely`/`partially_mitigated`/
  `needs_verification`/`false_positive`) — v1 stays at the current
  `verified`/`downgraded`/`rejected` set.
- Multi-model ensemble reconciliation.
- Webhook-triggered scans (auto-review on PR open).

---

## Phase 1 — Filename Attribution Fix (P0)

The root-cause fix. Every other phase depends on scans producing useful
findings; without this, the history UI just shows garbage.

### Task 1.1: Filter context files out of the diff payload

**File:** `reviewService.ts:363-373`

Currently the diff payload renders every PR file identically. Change it
to partition files into two sections:

1. **Code files** (reviewable) — rendered as today, with full diff +
   line-numbered modified content.
2. **Context files** (docs, specs, READMEs) — rendered in a separate
   `=== CONTEXT FILES (NOT REVIEWABLE — DO NOT CITE IN FINDINGS) ===`
   section, content truncated to 500 lines max, no line numbers.

Reuse `isDocumentationFile` from `src/services/findingVerifier.ts:116-121`
(extension set + path patterns including `^\.agent-os/`, `^docs?/`, etc.).
Export it from the verifier module and import in reviewService.ts.

If ALL files in the PR are docs (e.g. a docs-only PR), log a warning and
let the scan proceed — the LLM should still produce a "no code findings"
rating.

### Task 1.2: Strengthen SYSTEM_INSTRUCTION

**File:** `reviewService.ts:239-285`

Add an explicit filename rule near the existing "Every finding MUST
include: Exact file path and line number" line:

> Findings MUST cite source code files in the diff (the section marked
> `--- FILE: <path> ---`). NEVER cite files from the `=== CONTEXT FILES ===`
> section — those are planning docs / READMEs / specs for context only,
> not bug locations. If a finding describes behavior in a context file,
> re-locate it to the implementation file in the code section.

### Task 1.3: Strengthen JSON finalizer prompt

**File:** `reviewService.ts:578-583`

The current prompt only specifies the JSON shape. Add explicit filename
guidance:

> Each finding MUST include `filename` (a code file path from the diff —
> never a `.md`, `.agent-os/`, `docs/`, or `README` file), `line` (number),
> `severity`, `category`, `explanation`, and `diffSuggestion`. If you
> cannot cite a specific code file, do not include the finding.

### Task 1.4: Stop the silent filename substitution

**File:** `reviewService.ts:680` and `:701`

Currently: `filename: finding.filename || files[0].filename` — silently
attributes findings to the first file when filename is missing.

Change to: `filename: finding.filename || "<unattributed>"`. The verifier
will then reject with note "finding did not specify a filename" rather
than persisting against the wrong file.

Optional belt-and-suspenders: in `normalizeFinalReview` (line 142),
filter out findings with no filename BEFORE they reach the verifier —
saves a round-trip.

### Task 1.5: Verification — Phase 1 end-to-end test

1. Clear findings for `feature/bug-demo` via `scripts/clear-pr-findings.mjs`
   (create if missing — small helper that deletes by prId).
2. Trigger a fresh scan via the API:
   ```bash
   curl -X POST -H "Authorization: Bearer $GREPLOOP_API_KEY" \
     http://localhost:3300/api/prs/real-pr-greploop-...-feature-bug-demo/scan?force=true
   ```
3. Inspect resulting findings via `scripts/inspect-findings.mjs`:
   - **Pass criterion:** ZERO findings cite `.agent-os/specs/*.md` or
     any `.md` file. All citations point to actual source files.
4. If LLM still cites docs, the system prompt/finalizer didn't take —
   re-read and adjust.

---

## Phase 2 — Rating/Findings Honesty (P1)

Make the rating match what the user sees.

### Task 2.1: Null rating when all findings rejected

**File:** `reviewService.ts:684-690` (post-verifier block)

After `verifyFindings` returns:

```ts
const rejectedCount = Array.from(verification.values())
  .filter(v => v.status === "rejected").length;
const totalFindings = candidates.length;

// If every finding was rejected, the LLM's rating was based on
// hallucinated/invalid observations — null it so the UI shows
// "re-scan needed" instead of a misleading score.
if (totalFindings > 0 && rejectedCount === totalFindings) {
  rating = null;
  systemWarn = `LLM produced ${totalFindings} findings but all were rejected by the verifier. Rating nulled — re-scan recommended.`;
}

// Persist the null on the ReviewRun.
await prisma.reviewRun.update({
  where: { id: reviewRunId },
  data: { rating, /* ...existing fields */ },
});
```

### Task 2.2: Surface rejected findings in the API response

**File:** `src/lib/reviewFreshness.ts:287-301` (`getLatestCompletedReview`)

Currently filters rejected findings out of the response. Change to
return both lists:

```ts
const [visibleFindings, rejectedFindings] = await Promise.all([
  prisma.reviewFinding.findMany({
    where: {
      reviewRunId: latestRun.id,
      OR: [
        { verificationStatus: null },
        { verificationStatus: { not: "rejected" } },
      ],
    },
    orderBy: { line: "asc" },
  }),
  prisma.reviewFinding.findMany({
    where: { reviewRunId: latestRun.id, verificationStatus: "rejected" },
    orderBy: { line: "asc" },
    select: { id: true, filename: true, line: true, severity: true,
              category: true, explanation: true, verificationNote: true },
  }),
]);

return {
  reviewRun: latestRun,
  findings: visibleFindings,
  rejectedFindings,  // NEW — full list, not just count
  rejectedCount: rejectedFindings.length,
  stale,
};
```

**File:** `src/app/api/prs/[prId]/findings/route.ts:36-49`

Echo `rejectedFindings` in the response.

### Task 2.3: Show rejected findings inline in ReviewCard

**File:** `src/components/views/prs/ReviewCard.tsx:312-333`

Currently the rejected panel just says "Use ?force=true on the scan
endpoint to bypass the cache." Replace with a rendered list of the
rejected findings:

```tsx
{rejectedFindings.length > 0 && (
  <div className="border-t border-white/5 bg-slate-950/30">
    <button onClick={() => setShowRejected(v => !v)} ...>
      <span>Verifier rejected: {rejectedFindings.length} findings</span>
      <span>{showRejected ? "▲ hide" : "▼ show"}</span>
    </button>
    {showRejected && (
      <div className="divide-y divide-white/5">
        {rejectedFindings.map(f => (
          <div key={f.id} className="px-4 py-2 opacity-60">
            <div className="flex items-center gap-2 text-[10px] font-mono">
              <span className="line-through">{f.filename}:{f.line}</span>
              <span className="text-amber-400">rejected</span>
            </div>
            <div className="text-[10px] text-slate-500 italic mt-0.5">
              {f.verificationNote}
            </div>
            <div className="text-[10px] text-slate-600 mt-1">
              {f.explanation}
            </div>
          </div>
        ))}
      </div>
    )}
  </div>
)}
```

### Task 2.4: Update empty-state copy

**File:** `src/components/views/prs/ReviewCard.tsx:190-202`

When `rating === null && reviewRun` exists, show a distinct empty state:

```
⚠ Rating unreliable — verifier rejected all findings.
Re-scan recommended (the LLM may have been reading stale context).
```

vs current "Review complete: no findings" which implies a clean review.

### Task 2.5: Verification — Phase 2 end-to-end test

1. Trigger a scan that produces rejected findings (reproduce the
   `feature/bug-demo` scenario — or any PR where the LLM hallucinates).
2. UI should show: rating=null (or "n/a"), rejected findings visible in
   the expandable, no misleading 5/10.
3. Trigger a clean scan (a PR with real bugs). UI shows the rating,
   visible findings, and rejected=0.

---

## Phase 3 — Per-Scan Log Isolation + History UI (P2)

The structural redesign. Biggest phase.

### Task 3.1: Schema — add `reviewRunId` to ReviewLog

**File:** `prisma/schema.prisma:51-60`

```prisma
model ReviewLog {
  id            String   @id
  prId          String
  reviewRunId   String?  // NEW — nullable for backward compat with legacy rows
  message       String
  level         String
  createdAt     DateTime @default(now())

  @@index([prId, createdAt])
  @@index([reviewRunId, createdAt])  // NEW
  @@map("review_logs")
}
```

**Migration:** add column as nullable — no backfill needed. Legacy rows
have `null`; new scans populate it. The `/api/reviews/log` route falls
back to `prId` filter when `reviewRunId` is absent (Task 3.4).

Create `prisma/migrations/<timestamp>_review_log_run_id/migration.sql`
with `ALTER TABLE review_logs ADD COLUMN "reviewRunId" TEXT;` + index
creation. Run `npx prisma db push` in dev (or migration in prod).

### Task 3.2: Pass `reviewRunId` through the scan + log path

**File:** `reviewService.ts` — find the log helper (search for
`prisma.reviewLog.create` or similar, likely named `logReviewEvent`).

Update the helper signature to accept `reviewRunId?: string` and persist
it. All call sites within `runPrScan` pass the current `reviewRunId`
(parameter already threaded through from Task 6 of the freshness-guard
spec — verify it's in scope at every log call).

For non-scan log paths (e.g. ad-hoc logs from API routes), pass `null`
or omit — backward compat.

### Task 3.3: Update scan route + helper to thread reviewRunId into logs

**File:** `src/app/api/prs/[prId]/scan/route.ts` and any sibling scan
trigger paths (`/api/hooks/prepush`, `/api/prcheck/[prIdOrNumber]`,
`/api/command/[[...args]]`).

Each scan-creating path already creates a `ReviewRun` (per the
freshness-guard spec). Pass that run's ID into `runPrScan`, which
threads it into every `logReviewEvent` call.

### Task 3.4: Update `/api/reviews/log` to filter by reviewRunId

**File:** `src/app/api/reviews/log/route.ts:6-22`

```ts
const prId = searchParams.get("prId");
const reviewRunId = searchParams.get("reviewRunId");

if (!prId && !reviewRunId) {
  return NextResponse.json(
    { error: "Missing prId or reviewRunId query parameter" },
    { status: 400 }
  );
}

const where = reviewRunId
  ? { reviewRunId }
  : { prId };  // legacy fallback — returns all logs for PR across runs

const logs = await prisma.reviewLog.findMany({
  where,
  orderBy: { createdAt: "asc" },
  take: 200,
  select: { id: true, message: true, level: true, createdAt: true },
});
```

### Task 3.5: New endpoint — list ReviewRuns for a PR

**New file:** `src/app/api/prs/[prId]/runs/route.ts`

```ts
export async function GET(_req, { params }) {
  const { prId } = await params;
  const runs = await prisma.reviewRun.findMany({
    where: { prId },
    orderBy: { startedAt: "desc" },
    take: 20,
    select: {
      id: true, status: true, startedAt: true, completedAt: true,
      rating: true, model: true, triggerReason: true, commitHash: true,
    },
  });
  return NextResponse.json({ runs });
}
```

### Task 3.6: Refactor ReviewProgress to poll by reviewRunId

**File:** `src/components/views/prs/ReviewProgress.tsx`

Currently polls `/api/reviews/log?prId=X`. Change to accept `reviewRunId`
prop (passed from parent) and poll `/api/reviews/log?reviewRunId=X`.

Behavior change: the component should render whenever there is a current
`reviewRunId` (in_progress OR completed within the last 60s), not just
when `isScanning === true`. This makes API-triggered scans visible in
the UI without requiring `isScanning` to be set.

The parent (`PrsView.tsx`) passes the current `reviewRun?.id` from
`useDashboardData` state.

### Task 3.7: New component — ScanHistory

**New file:** `src/components/views/prs/ScanHistory.tsx` (~150 lines)

Fetches `/api/prs/[prId]/runs` on mount + whenever `prId` changes.
Renders a list:

```
▼ Scan History (5)
  ▶ 2026-06-25 11:14 · M3 · rating 5/10 · manual      [show logs]
  ▶ 2026-06-24 18:02 · M3 · rating null · prepush     [show logs]
  ▶ 2026-06-24 14:33 · qwen-plus · rating 8/10 · manual [show logs]
  ...
```

Each row expandable to show that run's logs (via the same
`/api/reviews/log?reviewRunId=X` endpoint).

Highlight the row matching `reviewRun?.id` (current run) with a chip
"current".

### Task 3.8: Refactor PrsView layout — 4 clear sections

**File:** `src/components/views/PrsView.tsx`

Restructure the right pane to have explicit sections, top to bottom:

1. **Scan Status** — single badge (idle / scanning / complete / failed /
   unreliable). Visible at all times. Replace the scattered status hints
   (header badge + button label) with one source of truth.
2. **Scan Logs** — `ReviewProgress` component (live iteration events for
   current run). Stays even when scan completes (shows last run's log).
3. **Scan Results** — `ReviewCard` with findings (visible + rejected).
4. **Scan History** — `ScanHistory` component (past runs).

The current PR's `reviewRun` (from `useDashboardData.reviewRun` state)
drives sections 1-3. The history list drives section 4.

### Task 3.9: Verification — Phase 3 end-to-end test

1. Run scan #1 on a PR. Confirm logs stream into section 2 with correct
   iteration events.
2. Wait for completion. Confirm results show in section 3.
3. Trigger scan #2 on the SAME PR. Confirm:
   - Section 2 resets to scan #2's log stream (no blending with scan #1).
   - Scan #1 moves to section 4 (history), expandable.
4. Switch to a DIFFERENT PR. Confirm:
   - All four sections show data for the newly-selected PR only.
   - No leak between PRs.

---

## Phase 4 — Concurrency Guard + UI Status Sync (P3)

Operational hygiene.

### Task 4.1: Scan concurrency guard

**File:** `src/app/api/prs/[prId]/scan/route.ts` — top of handler, before
the freshness short-circuit.

```ts
const inProgress = await prisma.reviewRun.findFirst({
  where: { prId, status: "in_progress" },
  orderBy: { startedAt: "desc" },
});

if (inProgress && !force) {
  return NextResponse.json({
    error: "SCAN_IN_PROGRESS",
    runId: inProgress.id,
    startedAt: inProgress.startedAt,
    message: `Scan already running (started ${formatRelative(inProgress.startedAt)}). Use ?force=true to override.`,
  }, { status: 409 });
}
```

Applies to all four scan trigger paths (`/api/prs/[prId]/scan`,
`/api/hooks/prepush`, `/api/prcheck/[prIdOrNumber]`, `/api/command`).
Extract a small helper `assertNoActiveScan(prId, force)` in
`src/lib/reviewFreshness.ts` and call from each.

`force=true` overrides (for re-scans after stuck runs).

### Task 4.2: UI status reflects API-triggered scans

**File:** `src/hooks/useDashboardData.ts`

Currently `isScanning` only flips true on UI button click. Add a poll
that checks PR status:

```ts
// Inside the existing 15s background poller:
// If the selected PR has status === "In Progress", treat as scanning
// regardless of which trigger source started it.
useEffect(() => {
  if (!selectedPrId) return;
  const activePR = prs.find(p => p.id === selectedPrId);
  if (activePR?.status === "In Progress" && !isScanning) {
    setIsScanning(true);
  } else if (activePR?.status !== "In Progress" && isScanning) {
    setIsScanning(false);
  }
}, [selectedPrId, prs, isScanning]);
```

This makes ReviewProgress render for any active scan, not just UI-clicked
ones. (Note: this overlaps with task #33 — close it when this ships.)

### Task 4.3: Verify no regression on the sidebar fix

**File:** `src/hooks/useDashboardData.ts`

Already-shipped fix at line 108-126 reads `repoIdRef.current` instead
of the stale closure. Confirm the new status-polling logic doesn't
reintroduce a stale-closure bug — use refs for any state read inside
poller callbacks.

### Task 4.4: Verification — Phase 4 end-to-end test

1. Start a scan via API (curl). Without the UI button path. Confirm:
   - Sidebar shows "In Progress" for the PR.
   - ReviewProgress renders with iteration logs.
   - ReviewCard shows the run's findings on completion.
2. While that scan runs, start a second scan on the same PR via UI button.
   Confirm: 409 SCAN_IN_PROGRESS returned; second scan rejected.
3. Trigger scan via `/gloop` skill while UI scan runs. Confirm same 409.

---

## Critical files referenced

- `reviewService.ts:239-285` — SYSTEM_INSTRUCTION
- `reviewService.ts:363-373` — diffPayload construction
- `reviewService.ts:578-583` — JSON finalizer prompt
- `reviewService.ts:680, 701` — silent `files[0].filename` substitution
- `reviewService.ts:684-690` — post-verifier block (rating null logic)
- `src/services/findingVerifier.ts:116-121` — `isDocumentationFile`
- `src/lib/reviewFreshness.ts:253-309` — `getLatestCompletedReview`
- `src/app/api/prs/[prId]/findings/route.ts` — findings response shape
- `src/app/api/reviews/log/route.ts:6-22` — log filter (needs runId support)
- `src/components/views/prs/ReviewProgress.tsx` — live log component
- `src/components/views/prs/ReviewCard.tsx:312-333` — rejected findings panel
- `src/components/views/PrsView.tsx` — main PR view layout
- `src/hooks/useDashboardData.ts` — dashboard state + polling
- `prisma/schema.prisma:51-60` — ReviewLog model (adding reviewRunId)

## Reusable utilities

- `isDocumentationFile` from `src/services/findingVerifier.ts:116-121` —
  reuse for diff payload filtering (Task 1.1).
- `repoIdRef` / `prIdRef` pattern in `useDashboardData.ts:271-274` —
  pattern for any new state read inside pollers (Task 4.2).
- `assertReviewFreshness` discriminated-union pattern in
  `src/lib/reviewFreshness.ts` — mirror for `assertNoActiveScan` (Task 4.1).

## Sequencing

Ship in order — each phase is independently testable:

1. **Phase 1** (P0, ~half day) — unblocks everything. Verify before proceeding.
2. **Phase 2** (P1, ~2 hours) — UX honesty for verifier rejections.
3. **Phase 3** (P2, ~1 day) — the structural redesign.
4. **Phase 4** (P3, ~half day) — operational guards.

After each phase, run the phase-specific verification before moving on.
Final spec documentation goes into `.agent-os/specs/2026-06-25-1130-scan-quality-and-history-redesign/`
matching the convention of `.agent-os/specs/2026-06-24-1746-review-freshness-guard/`.
