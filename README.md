# Binance Funding Monitor

This service ranks Binance USDⓈ-M USDT perpetual contracts by settled Funding
over the previous 24 hours, then posts one Google Chat message containing two
mobile-readable Top10 cards. It runs in the `Asia/Shanghai` timezone.

## Prerequisites

- Node.js **24 LTS** (the service does not support Node.js 20 or earlier).
- PM2 installed for the operating-system user that will run the monitor, for
  example `npm install --global pm2` under that user.
- A Google Chat incoming Webhook for the destination space. Treat its URL as a
  secret: do not commit it, put it in `.env.example`, paste it into commands
  stored in shell history, or copy it into logs.

Install and verify the project from its checkout:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

## Server setup and secrets

Create the durable state directory as the same user that runs PM2. Replace
`bnfunding` with that account if needed:

```bash
sudo install -d -m 0750 -o bnfunding -g bnfunding /var/lib/bn-funding
```

The process needs these three environment values:

```dotenv
GOOGLE_CHAT_WEBHOOK_URL=
STATE_FILE=/var/lib/bn-funding/state.json
TZ=Asia/Shanghai
```

Supply `GOOGLE_CHAT_WEBHOOK_URL` through the server's secret manager or the
PM2 user's protected environment, never through a tracked file. For an
interactive first setup, enter it without echoing it to the terminal and start
PM2 from the same shell:

```bash
read -rs 'GOOGLE_CHAT_WEBHOOK_URL?Google Chat Webhook: '; echo
export GOOGLE_CHAT_WEBHOOK_URL
export STATE_FILE=/var/lib/bn-funding/state.json
export TZ=Asia/Shanghai
pm2 start ecosystem.config.cjs --update-env
```

PM2 must be started as the account that owns `/var/lib/bn-funding`; the
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
Beijing time. On restart, the daemon catches up only the most recent missed
slot and only when it is within 30 minutes and has not already completed.

Before connecting Chat, verify the live public Binance data path after a
build:

```bash
npm run dry-run
```

It prints the ranked Top20 and neither calls Google Chat nor reads or writes
the state file. A normal one-off send and an explicitly forced one-off send
are:

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

Confirm exactly one Google Chat message arrives with two Top10 cards. On both
desktop and mobile, verify all 20 assets are visible, each row shows current,
24-hour, and 7-day Funding with APRs, Funding periods are visible, and the
card footnotes are present. Remove the test Webhook from the secret manager or
the PM2/server environment after validation; it must not remain in shell
history or a tracked file.

## Recovery

### Binance failure

Check `pm2 logs bn-funding` for validation, timeout, retry, or pagination
errors and confirm public Binance connectivity. A failed run does not mark
the slot successful. Once Binance recovers, allow the next scheduled run, use
the 30-minute restart catch-up window when applicable, or run `npm run
push:once` manually. Do not use `--force` unless you deliberately accept a
duplicate.

### Google Chat timeout or non-2xx response

Chat timeouts are intentionally not retried because delivery status is
ambiguous; the state file is not updated unless Chat returned 2xx. Inspect the
Chat space before retrying. If no message arrived, run `npm run push:once` to
send it. If the result is uncertain, only run `npm run push:once -- --force`
when a possible duplicate is acceptable. Recheck the Webhook's validity and
the PM2 environment for non-2xx responses, without printing the secret URL.

### Corrupt state file

Stop the daemon, preserve the bad file for diagnosis, then restart after
moving it aside. This resets duplicate detection, so inspect the Chat space
first and expect a possible resend for the active slot:

```bash
pm2 stop bn-funding
mv /var/lib/bn-funding/state.json /var/lib/bn-funding/state.json.corrupt-$(date +%Y%m%d%H%M%S)
pm2 start ecosystem.config.cjs --update-env
pm2 save
```

The next successful Chat delivery atomically creates a new state file.

### Manual resend

For an ordinary resend after a confirmed missed delivery, use `npm run
push:once`. Use `npm run push:once -- --force` only to deliberately resend an
already successful slot; it can intentionally duplicate the Chat message.
