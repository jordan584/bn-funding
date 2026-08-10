# Five-Venue Funding Monitor

This service ranks assets by the equal-weight average of estimated next-Funding
APR across Binance, OKX, Hyperliquid, Bybit, and Bitget. An asset must be listed
on at least two of those approved venues to qualify. Each run generates two
mobile-readable Top10 PNG tables, publishes them to this repository's public
image branch, and posts both images in one Google Chat message. The service runs
in the `Asia/Shanghai` timezone.

## Prerequisites

- Node.js **24 LTS** (the service does not support Node.js 20 or earlier).
- No venue API key is needed; all five market-data integrations use public
  endpoints.
- PM2 installed for the operating-system user that will run the monitor, for
  example `npm install --global pm2` under that user.
- A Google Chat incoming Webhook for the destination space. Treat its URL as a
  secret: do not commit it, put it in `.env.example`, paste it into commands
  stored in shell history, or copy it into logs.
- A fine-grained GitHub Token scoped to this repository with `Contents: Read and
  write` and `Metadata: Read-only`. Treat it as a secret.
- This repository must be public so Google Chat can fetch the generated
  `raw.githubusercontent.com` image URLs without authentication.

Install and verify the project from its checkout:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

## Server setup and secrets

Create `~/bn-funding/.env` with these values:

```dotenv
GOOGLE_CHAT_WEBHOOK_URL='https://chat.googleapis.com/...'
GITHUB_TOKEN='github_pat_...'
GITHUB_REPOSITORY='jordan584/bn-funding'
GITHUB_IMAGE_BRANCH='funding-images'
```

Protect it with `chmod 600 .env`. The daemon and one-off CLI load this file
automatically; values already exported by PM2 or the shell take precedence.

The service stores duplicate-prevention state in `./state.json` by default and
creates it, its lock directory, and any temporary files automatically. These
runtime files are ignored by Git. `TZ=Asia/Shanghai` is already set by the PM2
ecosystem file and is also the application default.

`STATE_FILE` remains an optional advanced override. When supplied in daemon or
send mode, it must be an absolute path.

PM2 must be started as an account that can write to the project directory; the
included ecosystem file runs exactly one `bn-funding` fork instance.

## Operations

Build before starting or after each release, then use PM2 to make the daemon
persistent and inspect it:

```bash
npm run build
pm2 start ecosystem.config.cjs
pm2 save
pm2 status
pm2 logs bn-funding
```

`pm2 status` should show exactly one `bn-funding` process in `fork` mode. The
scheduled run is `5 0,8,16 * * *` in Asia/Shanghai: 00:05, 08:05, and 16:05
Beijing time. On startup, the daemon immediately publishes the most recent slot
if it has not already completed; ordinary restarts after success do not resend.

Before connecting Chat, verify all five live public-data paths after a build:

```bash
npm run dry-run
```

The structured completion log should report market/current/request/page/retry
counts and current-stage duration for each of `binance`, `okx`,
`hyperliquid`, `bybit`, and `bitget`. It also reports normalization and alias
counts, candidate coverage counts, sanitized Top20 APR/missing-reason data,
selected-history records/coverage/duration, payload bytes, push result, and
slot state. The output must contain exactly 20 ranked assets with five venue
positions per asset (100 positions in total), and every asset must have values
from at least two venues. Dry-run neither calls Google Chat nor reads or writes
the state file. A normal one-off send and an explicitly forced one-off send are:

```bash
npm run push:once
npm run push:once -- --force
```

`--force` intentionally bypasses duplicate-slot prevention and can create a
duplicate message. Use it only when that duplicate is explicitly desired.

## First message validation

On the deployment server, use a disposable test-space Webhook in a temporary
shell environment, then run:

```bash
npm run push:once -- --force
unset GOOGLE_CHAT_WEBHOOK_URL
```

Confirm exactly one Google Chat message arrives with two Top10 images. The rank
must be the equal-weight average of estimated next-Funding APR across the five
approved venues, using only assets covered by at least two venues. On both
desktop and mobile, verify all 20 assets are visible and every asset shows all
five venue positions. A listed position shows estimated next Funding, its
period and APR, plus the realized seven-day daily average and APR. The exact
missing-data forms are distinct:

- `下次 --｜7日均 --` means the asset is absent from that venue in the complete
  current snapshot.
- A valid `下次` value beside `7日均 --*` means the market is present but is too
  new to have one complete settled Funding interval.
- A numeric `7日均` ending in `*` means usable settled history exists but covers
  less than seven days.

Confirm the image footnotes explain that next Funding is the current estimate
with APR in parentheses and that `*` marks history shorter than seven days.
Remove the test Webhook from the secret manager or the PM2/server environment
after validation; it must not remain in shell history or a tracked file.

## Recovery

### Venue public-data failure

Check `pm2 logs bn-funding` for validation, timeout, retry, or pagination
errors. A complete current snapshot is required from each of Binance, OKX,
Hyperliquid, Bybit, and Bitget; failure of any one venue suppresses the entire
run, so the service never sends a partial-weight message. Confirm connectivity
to the public API named in the error and wait for that venue to recover. The
failed run does not mark the slot successful. After recovery, allow the next
scheduled run, use the 30-minute restart catch-up window when applicable, or
run `npm run push:once` manually. Restarting also attempts the latest unsent
slot immediately. Do not force a partial run; `--force` bypasses
only duplicate-slot prevention and should be used only when you deliberately
accept a duplicate message.

### Google Chat timeout or non-2xx response

Chat timeouts are intentionally not retried because delivery status is
ambiguous; the state file is not updated unless Chat returned 2xx. Inspect the
Chat space before retrying. If no message arrived, run `npm run push:once` to
send it. If the result is uncertain, only run `npm run push:once -- --force`
when a possible duplicate is acceptable. Recheck the Webhook's validity and
the PM2 environment for non-2xx responses, without printing the secret URL.

### GitHub image upload failure

Confirm the repository is public and the Token still has `Contents: Read and
write` access to `jordan584/bn-funding`. Check that `GITHUB_REPOSITORY` and
`GITHUB_IMAGE_BRANCH` match the deployment. The first successful upload creates
the `funding-images` branch; later runs write PNG paths under
`reports/YYYY/MM/DD/`. Upload failures do not call Chat and do not mark the slot
successful, so retry with `npm run push:once` after correcting access.

### Corrupt state file

Stop the daemon, preserve the bad file for diagnosis, then restart after
moving it aside. This resets duplicate detection, so inspect the Chat space
first and expect a possible resend for the active slot:

```bash
pm2 stop bn-funding
mv state.json state.json.corrupt-$(date +%Y%m%d%H%M%S)
pm2 start ecosystem.config.cjs --update-env
pm2 save
```

The next successful Chat delivery atomically creates a new state file.

### Manual resend

For an ordinary resend after a confirmed missed delivery, use `npm run
push:once`. Use `npm run push:once -- --force` only to deliberately resend an
already successful slot; it can intentionally duplicate the Chat message.
