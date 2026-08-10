# GitHub-hosted Funding Images Design

## Goal

Replace the dense Google Chat Funding cards with two mobile-readable PNG tables
for ranks 1–10 and 11–20. The existing five-venue ranking and seven-day history
calculation remain unchanged.

## Delivery architecture

For send and daemon runs, Node renders two deterministic SVG tables and converts
them to PNG with `sharp`. The service uploads both PNG files through the GitHub
Contents API to the public `funding-images` branch of `jordan584/bn-funding`, then
sends one Google Chat message containing two image widgets whose URLs point to
`raw.githubusercontent.com`.

Each run writes unique, immutable paths under `reports/YYYY/MM/DD/` using the
scheduled slot plus the rank range. Existing Chat messages therefore continue to
resolve even after later reports are published. The first upload creates the
orphan image branch automatically; later uploads update files without checking
out or modifying the application's working tree.

## Image layout

Each PNG is 1440 pixels wide with a dark trading-dashboard theme. It contains a
title, Beijing timestamp, ranking explanation, and ten asset sections. Each asset
shows rank, symbol, composite next-Funding APR and coverage, followed by a compact
five-row venue table with columns for venue, next Funding/interval, next APR,
seven-day daily average, and seven-day APR. Positive values are red, negative
values green, missing values gray, and partial seven-day histories carry `*`.

## Configuration and startup

Send and daemon modes require `GOOGLE_CHAT_WEBHOOK_URL`, `GITHUB_TOKEN`,
`GITHUB_REPOSITORY`, and `GITHUB_IMAGE_BRANCH`. The repository defaults to
`jordan584/bn-funding` and the branch defaults to `funding-images`; the token has
no default. The process loads `.env` from the current project directory before
reading configuration, without overwriting environment variables already set by
PM2 or the shell.

Daemon startup immediately invokes the most recent slot if that slot has not
already succeeded, regardless of the old 30-minute catch-up window. Duplicate
prevention still applies, so ordinary restarts after a successful run do not
resend. Scheduled pushes remain at 00:05, 08:05, and 16:05 Asia/Shanghai.

## Failure behavior

Rendering or either GitHub upload failure aborts the run before Chat delivery.
Google Chat failure aborts before state commit. A slot is marked successful only
after both public image URLs exist and Chat returns 2xx. Logs never include the
GitHub token or Google Chat Webhook.

Dry-run continues to fetch and format the leaderboard without uploading images,
calling Chat, or touching state.

## Verification

Automated tests cover SVG escaping and content, PNG signatures, GitHub branch
creation and uploads, authenticated error redaction, Chat image payloads,
configuration validation, immediate startup behavior, delivery ordering, and
state commit rules. The release gate is typecheck, full tests, build, and a local
render inspection using fixture data.
