# Deploying to Render

The `render.yaml` blueprint provisions everything: web service, persistent disk, env vars. You just need to fill in the secrets.

## Prereqs

Before you deploy, have these ready:

- **Anthropic API key** — https://console.anthropic.com/
- **Telegram bot token** — talk to [@BotFather](https://t.me/BotFather) on Telegram: `/newbot`, follow prompts, copy the token
- **Your Telegram user ID** — talk to [@userinfobot](https://t.me/userinfobot), it replies with your numeric ID (you can also grab it from the server log on the first message you send to your bot)
- **Google OAuth credentials** (Client ID + Secret) — https://console.cloud.google.com/apis/credentials (Web application type)
- Code pushed to a GitHub repo (already done: `Angelie85/pa-agent`)

## Deploy

1. **Render dashboard** → **New +** → **Blueprint**
2. Connect the GitHub repo → Render reads `render.yaml`
3. Fill in the prompted secrets:
   - `ANTHROPIC_API_KEY`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_AUTHORIZED_USER_IDS` — comma-separated Telegram user IDs
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REDIRECT_URI` — leave blank for now, you'll set it in step 5
4. Click **Apply**. Render gives you a URL like `https://telegram-assistant-abc1.onrender.com`
5. Go back to the service's **Environment** tab and set:
   ```
   GOOGLE_REDIRECT_URI = https://telegram-assistant-abc1.onrender.com/oauth/callback
   ```
   Save — the service redeploys automatically.

## Wire up Google

In the Google Cloud OAuth Client settings, add your Render callback URL to **Authorized redirect URIs**:
```
https://telegram-assistant-abc1.onrender.com/oauth/callback
```

## Authorize Google (one-time)

Visit `https://telegram-assistant-abc1.onrender.com/oauth/start` in a browser, sign in with the Google account whose Calendar and Gmail you want the assistant to use. Tokens are saved to the persistent disk at `/var/data` and survive restarts and redeploys.

## Test

Open Telegram, find your bot by the username you set with BotFather, and send it a message like "what's on today?" — you should get a reply within a few seconds.

The morning brief will fire on `MORNING_BRIEF_CRON` (default: `0 8 * * 1-5` — 8am weekdays in your `TIMEZONE`) and get DM'd to the first user in `TELEGRAM_AUTHORIZED_USER_IDS`.

## Telegram: long-polling vs webhook

The bot uses **long polling** (`node-telegram-bot-api` with `{ polling: true }`), so it does not need a public webhook. Render's public URL is only used for the OAuth callback and the health check.

Because polling holds an open connection to Telegram's servers, only one instance of the bot can run at a time. If you re-deploy or run it locally while Render is also running, you'll see `409 Conflict` errors in the logs — that's Telegram rejecting the second poller. Stop one of them.

## Updating

Push to `main` → Render auto-deploys. The persistent disk keeps your tasks and Google tokens across deploys.

To change non-secret config (timezone, cron schedule, etc.), edit `render.yaml` and push — Render applies it on the next sync.

To change a secret, edit it in the **Environment** tab in the dashboard (Render ignores `sync: false` vars on re-sync).

## Monitoring

- **Logs**: service page → **Logs** tab (tail live)
- **Metrics**: **Metrics** tab shows CPU, memory, request count
- The health check path `/` also shows whether Google is currently authorized

## Cold starts

On the `starter` plan the service is always-on, so no cold starts. If you downgrade to `free`, the service sleeps after 15 min of inactivity — long polling will keep it awake as long as it's running, but on cold boot the first message may take ~30s.
