# Deploying to Render

The `render.yaml` blueprint provisions everything: web service, persistent disk, env vars. You just need to fill in the secrets.

## Prereqs

Before you deploy, have these ready:

- **Anthropic API key** — https://console.anthropic.com/
- **Twilio account SID + auth token** — https://console.twilio.com/
- **Google OAuth credentials** (Client ID + Secret) — https://console.cloud.google.com/apis/credentials (Web application type)
- **Your WhatsApp number** (with country code, prefixed `whatsapp:`)
- Code pushed to a GitHub repo

## Deploy

1. **Render dashboard** → **New +** → **Blueprint**
2. Connect the GitHub repo → Render reads `render.yaml`
3. Fill in the prompted secrets:
   - `ANTHROPIC_API_KEY`
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
   - `YOUR_WHATSAPP_NUMBER` (e.g. `whatsapp:+16175551234`)
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REDIRECT_URI` → leave blank for now, you'll set it in step 4
4. Deploy. Render gives you a URL like `https://whatsapp-assistant-abc1.onrender.com`
5. Go back to the service's **Environment** tab and set:
   ```
   GOOGLE_REDIRECT_URI = https://whatsapp-assistant-abc1.onrender.com/oauth/callback
   ```
   Save — the service redeploys automatically.

## Wire up external services

**Google Cloud** — in the OAuth Client settings, add your Render callback URL to **Authorized redirect URIs**:
```
https://whatsapp-assistant-abc1.onrender.com/oauth/callback
```

**Twilio** — in the WhatsApp Sandbox settings (**Messaging → Try it out → Send a WhatsApp message → Sandbox settings**), set:
```
When a message comes in:  https://whatsapp-assistant-abc1.onrender.com/whatsapp
Method:                   POST
```

## Authorize Google (one-time)

Visit `https://whatsapp-assistant-abc1.onrender.com/oauth/start` in a browser, sign in with the Google account whose calendar you want to use. Tokens are saved to the persistent disk.

## Test

Text your Twilio WhatsApp sandbox number "what's on today?" — you should get a reply within a few seconds.

The morning brief will fire at whatever `MORNING_BRIEF_CRON` says (default: 8am weekdays in your `TIMEZONE`).

## Updating

Push to `main` → Render auto-deploys. The persistent disk keeps your tasks and Google tokens across deploys.

To change non-secret config (timezone, cron schedule, etc.), edit `render.yaml` and push — Render applies it on next sync.

To change a secret, edit it in the **Environment** tab in the dashboard (Render ignores `sync: false` vars on re-sync).

## Monitoring

- **Logs**: service page → **Logs** tab (tail live)
- **Metrics**: **Metrics** tab shows CPU, memory, request count
- The health check path `/` also shows whether Google is currently authorized

## When you get a real WhatsApp Business number

Once Meta approves your business number through Twilio:
1. Update `TWILIO_WHATSAPP_NUMBER` in Render's Environment tab
2. Point the number's webhook (in Twilio phone number config) to `/whatsapp`
3. Sandbox rejoin every 72 hours is no longer needed
