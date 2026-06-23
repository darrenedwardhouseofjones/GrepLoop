# Standards — GitHub PR Number Resolution

`agent-os/standards/index.yml` is currently empty, so no standards formally apply. Listed below are the standards this spec *would* touch once the index is populated. Future standards work should reference this list for traceability.

## Standards this work would touch

### `database/migrations` (not yet defined)

The schema change is a single nullable column addition (`githubPrNumber Int?`) — additive, non-breaking. Pattern to follow once the standard exists:

- Dev: `npx prisma db push` (acceptable for additive changes)
- Production: migration file under `prisma/migrations/` with `ALTER TABLE pull_requests ADD COLUMN "githubPrNumber" INTEGER;`
- Existing rows get `null` — no backfill needed because next scan repopulates.

### `api/response-format` (not yet defined)

The `prlist` response gains a new `githubPrNumber` field per PR object. Existing fields unchanged. Format stays JSON. The change is purely additive — old clients keep working.

### `api/error-handling` (not yet defined)

The `gh pr list` call is wrapped in try/catch and silently returns an empty `Map` on any failure (no remote, no `gh`, unauthed, rate-limited). This matches the existing pattern in `getRealLocalPrs.ts:114-161` where per-branch failures are caught and logged so a single failure doesn't abort the whole scan.

### `security/secrets-at-rest` (not yet defined)

No new secrets stored. `gh` reads its own auth from `~/.config/gh/hosts.yml` — we don't touch or persist that. No `GREPLOOP_MASTER_KEY` interaction.

## Notes for future standards authors

- The "fail-open on external tool error" pattern (`gh` missing → empty map → ordinal fallback) is worth standardizing across the codebase. The same pattern shows up in `src/lib/getRealLocalPrs.ts` for git operations and would apply to any future external-tool integration.
- The "additive schema migration only" rule for dev-period projects (no destructive changes without a paired data migration) should be formalized.
