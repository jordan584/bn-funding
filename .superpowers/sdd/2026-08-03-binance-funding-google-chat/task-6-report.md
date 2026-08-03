# Task 6 report — funding job, application assembly, and CLI

## Status

Implemented and verified.

## Delivered

- `runFundingJob` performs state duplicate protection, Binance-server-time anchored concurrent data collection, Top20/card validation, dry-run rendering, single Chat delivery, and post-2xx atomic state marking.
- `createApp` assembles the Binance client, optional Google Chat client, state store, clock, and safe structured logger from `AppConfig`.
- CLI requires one delivery mode, allows `--force` only with `--send`, derives the manual slot from `mostRecentElapsedSlot(Date.now())`, emits safe structured failures, and exposes source-mode scripts.
- Tests cover skip, dry-run, successful ordering, force, Binance/data/payload/Chat failures, logs, app assembly, and CLI validation/exit behavior.

## Verification

- `node --import tsx --test test/job.test.ts` — 14 passing
- `npm test` — 65 passing
- `npm run typecheck` — passing
- `npm run build` — passing

## Concerns

None. CLI success paths intentionally use the concrete client assembly; tests keep external I/O at client boundaries and only exercise invalid CLI input in a subprocess.
